// ============================================================================
// songs/  — learn-a-song: chord charts (no lyrics), practice/play-along session
//           engine (pure, time passed in), and the bottom-strip renderer.
// Depends on global Tuning (src/tuning.js). Pure parts run in node.
// ============================================================================
const Songs = (() => {
  // --------------------------------------------------------------- song data
  // Chord charts only. Chord progressions are not copyrightable; lyrics are, so
  // none appear here. Beats are 4/4 quarter notes; each bar entry = one chord.
  const RASPUTIN_SECTIONS = {
    intro:  [{ chord: 'Am', beats: 4 }, { chord: 'Am', beats: 4 }, { chord: 'F', beats: 4 }, { chord: 'G', beats: 2 }, { chord: 'Am', beats: 2 }],
    // original A / E7 replaced by Am / G so the song stays inside the four recognised chords
    hey:    [{ chord: 'Am', beats: 4 }, { chord: 'Am', beats: 4 }, { chord: 'Am', beats: 2 }, { chord: 'G', beats: 2 }, { chord: 'F', beats: 2 }, { chord: 'G', beats: 2 }],
    // original Dm → F, E7 → G
    verse:  [{ chord: 'Am', beats: 8 }, { chord: 'F', beats: 4 }, { chord: 'G', beats: 2 }, { chord: 'Am', beats: 2 }],
    chorus: [{ chord: 'Am', beats: 2 }, { chord: 'C', beats: 2 }, { chord: 'F', beats: 2 }, { chord: 'Am', beats: 2 }, { chord: 'G', beats: 2 }, { chord: 'F', beats: 2 }, { chord: 'Am', beats: 4 }],
    bridge: [{ chord: 'Am', beats: 4 }, { chord: 'G', beats: 4 }, { chord: 'F', beats: 4 }, { chord: 'G', beats: 4 }, { chord: 'Am', beats: 4 }],
    outro:  [{ chord: 'Am', beats: 8 }],
  };
  const sec = (name, repeat) => ({ name, repeat, bars: RASPUTIN_SECTIONS[name].map(b => ({ ...b })) });

  const SONGS = [
    {
      id: 'rasputin',
      title: 'Rasputin',
      artist: 'Boney M.',
      note: 'as heard in Dhurandhar: The Revenge · simplified to C G Am F',
      bpm: 126,                       // the record sits around 126 BPM
      strum: 'D DU D DU',
      sections: [
        sec('intro', 2), sec('hey', 2), sec('verse', 4), sec('chorus', 2),
        sec('verse', 4), sec('chorus', 2), sec('bridge', 2), sec('chorus', 2), sec('outro', 1),
      ],
    },
    {
      id: 'four-chord-loop',
      title: 'Four-chord loop (C G Am F)',
      artist: 'warm-up',
      note: 'the I–V–vi–IV loop behind hundreds of pop songs',
      bpm: 100,
      strum: 'D DU UDU',
      sections: [{ name: 'loop', repeat: 4, bars: [{ chord: 'C', beats: 4 }, { chord: 'G', beats: 4 }, { chord: 'Am', beats: 4 }, { chord: 'F', beats: 4 }] }],
    },
  ];

  const list = () => SONGS;
  const get = id => SONGS.find(s => s.id === id) || null;

  // Expand repeats into a linear list of entries (one chord for N beats each).
  function flatten(song) {
    const out = [];
    song.sections.forEach((s, sectionIndex) => {
      for (let r = 0; r < s.repeat; r++) {
        s.bars.forEach((b, barIndex) => {
          out.push({ chord: b.chord, beats: b.beats, section: s.name, sectionIndex, repeat: r, barIndex });
        });
      }
    });
    return out;
  }

  // --------------------------------------------------------------- session engine
  const STRUM_DEBOUNCE_MS = 150;   // a 4-string rake spans ≤ 80 ms; anything closer is the same strum

  function createSession(song, opts) {
    opts = opts || {};
    const entries = flatten(song);
    const total = entries.length;
    // cumulative beat offsets for play-along
    const cum = new Array(total + 1); cum[0] = 0;
    for (let i = 0; i < total; i++) cum[i + 1] = cum[i] + entries[i].beats;

    let mode = opts.mode === 'playalong' ? 'playalong' : 'practice';
    let bpm = opts.bpm || song.bpm || 120;
    let index = 0, correct = 0, attempted = 0, done = false;
    let lastStrumMs = -Infinity;
    let startMs = null, lastBeat = -1, lastIndex = -1;
    let markedIndex = -1;            // play-along: entry already credited

    function reset() {
      index = 0; correct = 0; attempted = 0; done = false;
      lastStrumMs = -Infinity; startMs = null; lastBeat = -1; lastIndex = -1; markedIndex = -1;
    }
    function start(nowMs) { reset(); startMs = nowMs; }
    function setMode(m) { mode = m === 'playalong' ? 'playalong' : 'practice'; reset(); }
    function setBpm(b) { if (b > 0) bpm = b; }
    function skip(d) {
      if (mode === 'playalong' && startMs != null) {
        // shift the start time so the clock lands at the beginning of the target entry
        const target = Math.max(0, Math.min(total - 1, index + d));
        const beatMs = 60000 / bpm;
        startMs += (cum[index] - cum[target]) * beatMs;
        return;
      }
      index = Math.max(0, Math.min(total, index + d));
      done = index >= total;
    }

    function onStrum(chord, nowMs) {
      nowMs = nowMs == null ? 0 : nowMs;
      if (done) return { advanced: false, correct: false };
      if (nowMs - lastStrumMs < STRUM_DEBOUNCE_MS) return { advanced: false, correct: false };
      lastStrumMs = nowMs;
      const ok = chord === entries[index].chord;
      if (mode === 'practice') {
        attempted++;
        if (ok) { correct++; index++; if (index >= total) done = true; }
        return { advanced: ok, correct: ok };
      }
      // play-along: credit the current entry once
      if (ok && markedIndex !== index) { markedIndex = index; correct++; }
      return { advanced: false, correct: ok };
    }

    // play-along clock. Returns {beat, bar, index}.
    function tick(nowMs) {
      if (mode !== 'playalong' || startMs == null || done) return { beat: false, bar: false, index };
      const beatMs = 60000 / bpm;
      const elapsedBeats = (nowMs - startMs) / beatMs;
      const beatNo = Math.floor(elapsedBeats);
      let i = index;
      while (i < total && elapsedBeats >= cum[i + 1]) i++;
      const bar = i !== lastIndex;
      const beat = beatNo !== lastBeat;
      lastBeat = beatNo; lastIndex = i;
      index = i;
      if (index >= total) { done = true; index = total; }
      return { beat, bar, index };
    }

    function state() {
      const cur = index < total ? entries[index] : null;
      let att = attempted, pct;
      if (mode === 'playalong') {
        att = done ? total : Math.min(total, index + (startMs == null ? 0 : 1));
      }
      pct = att > 0 ? Math.round(100 * correct / att) : 0;
      let beatInBar = null;
      if (mode === 'playalong' && startMs != null && cur) {
        const elapsedBeats = (lastBeatTime() - startMs) / (60000 / bpm);
        beatInBar = Math.max(0, Math.floor(elapsedBeats - cum[index]));
      }
      return {
        index, total, current: cur, upcoming: entries.slice(index + 1, index + 5),
        done, score: { correct, attempted: att, percent: pct }, mode, bpm, beatInBar,
        title: song.title, artist: song.artist, note: song.note, strum: song.strum,
      };
    }
    // last tick time is not stored explicitly; reconstruct from lastBeat for the HUD
    function lastBeatTime() { return startMs + (lastBeat < 0 ? 0 : lastBeat) * (60000 / bpm); }

    return { state, onStrum, tick, start, reset, setMode, setBpm, skip, entries, song };
  }

  // --------------------------------------------------------------- renderer
  const CSS = `
    #song { position:absolute; left:0; right:0; bottom:0; height:150px; z-index:6; display:none;
            background:linear-gradient(180deg, rgba(0,0,0,.55), rgba(0,0,0,.88)); color:#f4f4f4;
            font:14px/1.35 system-ui, Segoe UI, sans-serif; box-sizing:border-box; padding:14px 20px; }
    #song.on { display:grid; grid-template-columns: 1fr auto 1fr; align-items:center; gap:24px; }
    #song .sg-left { min-width:0; }
    #song .sg-title { font-size:18px; font-weight:700; }
    #song .sg-artist { color:rgba(255,255,255,.6); }
    #song .sg-note { color:rgba(255,255,255,.45); font-size:12px; margin-top:4px; }
    #song .sg-meta { margin-top:8px; color:rgba(255,255,255,.7); font-size:12px; }
    #song .sg-meta b { color:#f4f4f4; }
    #song .sg-centre { text-align:center; min-width:180px; }
    #song .sg-target { font-size:64px; font-weight:800; line-height:1; letter-spacing:-1px; color:#ffb74d; transition:color .08s; }
    #song .sg-target.match { color:#37d67a; }
    #song .sg-sub { color:rgba(255,255,255,.6); font-size:12px; margin-top:6px; }
    #song .sg-right { text-align:right; min-width:0; }
    #song .sg-next { display:flex; justify-content:flex-end; gap:10px; }
    #song .sg-next span { display:inline-block; min-width:44px; padding:6px 8px; border-radius:6px;
                          background:rgba(255,255,255,.1); font-size:20px; font-weight:600; text-align:center; }
    #song .sg-next span:first-child { background:rgba(255,255,255,.2); }
    #song .sg-strum { margin-top:8px; font:600 13px ui-monospace, Consolas, monospace; letter-spacing:2px; color:rgba(255,255,255,.75); }
    #song .sg-progress { margin-top:4px; color:rgba(255,255,255,.6); font-size:12px; }
    #song .sg-done { font-size:26px; font-weight:700; color:#37d67a; }
  `;
  let cssInjected = false;

  function build(el) {
    if (!cssInjected && typeof document !== 'undefined') {
      const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); cssInjected = true;
    }
    el.innerHTML =
      '<div class="sg-left"><div class="sg-title"></div><div class="sg-artist"></div><div class="sg-note"></div><div class="sg-meta"></div></div>' +
      '<div class="sg-centre"><div class="sg-target"></div><div class="sg-sub"></div></div>' +
      '<div class="sg-right"><div class="sg-next"></div><div class="sg-strum"></div><div class="sg-progress"></div></div>';
    const q = c => el.querySelector('.' + c);
    const ui = {
      title: q('sg-title'), artist: q('sg-artist'), note: q('sg-note'), meta: q('sg-meta'),
      target: q('sg-target'), sub: q('sg-sub'), next: q('sg-next'), strum: q('sg-strum'), progress: q('sg-progress'),
      nextSpans: [], last: {},
    };
    for (let i = 0; i < 4; i++) { const s = document.createElement('span'); ui.next.appendChild(s); ui.nextSpans.push(s); }
    el._songUI = ui;
    return ui;
  }
  const setText = (node, key, ui, text) => { if (ui.last[key] !== text) { node.textContent = text; ui.last[key] = text; } };

  function render(el, session, opts) {
    if (!el) return;
    const ui = el._songUI || build(el);
    const s = session.state();
    const rec = opts && opts.recognisedChord;
    setText(ui.title, 'title', ui, s.title);
    setText(ui.artist, 'artist', ui, s.artist || '');
    setText(ui.note, 'note', ui, s.note || '');
    const modeTxt = s.mode === 'practice' ? 'practice · strum the right chord to advance' : 'play-along · metronome at tempo';
    const metaTxt = `${modeTxt} · ${s.bpm} BPM · M toggles mode · S closes`;
    if (ui.last.meta !== metaTxt) { ui.meta.innerHTML = `<b>${s.mode === 'practice' ? 'Practice' : 'Play-along'}</b>${metaTxt.slice(s.mode === 'practice' ? 8 : 10)}`; ui.last.meta = metaTxt; }

    if (s.done) {
      setText(ui.target, 'target', ui, 'Done');
      ui.target.classList.remove('match');
      setText(ui.sub, 'sub', ui, `Song complete · ${s.score.percent}% correct · press S to restart`);
      ui.sub.className = 'sg-sub sg-done';
      ui.nextSpans.forEach(sp => { sp.textContent = ''; });
      setText(ui.progress, 'progress', ui, `bar ${s.total} / ${s.total} · ${s.score.percent}% correct`);
      return;
    }
    ui.sub.className = 'sg-sub';
    const cur = s.current;
    setText(ui.target, 'target', ui, cur.chord === 'open' ? 'open' : cur.chord);
    const match = rec === cur.chord;
    if (ui.last.match !== match) { ui.target.classList.toggle('match', match); ui.last.match = match; }
    const beatTxt = s.mode === 'playalong' && s.beatInBar != null ? ` · beat ${Math.min(cur.beats, s.beatInBar + 1)}/${cur.beats}` : ` · ${cur.beats} beats`;
    setText(ui.sub, 'sub', ui, `${cur.section}${beatTxt}`);
    for (let i = 0; i < 4; i++) {
      const n = s.upcoming[i];
      const t = n ? n.chord : '';
      if (ui.last['next' + i] !== t) { ui.nextSpans[i].textContent = t; ui.nextSpans[i].style.visibility = t ? 'visible' : 'hidden'; ui.last['next' + i] = t; }
    }
    setText(ui.strum, 'strum', ui, s.strum || '');
    setText(ui.progress, 'progress', ui, `bar ${s.index + 1} / ${s.total} · ${s.score.percent}% correct`);
  }

  // --------------------------------------------------------------- V9 self-test
  function selfTest() {
    const lines = [];
    let pass = true;
    const check = (ok, msg) => { if (!ok) pass = false; lines.push((ok ? 'PASS ' : 'FAIL ') + msg); };

    for (const song of SONGS) {
      const flat = flatten(song);
      const chords = new Set(flat.map(e => e.chord));
      const unknown = [...chords].filter(c => !Tuning.CHORDS[c]);
      check(unknown.length === 0, `${song.id}: every chord in Tuning.CHORDS (${[...chords].join(' ')})${unknown.length ? ' unknown: ' + unknown.join(' ') : ''}`);
      for (const s of song.sections) {
        const beats = s.bars.reduce((a, b) => a + b.beats, 0);
        check(beats % 4 === 0, `${song.id}/${s.name}: ${beats} beats is a multiple of 4`);
      }
      const expectLen = song.sections.reduce((a, s) => a + s.repeat * s.bars.length, 0);
      check(flat.length === expectLen, `${song.id}: flatten length ${flat.length} = Σ repeat×bars ${expectLen}`);

      // practice: wrong chord never advances; exactly flat.length correct strums finish it
      const p = createSession(song, { mode: 'practice' });
      let t = 0, wrongAdvanced = false, strums = 0;
      for (let i = 0; i < flat.length; i++) {
        const wrong = flat[i].chord === 'C' ? 'G' : 'C';
        t += 200; const r1 = p.onStrum(wrong, t); if (r1.advanced) wrongAdvanced = true;
        t += 50;  const rd = p.onStrum(flat[i].chord, t);       // inside 150 ms debounce → ignored
        if (rd.advanced) wrongAdvanced = true;
        t += 200; const r2 = p.onStrum(flat[i].chord, t); strums++;
        if (!r2.advanced) { pass = false; lines.push(`FAIL ${song.id}: correct strum at entry ${i} did not advance`); break; }
      }
      const ps = p.state();
      check(!wrongAdvanced, `${song.id}: wrong-chord and debounced strums never advance`);
      check(ps.done && ps.index === flat.length, `${song.id}: done after ${strums} correct strums (index ${ps.index}/${flat.length})`);
      check(ps.score.correct === flat.length && ps.score.attempted === 2 * flat.length && ps.score.percent === 50,
        `${song.id}: practice score ${ps.score.correct}/${ps.score.attempted} = ${ps.score.percent}%`);

      // play-along at 120 BPM: bar boundaries at cumulative beats × 500 ms
      const pa = createSession(song, { mode: 'playalong', bpm: 120 });
      pa.start(1000);
      let cumBeats = 0, expectedTimes = flat.map(e => { const tt = 1000 + cumBeats * 500; cumBeats += e.beats; return tt; });
      const totalMs = cumBeats * 500;
      const barTimes = [];
      let credited = 0;
      for (let now = 1000; now <= 1000 + totalMs + 20; now += 10) {
        const r = pa.tick(now);
        if (r.bar && r.index < flat.length) barTimes.push({ index: r.index, now });
        if (r.bar && r.index < flat.length) { pa.onStrum(flat[r.index].chord, now); credited++; }
      }
      let timingOk = barTimes.length === flat.length;
      for (const b of barTimes) if (Math.abs(b.now - expectedTimes[b.index]) > 10) timingOk = false;
      check(timingOk, `${song.id}: play-along bar starts at cumulative beats×500 ms (${barTimes.length}/${flat.length} bars, ≤10 ms)`);
      const pas = pa.state();
      check(pas.done && pas.score.correct === flat.length && pas.score.percent === 100,
        `${song.id}: play-along finished, score ${pas.score.correct}/${pas.score.attempted} = ${pas.score.percent}%`);
      // second strum on the same entry must not double-credit
      const pb = createSession(song, { mode: 'playalong', bpm: 120 }); pb.start(0); pb.tick(0);
      pb.onStrum(flat[0].chord, 0); pb.onStrum(flat[0].chord, 400);
      check(pb.state().score.correct === 1, `${song.id}: play-along credits an entry once (${pb.state().score.correct})`);
    }
    lines.unshift(pass ? 'V9 SONGS OK' : 'V9 SONGS FAILED');
    return { pass, lines };
  }

  return { list, get, flatten, createSession, render, selfTest, STRUM_DEBOUNCE_MS };
})();

if (typeof module !== 'undefined') module.exports = { Songs };
