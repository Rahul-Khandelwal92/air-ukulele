// Headless runtime smoke test for the live path that ?selftest=1 cannot reach: Start → keyboard
// mode (camera permission is auto-denied headless, so the real webcam is never opened and no live
// tracking frames interleave with ours) → synthetic hands pushed through App.onTrack → position
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
  const { App, UkeFrame, Chord, Annot, Tuning, AudioEngine } = window.__uke;
  const S = App.state;
  // count every pluck that reaches the engine (a hand strum spans several frames = several batches)
  const plucked = [];
  let batch = 0;                             // one batch per synthetic tracking frame
  const realPluck = AudioEngine.pluck;
  AudioEngine.pluck = (string, velocity, when) => { plucked.push({ string, when, batch }); return realPluck(string, velocity, when); };

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
  S.autoFit = false;                         // steps 1-9 hold synthetic hands still; the hands-free fit gets its own step (10)
  const video = document.getElementById('video'), overlay = document.getElementById('overlay');
  // inverse of App.coverMap(): screen-normalised → video-normalised (what MediaPipe would report)
  const inv = p => {
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9, sw = overlay.clientWidth || 16, sh = overlay.clientHeight || 9;
    const s = Math.max(sw / vw, sh / vh), dw = vw * s, dh = vh * s, ox = (sw - dw) / 2, oy = (sh - dh) / 2;
    return { x: (p.x * sw - ox) / dw, y: (p.y * sh - oy) / dh, z: 0 };
  };
  const fr = UkeFrame.get();
  const localToVideo = l => inv(UkeFrame.toScreen(l));
  // fretting hand: synthetic C shape (ring curled), translated so its ring tip (16) lands at whereVideo (video coords)
  const handAt = (down, tipIdx, whereVideo) => {
    const lm = Chord.syntheticHand(down, { scale: 0.6 });
    const dx = whereVideo.x - lm[tipIdx].x, dy = whereVideo.y - lm[tipIdx].y;
    return { landmarks: lm.map(p => ({ x: p.x + dx, y: p.y + dy, z: p.z })), score: 0.95, handedness: 'Left' };
  };
  let t = 1000;
  const frame = (fretting, strumming) => { t += 33; batch++; App.onTrack({ fps: 30, fretting, strumming }, t); };

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
  plucked.length = 0;
  const strumAt = ly => handAt({}, 8, localToVideo({ x: zx, y: ly }));
  const fretOk = handAt(Chord.LABEL_DOWN.C, 16, localToVideo(cDot));
  frame(fretOk, strumAt(-0.16)); frame(fretOk, strumAt(-0.05)); frame(fretOk, strumAt(0.06)); frame(fretOk, strumAt(0.16));
  await sleep(50);
  check(plucked.length === 4 && plucked.map(p => p.string).join() === '0,1,2,3', 'hand strum through the zone plays 4 strings in order (' + plucked.map(p => p.string).join() + ')');
  // frames are pushed synchronously here so AudioContext time does not advance between batches (in real
  // life frames are 33 ms apart); within one frame's batch the rake must be strictly increasing (V4 has the exact timing)
  const withinOk = plucked.every((p, i) => i === 0 || p.batch !== plucked[i - 1].batch || p.when > plucked[i - 1].when);
  check(withinOk && new Set(plucked.map(p => p.batch)).size >= 2, 'rake strictly increasing within each frame batch, strum spans several frames: ' +
    plucked.map(p => 'b' + p.batch + ':' + (p.when - plucked[0].when).toFixed(3)).join(' '));

  // (5) idle: strumming tip parked on string 1 with jitter for 2 s → no new plucks
  const y1 = UkeFrame.stringLocalYs()[1];
  frame(fretOk, strumAt(-0.13));
  frame(fretOk, strumAt(y1));                 // arrives on string 1 (crosses string 0 legitimately; wrist jump < 0.12)
  plucked.length = 0;
  let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 60; i++) frame(fretOk, strumAt(y1 + (rnd() - 0.5) * 0.012));
  check(plucked.length === 0, 'resting jittery fingertip on a string → 0 plucks (' + plucked.length + ')');

  // (6) fist as "strumming hand" moving across the strings → no plucks
  plucked.length = 0;
  const fistAt = ly => handAt(Chord.LABEL_DOWN.mute, 8, localToVideo({ x: zx, y: ly }));
  frame(fretOk, fistAt(-0.16)); frame(fretOk, fistAt(-0.05)); frame(fretOk, fistAt(0.06)); frame(fretOk, fistAt(0.16));
  check(plucked.length === 0, 'a fist sweeping the strings does not strum (' + plucked.length + ')');

  // (7) strumming hand vanishes then a different hand appears elsewhere → no rake
  plucked.length = 0;
  frame(fretOk, strumAt(-0.16)); frame(fretOk, null);
  frame(fretOk, handAt({}, 8, localToVideo({ x: zx, y: 0.16 })));   // reappears below the strings
  check(plucked.length === 0, 'hand lost and reappearing across the strings does not rake (' + plucked.length + ')');

  // (8) fretting hand gone → open strings
  for (let i = 0; i < 12; i++) frame(null, null);
  check(S.sounding === 'open' && !S.fretting, 'no fretting hand → open strings (' + S.sounding + ')');

  // (9) render loop keeps running with coaching on (no exceptions), song mode toggles
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' })); await sleep(100);
  for (let i = 0; i < 8; i++) frame(handAt(Chord.LABEL_DOWN.C, 16, localToVideo({ x: cDot.x, y: cDot.y + 1.5 * fr.spacing })), null);
  await sleep(200);
  check(S.songOn && /fingers on the dots|move your left hand|camera sees/.test(document.getElementById('song').textContent), 'song hint reflects position: ' + (document.querySelector('#songHint .sh-seen') || {}).textContent);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' })); await sleep(400);   // a few rAF ticks
  check(/position (off|ok|away)/.test(document.getElementById('debug').textContent), 'debug HUD shows position line: ' + JSON.stringify(document.getElementById('debug').textContent.slice(0, 400)) + ' debug=' + S.debug);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' })); await sleep(50);      // song off again (it is a layout obstacle)

  // (10) hands-free fit: both hands still for 2 s with the strumming tip clear of the strings → exactly one
  // animated refit sized from the palms, no plucks while the frame moves, frame clear of the UI afterwards
  S.autoFit = true; plucked.length = 0;
  const g0 = UkeFrame.get();
  const fretPose = handAt(Chord.LABEL_DOWN.open, 9, { x: 0.36, y: 0.40 });   // fretting knuckles up-left
  const strumPose = handAt({}, 8, { x: 0.66, y: 0.36 });                      // strumming tip well above the default strings
  for (let i = 0; i < 70; i++) frame(fretPose, strumPose);                     // 2.3 s of virtual time
  check(S.fit && S.fit.count === 1, 'hands still 2 s → one refit (' + JSON.stringify(S.fit) + ')');
  await sleep(600);                                                             // the 300 ms glide runs on rAF
  const g1 = UkeFrame.get();
  const cmS = App.coverMap(), k9 = cmS.toScreen(fretPose.landmarks[9]), t8 = cmS.toScreen(strumPose.landmarks[8]);   // Fit measures in screen coords
  const span = Math.hypot((k9.x - t8.x) * g1.aspect, k9.y - t8.y);
  const wantLen = Math.min(Math.max(span / 0.85, 0.6 * S.base.length), 1.0 * S.base.length);
  check(Math.abs(g1.length - wantLen) < 0.02 || (S.layout && S.layout.moved),
    'instrument sized from the hand span: length ' + g1.length.toFixed(3) + ' for span ' + span.toFixed(3) + ' (want ' + wantLen.toFixed(3) + ', was ' + g0.length.toFixed(3) + ')');
  check(g1.angleDeg <= UkeFrame.TILT_MIN_DEG && g1.angleDeg >= UkeFrame.TILT_MAX_DEG, 'fitted neck is tilted like a held ukulele (' + g1.angleDeg.toFixed(1) + '°, floor ' + UkeFrame.TILT_MIN_DEG + '°)');
  check(Math.hypot(g1.bridge.x - g0.bridge.x, g1.bridge.y - g0.bridge.y) > 0.01 || Math.abs(g1.length - g0.length) > 0.01, 'frame moved to the hands: bridge (' + g1.bridge.x.toFixed(2) + ',' + g1.bridge.y.toFixed(2) + ') from (' + g0.bridge.x.toFixed(2) + ',' + g0.bridge.y.toFixed(2) + ')');
  const tipL = UkeFrame.toLocal(App.coverMap().toScreen(strumPose.landmarks[8]));
  check((S.layout && S.layout.moved) || (Math.abs(tipL.x - 0.25 * g1.length) < 0.01 && Math.abs(tipL.y - UkeFrame.RECENTER_TIP_Y(g1.spacing)) < 0.01),
    'strumming tip parked at 25 % of the neck above the strings (local ' + tipL.x.toFixed(3) + ',' + tipL.y.toFixed(3) + ')' + (S.layout && S.layout.moved ? ' [layout nudged]' : ''));
  check(App.layoutCheck().ok, 'fitted frame clear of the HUD and status bar');
  check(plucked.length === 0, 'no plucks during the refit (' + plucked.length + ')');
  check(/fitted to you/.test(document.getElementById('status').textContent), 'status explains: ' + document.getElementById('status').textContent);
  // still hands at the new frame → no second refit (dead band / rate limit)
  const reasons = [];
  for (let i = 0; i < 70; i++) { frame(fretPose, strumPose); if (i % 10 === 9) reasons.push(S.fit.reason); }
  check(S.fit.count === 1, 'holding the pose does not refit again (' + reasons.join(' | ') + ')');
  // a strum right after the fit still works: sweep through the new strum zone
  const zone2 = UkeFrame.strumZone(), zx2 = 0.5 * (zone2[0] + zone2[1]);
  const l2v = l => inv(UkeFrame.toScreen(l));
  const sp2 = g1.spacing;
  plucked.length = 0;
  frame(fretPose, handAt({}, 8, l2v({ x: zx2, y: -3.2 * sp2 }))); frame(fretPose, handAt({}, 8, l2v({ x: zx2, y: -1.0 * sp2 })));
  frame(fretPose, handAt({}, 8, l2v({ x: zx2, y: 1.2 * sp2 }))); frame(fretPose, handAt({}, 8, l2v({ x: zx2, y: 3.2 * sp2 })));
  await sleep(50);
  check(plucked.length === 4 && plucked.map(p => p.string).join() === '0,1,2,3', 'strum on the fitted frame plays 4 strings in order (' + plucked.map(p => p.string).join() + ')');
  // A toggles auto-fit off
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); await sleep(20);
  check(S.autoFit === false && /auto-fit off/.test(document.getElementById('status').textContent), 'A turns auto-fit off');
  return out;
})()`;

// Runs inside the page after each viewport change. Returns [ok, message] pairs.
const LAYOUT_SCRIPT = `(async () => {
  const out = [];
  const check = (ok, msg) => out.push([!!ok, msg]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const { App, UkeFrame } = window.__uke;
  const S = App.state;
  S.framePinned = false;
  const overlay = document.getElementById('overlay');
  const fmt = b => '[' + b.x0.toFixed(2) + ',' + b.y0.toFixed(2) + ']-[' + b.x1.toFixed(2) + ',' + b.y1.toFixed(2) + ']';
  const run = label => {
    App.resize(); 
    const lc = App.layoutCheck();
    const g = UkeFrame.get();
    check(lc.ok, label + ': instrument ' + fmt(lc.bounds) + ' clear of ' + lc.obstacles + ' UI rects (hits ' + lc.hits + ', inside ' + lc.inside + ') scale ' + (S.layout && S.layout.scale) + ' viewport ' + overlay.clientWidth + 'x' + overlay.clientHeight);
    const zoneMid = UkeFrame.toScreen({ x: 0.25 * g.length, y: 0 });
    check(zoneMid.x > 0.5, label + ': strum zone in the right half (x ' + zoneMid.x.toFixed(2) + ')');
    check(S.layout && S.layout.ok, label + ': layout() reported ok');
  };
  await sleep(150);
  run('plain');
  const key = k => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  if (!S.helpOn) key('?'); await sleep(100); run('help open');
  if (!S.songOn) key('s'); await sleep(100); run('help + song open');
  key('?'); key('s'); await sleep(50);
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

  // Layout phase (runtime twin of V12): resize the window to several shapes, with and without the
  // help panel, and assert the instrument's bounds touch neither the real HUD/status/panel rects
  // nor the window edge.
  for (const [W, H] of [[1920, 1080], [1665, 663], [1366, 768], [1280, 720], [1024, 640], [2560, 1080], [900, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const lr = await send('Runtime.evaluate', { expression: LAYOUT_SCRIPT, awaitPromise: true, returnByValue: true, timeout: 20000 });
    const lv = (lr.result && lr.result.result && lr.result.result.value) || null;
    if (!lv) { pass = false; console.log('FAIL layout script did not return at ' + W + 'x' + H + ': ' + JSON.stringify(lr.result && lr.result.exceptionDetails || lr)); continue; }
    for (const [ok, msg] of lv) { if (!ok) pass = false; console.log((ok ? 'PASS ' : 'FAIL ') + W + 'x' + H + ' ' + msg); }
  }
  await send('Emulation.clearDeviceMetricsOverride', {});
  for (const ex of exceptions) { pass = false; console.log('FAIL page exception: ' + ex); }
  console.log(pass ? 'SMOKE OK' : 'SMOKE FAILED');
  ws.close(); chrome.kill(); process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
