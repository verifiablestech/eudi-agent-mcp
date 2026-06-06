import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'

// Bundle the iframe widget (App runtime + our code) into one self-contained IIFE,
// then inline it into a single HTML document. The default MCP Apps sandbox CSP
// blocks external scripts, so everything must be inlined.
const result = await build({
  entryPoints: ['src/widget.ts'],
  bundle: true,
  format: 'iife',
  minify: true,
  platform: 'browser',
  target: 'es2020',
  write: false,
})
const iife = result.outputFiles[0].text

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    display: flex; justify-content: center; padding: 16px; }
  .card { width: 100%; max-width: 320px; text-align: center; border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
  .title { font-size: 1.05rem; font-weight: 600; }
  .sub { font-size: .9rem; opacity: .7; }
  .qr { background: #fff; border-radius: 12px; padding: 10px; line-height: 0; }
  .qr svg { width: 220px; height: 220px; display: block; }
  .hint { font-size: .85rem; opacity: .6; }
  .url { font-size: .72rem; opacity: .55; word-break: break-all; }
  #root { width: 100%; display: flex; justify-content: center; }
</style></head>
<body><div id="root">Preparing verification…</div>
<script>${iife}</script>
</body></html>`

mkdirSync('dist', { recursive: true })
writeFileSync('dist/index.js', `export const WIDGET_HTML = ${JSON.stringify(html)}\n`)
writeFileSync('dist/index.d.ts', `export declare const WIDGET_HTML: string\n`)
console.error(`apps-widget: built dist/index.js (${(html.length / 1024).toFixed(0)} KB inlined)`)
