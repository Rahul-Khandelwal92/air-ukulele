// Headless runtime smoke test for the live path that ?selftest=1 cannot reach: Start → keyboard
// mode (no camera in headless Chrome) → synthetic hands pushed through App.onTrack → position
// gating, sounding rule, strum guards, coaching overlay and HUD. Prints PASS/FAIL lines and exits 1
// on any failure or uncaught page exception.
// Usage: node src/smoke-run.js [url]
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const url = process.argv[2] || 'file:///' + path.join(__dirname, '..', 'uke.html').replace(/\\/g, '/').replace(/ /g, '%20');
const port = 9334;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1280,720',
  '--remote-debugging-port=' + port,
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--user-data-dir=' + path.join(os.tmpdir(), 'uke-smoke-profile'),
  url,
], { stdio: 'ignore' });

const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs inside the page. Returns an array of [ok, message] pairs.
const PAGE_SCRIPT = `(async () => {
  const out = [];
  const check = (ok, msg) => out.push([!!ok, msg]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const { App, UkeFrame, Chord, Annot, Tuning } = window.__uke;
  const S = App.state;

  document.getElementById('startBtn').click();
  for (let i = 0; i < 100 && !S.started; i++) await sleep(50);
  // wait for the camera/tracker attempt to settle (headless: fake camera or failure, both fine)
  for (let i = 0; i < 200; i++) { const st = document.getElementById('status').textContent; if (/keyboard|tracking via|cap/.test(st)) break; await sleep(100); }
  check(S.started, 'app started: ' + document.getElementById('status').textContent);
  check(S.sounding === 'open', 'engine tuned to open at start (sounding=' + S.sounding + ')');

  // keyboard path
  const key = k => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  key('q'); await sleep(20);
  check(S.keyboardChord === 'C' && App.soundingChord() === 'C' && document.getElementById('chord').textContent === 'C', 'Q forces C on the engine and HUD');
  key(' '); await sleep(120);
  check(S.lastPlucks.length === 4, 'Space strums 4 strings (' + S.lastPlucks.length + ')');
  key('o'); await sleep(20);
  check(!S.keyboardChord && App.soundingChord() === 'open', 'O releases the override');

  // --- synthetic tracking frames -------------------------------------------------------
  S.trackingOn = true;                       // pretend the camera is up; onTrack is driven by hand below
  const video = document.getElementById('video'), overlay = document.getElementById('overlay');
  // inverse of App.coverMap(): screen-normalised → video-normalised (what MediaPipe would report)
  const inv = p => {
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9, sw = overlay.clientWidth || 16, sh = overlay.clientHeight || 9;
    const s = Math.max(sw / vw, sh / vh), dw = vw * s, dh = vh * s, ox = (sw - dw) / 2, oy = (sh - dh) / 2;
    return { x: (p.x * sw - ox) / dw, y: (p.y * sh - oy) / dh, z: 0 };
  };
  const fr = UkeFrame.get();
  const localToVideo = l => inv(UkeFrame.toScreen(l));
  // fretting hand: synthetic C shape (ring curled), translated so its ring tip (16) lands at `where` (video coords)
  const handAt = (down, tipIdx, whereVideo) => {
    const lm = Chord.syntheticHand(down, { scale: 0.6 });
    const dx = whereVideo.x - lm[tipIdx].x, dy = whereVideo.y - lm[tipIdx].y;
    return { landmarks: lm.map(p => ({ x: p.x + dx, y: p.y + dy, z: p.z })), score: 0.95, handedness: 'Left' };
  };
  let t = 1000;
  const frame = (fretting, strumming) => { t += 33; App.onTrack({ fps: 30, fretting, strumming }, t); };

  // (1) C shape far from the instrument (upper-left corner) → recognised C, position 'away', sounds open
  for (let i = 0; i < 8; i++) frame(handAt(Chord.LABEL_DOWN.C, 16, { x: 0.12, y: 0.25 }), null);
  check(S.chord === 'C', 'C shape recognised from curls (chord=' + S.chord + ')');
  check(S.position === 'away', 'hand off the fretboard → position away (' + S.position + ')');
  check(App.soundingChord() === 'open' && S.sounding === 'open', 'off the fretboard → open strings sound (' + S.sounding + ')');
  check(/off the fretboard/.test(document.getElementById('pos').textContent), 'HUD explains: ' + document.getElementById('pos').textContent);

  // (2) C shape over the neck but ring tip one string too low → 'off', damped
  const cDot = Annot.dotTargets('C', fr.length, fr.spacing)[0].local;
  for (let i = 0; i < 8; i++) frame(handAt(Chord.LABEL_DOWN.C, 16, localToVideo({ x: cDot.x, y: cDot.y + 1.5 * fr.spacing })), null);
  check(S.chord === 'C' && S.overNeck, 'over the neck (overNeck=' + S.overNeck + ', chord=' + S.chord + ')');
  check(S.position === 'off', 'ring finger 1.5 strings off the dot → position off (' + S.position + ')');
  check(S.sounding === 'mute', 'wrong spot → strings damped (' + S.sounding + ')');
  check(S.coach && S.coach.dots[0] && !S.coach.dots[0].ok && /down one string/.test(Annot.hintFor(S.coach.dots[0], fr.length, fr.spacing)) === false, 'hint points up: ' + (S.coach ? Annot.hintFor(S.coach.dots[0], fr.length, fr.spacing) : '-'));

  // (3) ring tip on the C dot → 'ok', C sounds
  for (let i = 0; i < 8; i++) frame(handAt(Chord.LABEL_DOWN.C, 16, localToVideo(cDot)), null);
  check(S.position === 'ok' && S.positionOk, 'ring tip on the dot → position ok (' + S.position + ')');
  check(S.sounding === 'C', 'in position → C sounds (' + S.sounding + ')');
  check(/in position/.test(document.getElementById('pos').textContent), 'HUD: ' + document.getElementById('pos').textContent);

  // (4) strum: right index tip sweeps down across the strings inside the strum zone
  const zone = UkeFrame.strumZone(), zx = 0.5 * (zone[0] + zone[1]);
  const before = S.lastPlucks.slice();
  const strumAt = ly => handAt({}, 8, localToVideo({ x: zx, y: ly }));
  const fretOk = handAt(Chord.LABEL_DOWN.C, 16, localToVideo(cDot));
  frame(fretOk, strumAt(-0.16)); frame(fretOk, strumAt(-0.05)); frame(fretOk, strumAt(0.06)); frame(fretOk, strumAt(0.16));
  await sleep(50);
  check(S.lastPlucks.length === 4 && S.lastPlucks !== before, 'hand strum through the zone plays 4 strings (' + S.lastPlucks.length + ')');
  const whens = S.lastPlucks.map(p => p.when);
  check(whens.every((w, i) => i === 0 || w > whens[i - 1]), 'plucks scheduled strictly increasing: ' + whens.map(w => (w - whens[0]).toFixed(3)).join(' '));

  // (5) idle: strumming tip parked on string 1 with jitter for 2 s → no new plucks
  S.lastPlucks = [];
  const y1 = UkeFrame.stringLocalYs()[1];
  frame(fretOk, strumAt(-0.13));
  frame(fretOk, strumAt(y1));                 // arrives on string 1 (crosses string 0 legitimately; wrist jump < 0.12)
  S.lastPlucks = [];
  let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 60; i++) frame(fretOk, strumAt(y1 + (rnd() - 0.5) * 0.012));
  check(S.lastPlucks.length === 0, 'resting jittery fingertip on a string → 0 plucks (' + S.lastPlucks.length + ')');

  // (6) fist as "strumming hand" moving across the strings → no plucks
  S.lastPlucks = [];
  const fistAt = ly => handAt(Chord.LABEL_DOWN.mute, 8, localToVideo({ x: zx, y: ly }));
  frame(fretOk, fistAt(-0.16)); frame(fretOk, fistAt(-0.05)); frame(fretOk, fistAt(0.06)); frame(fretOk, fistAt(0.16));
  check(S.lastPlucks.length === 0, 'a fist sweeping the strings does not strum (' + S.lastPlucks.length + ')');

  // (7) strumming hand vanishes then a different hand appears elsewhere → no rake
  S.lastPlucks = [];
  frame(fretOk, strumAt(-0.16)); frame(fretOk, null);
  frame(fretOk, handAt({}, 8, localToVideo({ x: zx, y: 0.16 })));   // reappears below the strings
  check(S.lastPlucks.length === 0, 'hand lost and reappearing across the strings does not rake (' + S.lastPlucks.length + ')');

  // (8) fretting hand gone → open strings
  for (let i = 0; i < 12; i++) frame(null, null);
  check(S.sounding === 'open' && !S.fretting, 'no fretting hand → open strings (' + S.sounding + ')');

  // (9) render loop keeps running with coaching on (no exceptions), song mode toggles
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' })); await sleep(100);
  for (let i = 0; i < 8; i++) frame(handAt(Chord.LABEL_DOWN.C, 16, localToVideo({ x: cDot.x, y: cDot.y + 1.5 * fr.spacing })), null);
  await sleep(200);
  check(S.songOn && /fingers on the dots|move your left hand|camera sees/.test(document.getElementById('song').textContent), 'song hint reflects position: ' + (document.querySelector('#songHint .sh-seen') || {}).textContent);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' })); await sleep(100);
  check(/position (off|ok|away)/.test(document.getElementById('debug').textContent), 'debug HUD shows position line');
  return out;
})()`;

(async () => {
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    try { const t = await getJson('http://127.0.0.1:' + port + '/json'); page = t.find(x => x.type === 'page'); } catch (e) { }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = {}; const exceptions = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text + ' ' + ((m.params.exceptionDetails.exception || {}).description || ''));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') exceptions.push('console.error ' + m.params.args.map(a => a.value || a.description).join(' '));
  };
  const send = (method, params) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable', {});
  await sleep(1500);
  const r = await send('Runtime.evaluate', { expression: PAGE_SCRIPT, awaitPromise: true, returnByValue: true, timeout: 60000 });
  const res = (r.result && r.result.result && r.result.result.value) || null;
  let pass = true;
  if (!res) { pass = false; console.log('FAIL page script did not return: ' + JSON.stringify(r.result && r.result.exceptionDetails || r)); }
  else for (const [ok, msg] of res) { if (!ok) pass = false; console.log((ok ? 'PASS ' : 'FAIL ') + msg); }
  for (const ex of exceptions) { pass = false; console.log('FAIL page exception: ' + ex); }
  console.log(pass ? 'SMOKE OK' : 'SMOKE FAILED');
  ws.close(); chrome.kill(); process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
