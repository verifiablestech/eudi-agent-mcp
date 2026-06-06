import { renderSVG } from 'uqr'

/** Minimal, neutral, dependency-free step-up page. Replace with your own UI. */
export function renderStepUpPage(
  id: string,
  data: { status: string; uri?: string; purpose?: string }
): string {
  const purpose = (data.purpose ?? 'Present your credential to continue.')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const qr = data.uri ? renderSVG(data.uri, { border: 1 }) : ''
  const wallet = (data.uri ?? '#').replace(/"/g, '&quot;')

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Age verification</title>
<style>
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0b0d12;color:#e7e9ee;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:1.5rem}
  .card{width:100%;max-width:380px;text-align:center;background:#14171f;border:1px solid #232733;
    border-radius:16px;padding:1.75rem;display:flex;flex-direction:column;gap:1rem;align-items:center}
  h1{font-size:1.4rem;margin:.25rem 0}
  .sub{color:#9aa3b2;font-size:.95rem;line-height:1.5;margin:0}
  .qr{background:#fff;border-radius:12px;padding:10px;line-height:0}.qr svg{width:220px;height:220px;display:block}
  .btn{width:100%;padding:.8rem;border:none;border-radius:10px;background:#4f6bff;color:#fff;
    font-weight:600;text-decoration:none;display:block}
  .hint{color:#6b7280;font-size:.8rem}
  .mark{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    font-size:1.5rem;font-weight:700;margin:0 auto}
  .ok .mark{background:rgba(34,197,94,.15);color:#22c55e}.bad .mark{background:rgba(239,68,68,.15);color:#ef4444}
  [hidden]{display:none!important}
</style></head><body>
<div class="card" id="pending">
  <h1>Age verification</h1>
  <p class="sub">${purpose}</p>
  <div class="qr">${qr}</div>
  <a class="btn" href="${wallet}">Open in wallet</a>
  <p class="hint">Scan with your EUDI wallet, or open on this device. Waiting…</p>
</div>
<div class="card ok" id="ok" hidden><div class="mark">✓</div><h1>Verified</h1><p class="sub">You can return to your assistant.</p></div>
<div class="card bad" id="bad" hidden><div class="mark">✗</div><h1 id="bt">Not verified</h1><p class="sub" id="bx">The presentation could not be verified.</p></div>
<script>
  var id=${JSON.stringify(id)};
  function show(s){document.getElementById('pending').hidden=s!=='pending';document.getElementById('ok').hidden=s!=='ok';document.getElementById('bad').hidden=s!=='bad'}
  function apply(st){
    if(st==='verified'){show('ok');return true}
    if(st==='failed'||st==='expired'||st==='not_found'){show('bad');return true}
    show('pending');return false
  }
  if(!apply(${JSON.stringify(data.status)})){
    var t=setInterval(function(){fetch('/present/'+id+'/status').then(function(r){return r.json()}).then(function(d){if(apply(d.status))clearInterval(t)}).catch(function(){})},3000)
  }
</script></body></html>`
}
