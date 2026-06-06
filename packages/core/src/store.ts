import type { Store } from './types.js'

/**
 * Simple in-memory Store with TTL. Fine for a single-process demo/server.
 * For production / multi-instance, provide a Redis-backed Store with the same
 * interface.
 */
export class MemoryStore implements Store {
  #data = new Map<string, { value: string; expiresAt: number | null }>()

  async get(key: string): Promise<string | null> {
    const entry = this.#data.get(key)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.#data.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.#data.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    })
  }

  async del(key: string): Promise<void> {
    this.#data.delete(key)
  }
}
