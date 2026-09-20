// ============================================================================
// render/ + input/ + verify/ + main  — wiring for uke.html
// Depends on: Tuning, AudioEngine, Tracking, Chord, UkeFrame, Strum, Annot, Anchor, Songs
// ============================================================================
const App = (() => {
  const $ = id => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), ctx2d = overlay.getContext('2d');
  const el = { chord: $('chord'), conf: $('conf').firstElementChild, pitch: $('pitch'), pos: $('pos'), debug: $('debug'),
               status: $('status'), start: $('start'), startBtn: $('startBtn'), startNote: $('startNote'),
               panel: $('panel'), panelBody: $('panelBody'), calib: $('calib'), help: $('help'), song: $('song') };

  const state = {
    started: false, cameraOn: false, trackingOn: false, debug: false,
    chord: 'open', confidence: 0, method: 'rules', curls: null,
    keyboardChord: null,            // Q/W/E/R override; O releases
    sounding: null,                 // chord the engine is actually tuned to (after position gating)
    lastPlucks: [],                 // for the debug HUD (string, when)
    fps: 0, trackSource: '-',
    fretting: null, strumming: null,   // hands in SCREEN-normalised coords (cover-mapped)
    // position layer: fretting fingertips in instrument-local coords (index 1..4), match result, verdict
    fretTips: null, match: null, coach: null, overNeck: false, positionOk: false,
    position: null,                 // 'ok' | 'off' (over neck, fingers not on the dots) | 'away' (hand not over the neck)
    lastStrumWrist: null,           // strumming wrist in local coords, to catch role swaps between hands
    calibrating: null,
    highlight: [false, false, false, false], highlightUntil: [0, 0, 0, 0],
    helpOn: false,
    song: null, songOn: false,      // Songs session
    anchorOn: false, anchorArmed: false, anchor: null,   // blue-cap tracker
    framePinned: false,             // anchor or C-recentre has placed the frame: resize must not move it
    base: { length: 0.55, spacing: 0.05 },               // unscaled frame size from resize()
    lastSpacing: 0,
  };

  const voter = Chord.createVoter({ window: 5, minVotes: 3, minConfidence: 0.5 });
  let detector = null;
  let anchorTracker = null;

  // ---------------------------------------------------------------- helpers
  const setStatus = s => { el.status.textContent = s; };
  const currentChord = () => state.keyboardChord || state.chord || 'open';
  const targetChord = () => (state.songOn && state.song && !state.song.state().done) ? state.song.state().current.chord : currentChord();

  // Recognised shape → HUD label. The engine is tuned by applySounding(), not here.
  function applyChord(name) {
    el.chord.textContent = name;
    el.chord.classList.toggle('stale', name === 'open' || name === 'mute');
    applySounding();
  }

  // What actually sounds, layered like a real instrument:
  //   keyboard override          → that chord (keyboard must always drive the app)
  //   no camera                  → the recognised chord (nothing to gate on)
  //   fretting hand off the neck → open strings (no fingers on the board = open)
  //   over the neck, wrong spot  → all strings damped (ρ = 0.9): a thud, not the right notes
  //   fingers on the dots        → the recognised chord
  function soundingChord() {
    if (state.keyboardChord) return state.keyboardChord;
    if (!state.trackingOn) return state.chord || 'open';
    if (!state.fretting || state.position === 'away') return 'open';
    if (state.position === 'off') return 'mute';
    return state.chord || 'open';
  }
  function applySounding() {
    const name = soundingChord();
    if (name !== state.sounding) { state.sounding = name; AudioEngine.setChord(name); }
    const off = !state.keyboardChord && state.trackingOn && state.fretting && state.position === 'off';
    el.chord.classList.toggle('off', !!off);
    let msg = '', cls = '';
    if (state.keyboardChord) { msg = 'keyboard override — O to release'; }
    else if (!state.trackingOn) { msg = ''; }
    else if (!state.fretting) { msg = 'no left hand — open strings'; }
    else if (state.position === 'away') { msg = 'left hand off the fretboard — open strings'; cls = 'warn'; }
    else if (state.position === 'off') { msg = 'fingers not on the dots — strings damped'; cls = 'warn'; }
    else if (state.chord && state.chord !== 'open' && state.chord !== 'mute') { msg = `fingers in position — ${state.chord} will sound`; cls = 'ok'; }
    if (el.pos) { el.pos.textContent = msg; el.pos.className = cls; }
  }

  // Fingertip landmark for finger n (1 index … 4 pinky) is 4n + 4.
  const TIP_LM = [null, 8, 12, 16, 20];
  const POS_WINDOW = 5, POS_MIN = 3;   // same majority as the chord voter: 3 of the last 5 frames
  const neckVotes = [], posVotes = [];
  function vote(buf, v, current) {
    buf.push(!!v); if (buf.length > POS_WINDOW) buf.shift();
    const yes = buf.filter(Boolean).length;
    if (yes >= POS_MIN) return true;
    if (buf.length - yes >= POS_MIN) return false;
    return current;
  }
  // Position layer: is the fretting hand over the neck, and are its fingertips on the dots of the
  // recognised chord? Runs every tracking frame after the frame may have moved (anchor).
  const FRET_LOST_GRACE_MS = 300;   // a hand dropped for a few frames keeps its verdict; longer = really gone
  let lastFrettingSeenMs = -Infinity;
  function updatePosition(nowMs) {
    const hand = state.fretting;
    if (hand) lastFrettingSeenMs = nowMs;
    else if (nowMs - lastFrettingSeenMs < FRET_LOST_GRACE_MS) return;
    if (!hand) {
      neckVotes.length = 0; posVotes.length = 0;
      state.fretTips = null; state.match = null; state.coach = null; state.overNeck = false; state.positionOk = false; state.position = null;
      applySounding();
      return;
    }
    const tips = TIP_LM.map(i => (i == null ? null : UkeFrame.toLocal(hand.landmarks[i])));
    state.fretTips = tips;
    const fr = UkeFrame.get();
    state.overNeck = vote(neckVotes, Annot.handOverNeck(tips.slice(1), UkeFrame.neckZone()), state.overNeck);
    state.match = Annot.matchFingers(state.chord || 'open', tips, fr.length, fr.spacing);
    state.positionOk = vote(posVotes, state.overNeck && state.match.allOk, state.positionOk);
    // coaching compares against the song target when a song is on, else the recognised chord
    const coachChord = targetChord();
    state.coach = coachChord === (state.chord || 'open') ? state.match : Annot.matchFingers(coachChord, tips, fr.length, fr.spacing);
    state.position = !state.overNeck ? 'away' : state.positionOk ? 'ok' : 'off';
    applySounding();
  }

  function firePlucks(scheduled) {
    // scheduled: [{string, velocity, when}] with `when` in AudioContext seconds
    for (const p of scheduled) {
      AudioEngine.pluck(p.string, p.velocity, p.when);
      const delayMs = Math.max(0, (p.when - AudioEngine.now()) * 1000);
      setTimeout(() => { state.highlightUntil[p.string] = performance.now() + 250; }, delayMs);
    }
    state.lastPlucks = scheduled.map(p => ({ string: p.string, when: p.when }));
    // One strum event per batch feeds the song session (practice mode advances on the correct chord).
    // The *sounding* chord is fed, so a right shape in the wrong place (damped) never advances a bar.
    if (state.songOn && state.song) {
      const r = state.song.onStrum(soundingChord(), performance.now());
      if (r && r.advanced && state.song.state().done) setStatus('song complete — press S to restart');
    }
  }

  function strumChord(dir) {
    const frets = Tuning.CHORDS[soundingChord()] || Tuning.CHORDS.open;
    firePlucks(Strum.keyboardStrum(frets, dir, 12, AudioEngine.now())); // 12 ms rake ≈ a relaxed hand
  }

  function rebuildDetector() {
    const fr = UkeFrame.get();
    // hysteresis band, speed gate, arming and minVelocity take the documented defaults in Strum.createDetector
    detector = Strum.createDetector({ stringYs: UkeFrame.stringLocalYs(), zoneX: UkeFrame.strumZone(), spacing: fr.spacing, debounceMs: 40, maxJump: 0.4 });
    state.lastSpacing = fr.spacing;
    state.lastStrumWrist = null;
  }

  // The <video> uses object-fit: cover, so raw video-normalised coords (MediaPipe, cap tracker)
  // must be mapped through the crop to line up with what is on screen.
  function coverMap() {
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const sw = overlay.clientWidth || 16, sh = overlay.clientHeight || 9;
    const s = Math.max(sw / vw, sh / vh);
    const dw = vw * s, dh = vh * s, ox = (sw - dw) / 2, oy = (sh - dh) / 2;
    return { toScreen: p => ({ x: (ox + p.x * dw) / sw, y: (oy + p.y * dh) / sh, z: p.z }), rScale: dh / sh };
  }
  function mapHand(hand, cm) {
    return hand ? { ...hand, landmarks: hand.landmarks.map(cm.toScreen) } : null;
  }

  // ---------------------------------------------------------------- start
  async function start() {
    if (state.started) return;
    state.started = true;
    el.startBtn.disabled = true;
    setStatus('starting audio…');
    await AudioEngine.init();
    applyChord('open');
    resize();
    rebuildDetector();
    el.start.style.display = 'none';
    requestAnimationFrame(renderLoop);

    // Camera + tracking are best-effort; keyboard and mouse always work.
    try {
      setStatus('loading hand tracker…');
      await Tracking.init({ onStatus: setStatus });
      state.trackSource = Tracking.source || '-';
      setStatus('starting camera…');
      await Tracking.startCamera(video, { width: 1280, height: 720 });   // 16:9 so cover-crop is minimal on laptops
      state.cameraOn = true;
      state.trackingOn = true;
      anchorTracker = Anchor.createTracker();
      Tracking.onFrame(video, onTrack);
      setStatus(`tracking via ${state.trackSource} · press B then click your blue cap to anchor the uke`);
    } catch (e) {
      setStatus('no camera/tracker — keyboard + mouse mode (' + (e && e.message || e) + ')');
    }
  }

  // ---------------------------------------------------------------- tracking → chord + strum + anchor
  function onTrack(result, nowMs) {
    state.fps = result.fps;
    const cm = coverMap();
    state.fretting = mapHand(result.fretting, cm);
    state.strumming = mapHand(result.strumming, cm);

    if (state.calibrating && result.fretting) {
      Chord.calib.addFrame(result.fretting.landmarks);        // raw coords: Chord normalises its own frame
    }

    // Chord recognition from the fretting hand shape
    if (result.fretting && !state.calibrating) {
      const r = Chord.classify(result.fretting.landmarks);
      state.curls = r.curls; state.method = r.method;
      const v = voter.push(r);
      state.confidence = v.confidence || 0;
      if (v.chord && v.chord !== state.chord) {
        state.chord = v.chord;
        if (!state.keyboardChord) applyChord(v.chord);
      }
    }

    // Blue-cap anchor → instrument position and size
    if (state.anchorOn && anchorTracker) {
      const img = Anchor.sampleFrame(video, Anchor.params.scanW, Anchor.params.scanH);
      if (img) {
        const a = anchorTracker.update(img, nowMs);
        const sp = cm.toScreen({ x: a.x, y: a.y });
        state.anchor = { x: sp.x, y: sp.y, r: a.r * cm.rScale, visible: a.visible, lostForMs: a.lostForMs };
        if (a.visible || a.lostForMs < Anchor.params.lostMs) {
          const g = Anchor.placeFrame(state.anchor, state.base);
          UkeFrame.set({ bridge: g.bridge, length: g.length, spacing: g.spacing });
          state.framePinned = true;
          if (Math.abs(g.spacing - state.lastSpacing) > 0.02 * state.lastSpacing) rebuildDetector();
        }
      }
    }

    // Position layer (after the frame may have moved)
    updatePosition(nowMs);

    // Strum detection from the strumming index tip (landmark 8)
    if (state.strumming) {
      const lm = state.strumming.landmarks;
      // A wrist cannot translate 12% of the frame in one camera frame; if it did, the "strumming hand"
      // is a different hand (role swap / duplicate detection) and the ring buffer must not bridge them.
      const wristL = UkeFrame.toLocal(lm[0]);
      if (state.lastStrumWrist && Math.hypot(wristL.x - state.lastStrumWrist.x, wristL.y - state.lastStrumWrist.y) > WRIST_JUMP_MAX) detector.reset();
      state.lastStrumWrist = wristL;
      // A strumming index finger is extended; a fist, or a face detected as a hand, is not.
      if (Chord.curls(lm).index > STRUM_INDEX_MAX_CURL) {
        detector.reset();
      } else {
        const tip = lm[8];
        const local = UkeFrame.toLocal({ x: tip.x, y: tip.y });
        const plucks = detector.push({ x: local.x, y: local.y, t: nowMs });
        if (plucks.length) firePlucks(Strum.schedule(plucks, AudioEngine.now(), nowMs));
      }
    } else {
      detector.reset();
      state.lastStrumWrist = null;
    }
  }
  const WRIST_JUMP_MAX = 0.12;        // local units (frame heights) per tracking frame
  const STRUM_INDEX_MAX_CURL = 0.5;   // Chord.curls: 0 = straight, 1 = folded into the palm

  // ---------------------------------------------------------------- render
  function resize() {
    overlay.width = overlay.clientWidth * devicePixelRatio;
    overlay.height = overlay.clientHeight * devicePixelRatio;
    // Isotropic geometry: with aspect set, lengths are in frame-heights, so a −15° neck is really 15° on screen.
    const aspect = overlay.clientWidth / Math.max(1, overlay.clientHeight);
    // Sized like a soprano uke held at chest height: neck ≈ 0.66 frame-heights, string spacing 0.05
    // (fingertip-sized cells so position play is feasible), body right of centre at chest height.
    // y = 0.62, not 0.80: at 0.80 the strings sat at lap height, right where a seated player's
    // right hand rests and where hands enter the frame.
    state.base = { length: Math.min(0.66, 0.38 * aspect), spacing: 0.05 };
    const geo = { aspect, length: state.base.length, spacing: state.base.spacing };
    if (!state.framePinned) Object.assign(geo, { bridge: { x: 0.64, y: 0.62 }, angleDeg: -18 });   // anchor / C own the placement otherwise
    UkeFrame.set(geo);
    if (detector) rebuildDetector();
  }
  window.addEventListener('resize', resize);

  function renderLoop() {
    const w = overlay.width, h = overlay.height, now = performance.now();
    ctx2d.clearRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) state.highlight[i] = state.highlightUntil[i] > now;
    UkeFrame.draw(ctx2d, w, h, { highlight: state.highlight });
    const position = (state.trackingOn && state.fretting && !state.keyboardChord) ? state.position : null;
    Annot.drawInstrument(ctx2d, w, h, { chord: targetChord(), recognised: currentChord(), highlight: state.highlight, position });
    if (position) {
      const hc = state.fretting ? UkeFrame.toLocal(handCentre(state.fretting)) : null;
      Annot.drawCoaching(ctx2d, w, h, { chord: targetChord(), match: state.coach, tips: state.fretTips, overNeck: state.overNeck, handCentre: hc });
    }
    if (state.fretting) Tracking.drawLandmarks(ctx2d, state.fretting, w, h, '#4fc3f7');
    if (state.strumming) Tracking.drawLandmarks(ctx2d, state.strumming, w, h, '#ffb74d');
    if (state.anchorOn && state.anchor) Anchor.drawMarker(ctx2d, state.anchor, w, h);

    el.conf.style.width = Math.round(100 * Math.min(1, state.confidence)) + '%';
    el.conf.style.background = state.confidence >= 0.5 ? 'var(--ok)' : 'var(--accent)';

    const lr = AudioEngine.liveReadout && AudioEngine.liveReadout();
    if (lr && lr.measuredHz) {
      const ok = Math.abs(lr.cents) <= 3;
      el.pitch.innerHTML = `target <b>${lr.targetHz.toFixed(2)} Hz</b> · measured <b>${lr.measuredHz.toFixed(2)} Hz</b> · ` +
        `<span class="${ok ? 'ok' : 'bad'}">${lr.cents >= 0 ? '+' : ''}${lr.cents.toFixed(1)} cents</span> · ${lr.note || ''}`;
    }

    if (state.helpOn) Annot.renderHelp(el.help, { recognised: currentChord(), target: state.songOn ? targetChord() : null });
    if (state.songOn && state.song) {
      if (state.song.state().mode === 'playalong') state.song.tick(now);
      Songs.render(el.song, state.song, { recognisedChord: currentChord() });
      updateSongHint(targetChord(), currentChord(), position);
    }

    if (state.debug) {
      const c = state.curls, a = state.anchor, m = state.match;
      el.debug.textContent =
        `fps ${state.fps.toFixed(0)}   src ${state.trackSource}   video ${video.videoWidth}x${video.videoHeight}\n` +
        `method ${state.method}   kb ${state.keyboardChord || '-'}   target ${targetChord()}   sounding ${state.sounding}\n` +
        (c ? `curl idx ${c.index.toFixed(2)} mid ${c.middle.toFixed(2)} rng ${c.ring.toFixed(2)} pky ${c.pinky.toFixed(2)}  thr ${Chord.params.downThreshold}\n` : '') +
        `position ${state.position || '-'}  overNeck ${state.overNeck}  ` +
        (m && m.dots.length ? `dn ${m.dots.map(d => 'f' + d.finger + ':' + (Number.isFinite(d.dn) ? d.dn.toFixed(2) : '∞')).join(' ')}` : 'no dots') +
        `  strum armed ${detector && detector.isArmed ? detector.isArmed() : '-'}  v ${detector ? detector.lastVelocity().toFixed(2) : '-'}\n` +
        (a ? `anchor ${a.visible ? 'seen' : 'lost ' + a.lostForMs.toFixed(0) + 'ms'} x ${a.x.toFixed(3)} y ${a.y.toFixed(3)} r ${a.r.toFixed(4)}\n` : '') +
        `last plucks ${state.lastPlucks.map(p => p.string + '@' + p.when.toFixed(3)).join(' ')}\n` +
        `frame ${JSON.stringify(UkeFrame.get())}`;
    }
    requestAnimationFrame(renderLoop);
  }

  // ---------------------------------------------------------------- calibration flow (key K)
  async function calibrate() {
    if (state.calibrating || !state.trackingOn) { setStatus('calibration needs the camera'); return; }
    const labels = ['C', 'G', 'Am', 'F', 'open'];
    el.calib.classList.add('on');
    for (const label of labels) {
      el.calib.querySelector('.big').textContent = label;
      for (let s = 3; s >= 1; s--) {              // 3 s per shape, first second is "get ready"
        el.calib.querySelector('.count').textContent = s;
        if (s === 2) { Chord.calib.begin(label); state.calibrating = label; }
        await new Promise(r => setTimeout(r, 1000));
      }
      state.calibrating = null;
      Chord.calib.end();
    }
    el.calib.classList.remove('on');
    Chord.calib.save();
    voter.reset();
    const r = Chord.selfTest();
    showPanel(r.pass, r.lines);
    setStatus('calibration saved — recognition now uses your hand');
  }

  // ---------------------------------------------------------------- song mode (key S)
  function toggleSong() {
    if (!state.songOn) {
      if (!state.song || state.song.state().done) {
        state.song = Songs.createSession(Songs.get('rasputin'), { mode: 'practice' });
        state.song.start(performance.now());
      }
      state.songOn = true; el.song.classList.add('on'); $('stage').classList.add('song-on');
      setStatus('song: Rasputin (practice) — strum the shown chord to advance · M toggles play-along');
    } else {
      state.songOn = false; el.song.classList.remove('on'); $('stage').classList.remove('song-on');
    }
  }

  // "How to play it" hint inside the song panel: mini diagram + the hand rule + what the camera sees.
  // Centroid of the four finger MCPs (5, 9, 13, 17): where the hand "is" for the coaching arrow.
  function handCentre(hand) {
    const p = [5, 9, 13, 17].map(i => hand.landmarks[i]);
    return { x: (p[0].x + p[1].x + p[2].x + p[3].x) / 4, y: (p[0].y + p[1].y + p[2].y + p[3].y) / 4 };
  }

  let hint = null, hintChord = null;
  function updateSongHint(target, recognised, position) {
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'songHint';
      hint.innerHTML = '<div class="sh-row"><canvas width="128" height="160" style="width:64px;height:80px"></canvas>' +
        '<div class="sh-text"><div class="sh-how"></div><div class="sh-steps">1 · left hand up, palm to camera<br>2 · hold the shape until this turns green<br>3 · sweep right index finger down across the strings</div></div></div>' +
        '<div class="sh-seen"></div>';
      const st = document.createElement('style');
      st.textContent = '#songHint{margin-top:4px}#songHint .sh-row{display:flex;gap:12px;align-items:flex-start}#songHint .sh-how{font-weight:700;color:var(--fg);margin-bottom:4px}' +
        '#songHint .sh-steps{font-size:12px;color:var(--muted);line-height:1.5}#songHint .sh-seen{margin-top:8px;font-size:12px;color:var(--accent)}#songHint .sh-seen.ok{color:var(--ok)}';
      document.head.appendChild(st);
      const centre = el.song.querySelector('.sg-centre');
      (centre || el.song).appendChild(hint);
    }
    if (target !== hintChord) {
      hintChord = target;
      Annot.drawMiniDiagram(hint.querySelector('canvas'), target);
      const rule = Tuning.CURL_RULE[target];
      hint.querySelector('.sh-how').textContent = `How: ${rule ? rule.text : ''} — keep the other fingers straight`;
    }
    const seen = hint.querySelector('.sh-seen');
    const shapeOk = recognised === target;
    const ok = shapeOk && position !== 'off' && position !== 'away';
    seen.textContent = !shapeOk ? `camera sees: ${recognised} — adjust your fingers`
      : position === 'away' ? `shape is ${target} — move your left hand onto the fretboard`
      : position === 'off' ? `shape is ${target} — put your fingers on the dots`
      : `✓ ${target} in position — strum now`;
    seen.classList.toggle('ok', ok);
  }

  // ---------------------------------------------------------------- self-test runner (V key / ?selftest=1)
  async function selfTest() {
    document.title = 'RUNNING';           // headless-run.js polls the title
    showPanel(null, ['running…']);
    const results = [];
    const safe = (name, fn) => { try { results.push(fn()); } catch (e) { results.push({ pass: false, lines: [name + ' FAILED — ' + (e && e.message || e)] }); } };
    safe('V1', () => Tuning.selfTest());
    safe('V4', () => Strum.selfTest());
    safe('V8', () => Chord.selfTest());
    safe('V9', () => Songs.selfTest());
    safe('V10', () => Anchor.selfTest());
    safe('V11', () => Annot.selfTest());
    try { results.push(await AudioEngine.selfTestV2()); }
    catch (e) { results.push({ pass: false, lines: ['V2 PITCH FAILED — ' + (e && e.message || e)] }); }
    const pass = results.every(r => r.pass);
    const lines = results.flatMap(r => [...r.lines, '']);
    showPanel(pass, lines);
    $('out').textContent = (pass ? 'ALL CHECKS PASS\n' : 'CHECKS FAILED\n') + lines.join('\n');
    document.title = (pass ? 'PASS ' : 'FAIL ') + 'Air Ukulele';
    return pass;
  }

  function showPanel(pass, lines) {
    el.panel.classList.add('on');
    const banner = pass === null ? '' : `<div class="banner ${pass ? 'pass' : 'fail'}">${pass ? 'ALL CHECKS PASS' : 'CHECKS FAILED'}</div>`;
    el.panelBody.innerHTML = banner + '<pre>' + lines.map(esc).join('\n') + '</pre>';
  }
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ---------------------------------------------------------------- input: keyboard + mouse
  const CHORD_KEYS = { q: 'C', w: 'G', e: 'Am', r: 'F' };
  window.addEventListener('keydown', ev => {
    if (ev.repeat) return;
    const k = ev.key.toLowerCase();
    if (k === 'v') { if (el.panel.classList.contains('on')) el.panel.classList.remove('on'); else selfTest(); return; }
    if (k === 'escape') { el.panel.classList.remove('on'); return; }
    if (k === 'd') { state.debug = !state.debug; el.debug.classList.toggle('on', state.debug); return; }
    if (ev.key === '?' || k === '/') { state.helpOn = !state.helpOn; el.help.classList.toggle('on', state.helpOn); $('stage').classList.toggle('help-on', state.helpOn); return; }
    if (!state.started) return;
    if (k >= '1' && k <= '4') { firePlucks([{ string: 4 - Number(k), velocity: 0.8, when: AudioEngine.now() }]); }  // 4 = G top, 1 = A bottom
    else if (k === ' ') { ev.preventDefault(); strumChord(ev.shiftKey ? -1 : +1); }
    else if (CHORD_KEYS[k]) { state.keyboardChord = CHORD_KEYS[k]; applyChord(CHORD_KEYS[k]); }
    else if (k === 'o') { state.keyboardChord = null; applyChord(state.chord || 'open'); }
    else if (k === 'k') { calibrate(); }
    else if (k === 's') { toggleSong(); }
    else if (k === 'm' && state.song) { const m = state.song.state().mode === 'practice' ? 'playalong' : 'practice'; state.song.setMode(m); state.song.start(performance.now()); setStatus('song mode: ' + m); }
    else if (k === 'n' && state.song) { state.song.skip(+1); }
    else if (k === 'b') {
      if (!state.cameraOn) { setStatus('cap anchor needs the camera'); return; }
      if (state.anchorOn) { state.anchorOn = false; state.anchorArmed = false; setStatus('cap anchor off — instrument stays where it is'); }
      else { state.anchorArmed = true; setStatus('click on your blue pen cap…'); }
    }
    else if (k === 'c') {
      if (state.fretting && state.strumming) { UkeFrame.recenter(state.fretting.landmarks[0], state.strumming.landmarks[8]); state.framePinned = true; rebuildDetector(); setStatus('recentred'); }
    }
  });
  // Shift+R clears calibration only with Shift to avoid accidents
  window.addEventListener('keydown', ev => { if (ev.key === 'R' && ev.shiftKey) { Chord.calib.clear(); voter.reset(); setStatus('calibration cleared — rules mode'); } });

  // Mouse: armed → sample the cap colour; otherwise a primary-button drag = strumming fingertip through
  // the same detector. The drag ends on ANY of pointerup / pointercancel / lost capture / window blur /
  // button no longer held, so a stuck "down" can never turn hovering into strumming.
  let mouseDown = false;
  const endDrag = () => { if (mouseDown && detector) detector.reset(); mouseDown = false; };
  overlay.addEventListener('pointerdown', ev => {
    if (state.anchorArmed) {
      const img = Anchor.sampleFrame(video, Anchor.params.scanW, Anchor.params.scanH);
      if (!img) { setStatus('no video frame yet'); return; }
      // Undo the cover-crop to get video-normalised coords (mirrored) for the sampler
      const cm = coverMap();
      const vw = video.videoWidth, vh = video.videoHeight, sw = overlay.clientWidth, sh = overlay.clientHeight;
      const s = Math.max(sw / vw, sh / vh), dw = vw * s, dh = vh * s, ox = (sw - dw) / 2, oy = (sh - dh) / 2;
      const nx = (ev.clientX - ox) / dw, ny = (ev.clientY - oy) / dh;
      const hsv = Anchor.sampleColorAt(img, nx, ny, 2);
      Anchor.setTarget(hsv); Anchor.save();
      anchorTracker.reset();
      state.anchorArmed = false; state.anchorOn = true;
      setStatus(`cap colour sampled (hue ${hsv.h.toFixed(0)}°) — instrument now follows the cap · B to stop`);
      return;
    }
    if (ev.button !== 0 || !ev.isPrimary) return;          // left button only; no right-click / second touch
    mouseDown = true; detector && detector.reset();
    try { overlay.setPointerCapture(ev.pointerId); } catch (_) { /* not all pointers support capture */ }
  });
  window.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);
  overlay.addEventListener('lostpointercapture', endDrag);
  window.addEventListener('blur', endDrag);
  document.addEventListener('visibilitychange', () => { if (document.hidden) endDrag(); });
  overlay.addEventListener('pointermove', ev => {
    if (!mouseDown || !detector) return;
    if (!(ev.buttons & 1)) { endDrag(); return; }           // button released without us hearing about it
    const local = UkeFrame.toLocal({ x: ev.clientX / overlay.clientWidth, y: ev.clientY / overlay.clientHeight });
    const plucks = detector.push({ x: local.x, y: local.y, t: performance.now() });
    if (plucks.length) firePlucks(Strum.schedule(plucks, AudioEngine.now(), performance.now()));
  });

  // ---------------------------------------------------------------- boot
  el.startBtn.addEventListener('click', start);
  if (location.protocol === 'file:') el.startNote.textContent = 'Running from file:// — hand tracker loads from the internet. For offline use run run.bat.';
  Chord.calib.load();
  Anchor.load();
  if (new URLSearchParams(location.search).get('selftest') === '1') {
    // Self-test needs no camera and no user gesture (OfflineAudioContext).
    el.start.style.display = 'none';
    selfTest();
  }
  // onTrack / soundingChord / coverMap are exposed so a headless smoke test can drive the live path with synthetic hands.
  return { state, start, selfTest, calibrate, toggleSong, updateSongHint, onTrack, soundingChord, coverMap };
})();
