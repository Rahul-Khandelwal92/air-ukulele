// Headless screenshots of uke.html for design checks (no camera / audio device needed).
// Goes through the real Start path so the layout engine (UkeFrame.layout) places the instrument
// exactly as it would for a user at that window size.
// Usage: node src/shot.js [width height]   → src/shot-start.png, src/shot-main.png, src/shot-panels.png
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const W = parseInt(process.argv[2] || '1665', 10), H = parseInt(process.argv[3] || '663', 10);   // default: the user's laptop window
const url = 'file:///' + path.join(__dirname, '..', 'uke.html').replace(/\\/g, '/').replace(/ /g, '%20');
const port = 9335;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + port,
  '--autoplay-policy=no-user-gesture-required',
  `--window-size=${W},${H}`,
  '--user-data-dir=' + path.join(os.tmpdir(), 'uke-shot-profile'),
  url,
], { stdio: 'ignore' });

const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
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
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64'));
    console.log('wrote src/' + name);
  };
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 30000 });
    if (r.result && r.result.exceptionDetails) console.log('EVAL ERROR', JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails.text));
    return r.result && r.result.result && r.result.result.value;
  };
  await shot('shot-start.png');
  // Real start: audio init + resize()/layout; the camera is denied headless so we land in keyboard mode.
  console.log(await evalJs(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const U = window.__uke; if (!U) return 'no __uke';
    document.getElementById('startBtn').click();
    for (let i = 0; i < 100 && !U.App.state.started; i++) await sleep(50);
    for (let i = 0; i < 200; i++) { const st = document.getElementById('status').textContent; if (/keyboard|tracking via|cap/.test(st)) break; await sleep(100); }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }));       // Am on the HUD and the fretboard
    document.getElementById('pitch').innerHTML = 'target <b>440.00 Hz</b> · measured <b>440.02 Hz</b> · <span class="ok">+0.1 cents</span> · A4';
    await sleep(300);
    const lc = U.App.layoutCheck();
    return 'started ' + document.getElementById('overlay').clientWidth + 'x' + document.getElementById('overlay').clientHeight +
      ' layout ' + (lc.ok ? 'OK' : 'OVERLAP') + ' scale ' + (U.App.state.layout && U.App.state.layout.scale) + ' ' + JSON.stringify(U.UkeFrame.get());
  })()`));
  await shot('shot-main.png');
  console.log(await evalJs(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    await sleep(300);
    const lc = window.__uke.App.layoutCheck();
    return 'panels open: layout ' + (lc.ok ? 'OK' : 'OVERLAP') + ' scale ' + window.__uke.App.state.layout.scale;
  })()`));
  await shot('shot-panels.png');
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
