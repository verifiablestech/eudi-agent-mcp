import { App } from '@modelcontextprotocol/ext-apps'

/**
 * Iframe-side widget for the MCP Apps QR card. Receives the QR (server-rendered
 * SVG) and links via `structuredContent` on the tool result, per the MCP Apps
 * spec (SEP-1865). `ontoolresult` MUST be set before `connect()` — the result is
 * a one-shot event right after the handshake.
 */

interface QrData {
  qrSvg?: string
  pageUrl?: string
  requestUri?: string
  purpose?: string
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function render(data?: QrData, fallback?: string): void {
  const el = document.getElementById('root')
  if (!el) return
  if (!data?.qrSvg) {
    el.textContent = fallback || 'Preparing verification…'
    return
  }
  el.innerHTML = `
    <div class="card">
      <div class="title">Verify with your wallet</div>
      ${data.purpose ? `<div class="sub">${escapeHtml(data.purpose)}</div>` : ''}
      <div class="qr">${data.qrSvg}</div>
      <div class="hint">Scan with your EUDI wallet</div>
      ${data.pageUrl ? `<div class="url">${escapeHtml(data.pageUrl)}</div>` : ''}
    </div>`
}

const app = new App({ name: 'eudi-agent-qr', version: '0.1.0' })

// Set the one-shot result handler BEFORE connecting (host fires it post-handshake).
app.ontoolresult = (params: { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }) => {
  const text = params.content?.find((c) => c.type === 'text')?.text
  render(params.structuredContent as QrData, text)
}

void app.connect()
