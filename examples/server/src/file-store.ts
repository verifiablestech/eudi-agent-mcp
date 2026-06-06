import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Store } from '@verifiables/eudi-mcp-core'

interface Entry {
  value: string
  /** Epoch ms; absent = no expiry. */
  expiresAt?: number
}

/**
 * A JSON-file-backed `Store` so OAuth state (client registration + access/refresh tokens) survives
 * server restarts — MCP clients stay connected instead of having to re-authorize. Single-instance only;
 * for multiple instances use a shared store (Redis, etc.). The file holds bearer tokens, so keep it
 * out of git (it's gitignored).
 */
export class FileStore implements Store {
  #path: string
  #data = new Map<string, Entry>()

  constructor(path: string) {
    this.#path = path
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Entry>
        const now = Date.now()
        for (const [k, v] of Object.entries(raw)) {
          if (!v.expiresAt || v.expiresAt > now) this.#data.set(k, v)
        }
      } catch {
        // corrupt/empty file — start fresh
      }
    }
  }

  #persist(): void {
    const now = Date.now()
    const obj: Record<string, Entry> = {}
    for (const [k, v] of this.#data) {
      if (!v.expiresAt || v.expiresAt > now) obj[k] = v
    }
    const dir = dirname(this.#path)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    // atomic-ish write: temp file then rename
    const tmp = `${this.#path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(obj))
    renameSync(tmp, this.#path)
  }

  async get(key: string): Promise<string | null> {
    const e = this.#data.get(key)
    if (!e) return null
    if (e.expiresAt && e.expiresAt <= Date.now()) {
      this.#data.delete(key)
      return null
    }
    return e.value
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.#data.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    })
    this.#persist()
  }

  async del(key: string): Promise<void> {
    if (this.#data.delete(key)) this.#persist()
  }
}
