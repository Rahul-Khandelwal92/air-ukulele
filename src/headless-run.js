// Drive headless Chrome over the DevTools protocol and wait for a test page to finish.
// Usage: node src/headless-run.js <url> [timeoutMs]
// The page signals completion by setting document.title to anything other than 'RUNNING'
// and writes its report into #out.
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const url = process.argv[2];
const timeoutMs = parseInt(process.argv[3] || '180000', 10);
const port = 9333;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + port,
  '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + path.join(os.tmpdir(), 'uke-headless-profile'),
  url,
], { stdio: 'ignore' });

function getJson(u) {
  return new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    try { const t = await getJson('http://127.0.0.1:' + port + '/json'); page = t.find(x => x.type === 'page'); } catch (e) { }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = {};
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; } };
  const send = (method, params) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise(r => ws.onopen = r);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await send('Runtime.evaluate', { expression: 'document.title' });
    const v = r.result && r.result.result && r.result.result.value;
    if (v && v !== 'RUNNING') break;
    await sleep(500);
  }
  const r = await send('Runtime.evaluate', { expression: 'document.title + "\\n" + (document.getElementById("out") || {}).textContent' });
  console.log(r.result.result.value);
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
