// Headless screenshots of uke.html for design checks (no camera / audio needed).
// Usage: node src/shot.js  → src/shot-start.png, src/shot-main.png
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const url = 'file:///' + path.join(__dirname, '..', 'uke.html').replace(/\\/g, '/').replace(/ /g, '%20');
const port = 9334;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + port,
  '--window-size=1600,900',
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64'));
    console.log('wrote src/' + name);
  };
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) console.log('EVAL ERROR', JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails.text));
    return r.result && r.result.result && r.result.result.value;
  };
  await shot('shot-start.png');
  console.log(await evalJs(`(() => {
    const U = window.__uke; if (!U) return 'no __uke';
    document.getElementById('start').remove();
    const c = document.getElementById('overlay');
    c.width = c.clientWidth * devicePixelRatio; c.height = c.clientHeight * devicePixelRatio;
    U.UkeFrame.set({ aspect: c.clientWidth / c.clientHeight, bridge: { x: 0.64, y: 0.80 }, angleDeg: -18, length: 0.62, spacing: 0.042 });
    const ctx = c.getContext('2d');
    U.UkeFrame.draw(ctx, c.width, c.height, { highlight: [true, false, false, false] });
    if (U.Annot && U.Annot.drawInstrument) { try { U.Annot.drawInstrument(ctx, c.width, c.height, { chord: 'Am', recognised: 'Am', highlight: [true,false,false,false] }); } catch (e) { return 'annot error ' + e.message; } }
    document.getElementById('chord').textContent = 'Am';
    document.getElementById('chord').classList.remove('stale');
    document.getElementById('conf').firstElementChild.style.width = '82%';
    document.getElementById('pitch').innerHTML = 'target <b>440.00 Hz</b> · measured <b>440.02 Hz</b> · <span class="ok">+0.1 cents</span> · A4';
    document.getElementById('status').textContent = 'tracking via vendor · press B then click your blue cap to anchor the uke';
    if (U.Annot && U.Annot.renderHelp) { document.getElementById('help').classList.add('on'); document.getElementById('stage').classList.add('help-on'); try { U.Annot.renderHelp(document.getElementById('help'), { recognised: 'Am', target: 'Am' }); } catch (e) { return 'help error ' + e.message; } }
    if (U.Songs && U.Songs.createSession) {
      try {
        const s = U.Songs.createSession(U.Songs.get('rasputin'), { mode: 'practice' }); s.start(0);
        for (let i = 0; i < 5; i++) s.onStrum(s.state().current.chord, 1000 + i * 500);
        document.getElementById('song').classList.add('on'); document.getElementById('stage').classList.add('song-on');
        U.Songs.render(document.getElementById('song'), s, { recognisedChord: 'Am' });
        if (U.App && U.App.updateSongHint) U.App.updateSongHint(s.state().current.chord, 'open');
      } catch (e) { return 'song error ' + e.message; }
    }
    return 'ok ' + c.width + 'x' + c.height;
  })()`));
  await sleep(300);
  await shot('shot-main.png');
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
