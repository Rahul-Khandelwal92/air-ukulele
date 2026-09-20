// ============================================================================
// chord/  — recognise which ukulele chord the fretting hand is shaping
// Pure functions. No DOM except localStorage inside calib.save/load (guarded).
// Depends on the global `Tuning` (src/tuning.js) for the chord name list.
//
// Input: `landmarks` = 21 × {x,y,z}, MediaPipe hand topology, normalised image
// coords (x may be mirrored, y grows downward). Everything here works in a
// hand-normalised frame so screen position, scale, rotation and chirality
// never reach the classifier.
// ============================================================================
const Chord = (() => {
  // ---- landmark indices (MediaPipe) -----------------------------------------
  const WRIST = 0;
  const THUMB = [1, 2, 3, 4];             // CMC, MCP, IP, TIP
  const FINGERS = {                       // MCP, PIP, DIP, TIP
    index:  [5, 6, 7, 8],
    middle: [9, 10, 11, 12],
    ring:   [13, 14, 15, 16],
    pinky:  [17, 18, 19, 20],
  };
  const FINGER_NAMES = ['index', 'middle', 'ring', 'pinky'];
  const MIDDLE_MCP = 9;

  // ---- tunable parameters (debug HUD may edit these live) -------------------
  const params = {
    // dist(tip,wrist)/dist(mcp,wrist): a straight finger reaches ~1.8–1.9× the
    // MCP distance; a fully folded finger's tip sits at ~1.0× (level with the
    // knuckle) or closer. curl maps that ratio linearly onto [0,1].
    extRatio: 1.8,
    curlRatio: 1.0,
    // a finger counts as DOWN (fretting) above this curl (centre of the band)
    downThreshold: 0.35,
    // Hysteresis half-width: a finger flips to DOWN only above thr+hyst (0.40) and back
    // to UP only below thr-hyst (0.30). Inside the band it keeps its previous state, so a
    // fingertip hovering at the threshold cannot flicker the chord frame to frame.
    hysteresis: 0.05,
    // per-dimension std floor for the calibrated classifier (normalised units)
    stdFloor: 0.02,
  };

  // ---- small vector helpers -------------------------------------------------
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

  // ---- hand-normalised frame ------------------------------------------------
  // 1. translate wrist → origin
  // 2. rotate so wrist→middle-MCP points along +y
  // 3. scale so that distance is 1
  // 4. reflect x so the thumb is on the negative-x side (chirality/mirror-proof)
  function normalize(lm) {
    const w = lm[WRIST], m = lm[MIDDLE_MCP];
    const dx = m.x - w.x, dy = m.y - w.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    // rotation taking (dx,dy) → (0,len): angle from +y axis
    const c = dy / len, s = dx / len;     // cos, sin of the rotation
    const out = new Float32Array(63);
    for (let i = 0; i < 21; i++) {
      const px = lm[i].x - w.x, py = lm[i].y - w.y;
      // rotate by -θ where θ = atan2(dx, dy): x' = px·c − py·s ; y' = px·s + py·c
      out[i * 3]     = (px * c - py * s) / len;
      out[i * 3 + 1] = (px * s + py * c) / len;
      out[i * 3 + 2] = ((lm[i].z || 0) - (w.z || 0)) / len;
    }
    // chirality: mean thumb x must be negative
    let tx = 0;
    for (const t of THUMB) tx += out[t * 3];
    if (tx > 0) for (let i = 0; i < 21; i++) out[i * 3] = -out[i * 3];
    return out;
  }

  // ---- finger curl ----------------------------------------------------------
  function curls(lm) {
    const w = lm[WRIST];
    const res = {};
    for (const f of FINGER_NAMES) {
      const [mcp, , , tip] = FINGERS[f];
      const ratio = dist(lm[tip], w) / (dist(lm[mcp], w) || 1e-9);
      res[f] = clamp01((params.extRatio - ratio) / (params.extRatio - params.curlRatio));
    }
    return res;
  }

  // ---- rule classifier ------------------------------------------------------
  // down-finger pattern (index,middle,ring,pinky) → chord. Mirrors the real
  // fretting fingers of each shape; players exaggerate on camera.
  const RULES = [
    { down: [0, 0, 0, 0], chord: 'open' },
    { down: [0, 0, 1, 0], chord: 'C' },     // ring on A string, 3rd fret
    { down: [0, 1, 0, 0], chord: 'Am' },    // middle on G string, 2nd fret
    { down: [1, 1, 0, 0], chord: 'F' },     // index E/1, middle G/2
    { down: [1, 1, 1, 0], chord: 'G' },     // index, middle, ring
    { down: [1, 1, 1, 1], chord: 'mute' },
  ];

  // prevDown: previous frame's down flags [index,middle,ring,pinky] (0/1) or null.
  // With no history the centre threshold decides; with history the band applies.
  function fingerDown(curl, prev) {
    const thr = params.downThreshold, h = params.hysteresis;
    if (prev == null) return curl > thr ? 1 : 0;
    if (curl > thr + h) return 1;
    if (curl < thr - h) return 0;
    return prev ? 1 : 0;
  }
  function classifyRules(c, prevDown = null) {
    const thr = params.downThreshold, h = params.hysteresis;
    const down = FINGER_NAMES.map((f, i) => fingerDown(c[f], prevDown ? prevDown[i] : null));
    // confidence = how far the least certain finger sits outside the hysteresis band,
    // mapped so a finger at curl 0 or 0.7+ reads 1 and a finger inside the band reads 0.
    let conf = 1;
    for (const f of FINGER_NAMES) {
      const d = Math.max(0, Math.abs(c[f] - thr) - h);
      conf = Math.min(conf, d / (thr - h));
    }
    conf = clamp01(conf);
    for (const r of RULES) {
      if (r.down.every((d, i) => d === down[i])) return { chord: r.chord, confidence: conf, down };
    }
    return { chord: null, confidence: 0, down };
  }

  // ---- calibration store ----------------------------------------------------
  const STORAGE_KEY = 'uke.calib.v1';

  function stats(frames) {
    const n = frames.length, d = 63;
    const centroid = new Float64Array(d), std = new Float64Array(d);
    for (const fr of frames) for (let i = 0; i < d; i++) centroid[i] += fr[i];
    for (let i = 0; i < d; i++) centroid[i] /= n;
    for (const fr of frames) for (let i = 0; i < d; i++) std[i] += (fr[i] - centroid[i]) ** 2;
    for (let i = 0; i < d; i++) std[i] = Math.max(params.stdFloor, Math.sqrt(std[i] / Math.max(1, n - 1)));
    return { centroid, std };
  }

  function stdDist(v, model) {
    let s = 0;
    for (let i = 0; i < 63; i++) { const t = (v[i] - model.centroid[i]) / model.std[i]; s += t * t; }
    return Math.sqrt(s);
  }

  // nearest centroid over a {label: {centroid,std}} map
  function nearest(v, models) {
    let best = null, dBest = Infinity, dSecond = Infinity;
    for (const label of Object.keys(models)) {
      const d = stdDist(v, models[label]);
      if (d < dBest) { dSecond = dBest; dBest = d; best = label; }
      else if (d < dSecond) dSecond = d;
    }
    const confidence = isFinite(dSecond) && dSecond > 0 ? clamp01(1 - dBest / dSecond) : 0;
    return { chord: best, confidence };
  }

  function createCalib() {
    const data = {};          // label → { frames: number[][], centroid, std }
    let capturing = null;     // { label, frames }

    const api = {
      begin(label) { capturing = { label, frames: [] }; },
      addFrame(lm) { if (capturing) capturing.frames.push(Array.from(normalize(lm))); },
      end() {
        if (!capturing) return null;
        const { label, frames } = capturing;
        capturing = null;
        if (frames.length < 2) return null;
        const st = stats(frames);
        data[label] = { frames, centroid: Array.from(st.centroid), std: Array.from(st.std) };
        return { label, count: frames.length };
      },
      has() { return Object.keys(data).length >= 2; },
      labels() { return Object.keys(data); },
      frames(label) { return data[label] ? data[label].frames : []; },
      models() {
        const m = {};
        for (const l of Object.keys(data)) m[l] = { centroid: data[l].centroid, std: data[l].std };
        return m;
      },
      clear() { for (const k of Object.keys(data)) delete data[k]; capturing = null; },
      save() {
        if (typeof localStorage === 'undefined') return false;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, data }));
        return true;
      },
      load() {
        if (typeof localStorage === 'undefined') return false;
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || parsed.v !== 1) return false;
          api.clear();
          for (const l of Object.keys(parsed.data)) data[l] = parsed.data[l];
          return true;
        } catch (e) { return false; }
      },
      // leave-one-out over all stored frames → { accuracy, matrix, labels, total }
      leaveOneOut() {
        const labels = Object.keys(data);
        const idx = Object.fromEntries(labels.map((l, i) => [l, i]));
        const matrix = labels.map(() => labels.map(() => 0));
        let correct = 0, total = 0;
        for (const l of labels) {
          const frames = data[l].frames;
          for (let k = 0; k < frames.length; k++) {
            const models = api.models();
            const rest = frames.filter((_, j) => j !== k);
            if (rest.length >= 2) {
              const st = stats(rest);
              models[l] = { centroid: st.centroid, std: st.std };
            }
            const pred = nearest(frames[k], models).chord;
            matrix[idx[l]][idx[pred]]++;
            if (pred === l) correct++;
            total++;
          }
        }
        return { accuracy: total ? correct / total : 0, matrix, labels, total };
      },
    };
    return api;
  }

  const calib = createCalib();

  function classifyCalibrated(lm, store = calib) {
    if (!store.has()) return { chord: null, confidence: 0 };
    return nearest(normalize(lm), store.models());
  }

  // prevDown: the `down` array returned by the previous call (rules hysteresis); pass null to reset.
  function classify(lm, store = calib, prevDown = null) {
    const c = curls(lm);
    if (store.has()) {
      const r = classifyCalibrated(lm, store);
      return { chord: r.chord, confidence: r.confidence, curls: c, method: 'calib', down: null };
    }
    const r = classifyRules(c, prevDown);
    return { chord: r.chord, confidence: r.confidence, curls: c, method: 'rules', down: r.down };
  }

  // ---- temporal voter -------------------------------------------------------
  function createVoter({ window = 5, minVotes = 3, minConfidence = 0.5 } = {}) {
    const buf = [];
    let current = null, currentConf = 0;
    function tally() {
      const votes = {}, confs = {};
      for (const r of buf) {
        if (!r || !r.chord) continue;
        votes[r.chord] = (votes[r.chord] || 0) + 1;
        confs[r.chord] = (confs[r.chord] || 0) + (r.confidence || 0);
      }
      let winner = null, n = 0;
      for (const k of Object.keys(votes)) if (votes[k] > n) { n = votes[k]; winner = k; }
      return { winner, n, meanConf: winner ? confs[winner] / n : 0, votes, confs };
    }
    return {
      push(result) {
        buf.push(result || { chord: null, confidence: 0 });
        if (buf.length > window) buf.shift();
        const t = tally();
        if (t.winner && t.winner !== current && t.n >= minVotes && t.meanConf >= minConfidence) {
          current = t.winner;
        }
        if (current && t.votes[current]) currentConf = t.confs[current] / t.votes[current];
        const stable = !!current && (t.votes[current] || 0) >= minVotes;
        return { chord: current, confidence: currentConf, stable };
      },
      current() { return { chord: current, confidence: currentConf }; },
      reset() { buf.length = 0; current = null; currentConf = 0; },
    };
  }

  // ---- synthetic hand (for V8 and demos) ------------------------------------
  // Built in a local frame (x right, y up, thumb on −x), then mapped to image
  // coords with the wrist at (0.5, 0.8) and y flipped (image y grows downward).
  function syntheticHand(down = {}, opts = {}) {
    const scale = opts.scale || 1;
    const mcps = { index: [-0.07, 0.19], middle: [0, 0.20], ring: [0.06, 0.19], pinky: [0.11, 0.17] };
    const local = new Array(21);
    local[WRIST] = [0, 0, 0];
    // thumb, angled out on the −x side
    local[1] = [-0.06, 0.05, 0]; local[2] = [-0.11, 0.10, 0]; local[3] = [-0.15, 0.14, 0]; local[4] = [-0.18, 0.17, 0];
    for (const f of FINGER_NAMES) {
      const [mx, my] = mcps[f];
      const d = Math.hypot(mx, my), ux = mx / d, uy = my / d;
      const [iM, iP, iD, iT] = FINGERS[f];
      local[iM] = [mx, my, 0];
      if (down[f]) {
        // folded: PIP a little past the knuckle, DIP/TIP curl back toward the palm
        local[iP] = [ux * d * 1.25, uy * d * 1.25, -0.02];
        local[iD] = [ux * d * 1.15, uy * d * 1.15, -0.06];
        local[iT] = [ux * d * 0.95, uy * d * 0.95, -0.07];
      } else {
        local[iP] = [ux * d * 1.30, uy * d * 1.30, 0];
        local[iD] = [ux * d * 1.60, uy * d * 1.60, 0];
        local[iT] = [ux * d * 1.90, uy * d * 1.90, 0];
      }
    }
    return local.map(([x, y, z]) => ({ x: 0.5 + x * scale, y: 0.8 - y * scale, z: z * scale }));
  }

  // rotate landmarks about the wrist by `deg` in image coords
  function rotateHand(lm, deg) {
    const w = lm[WRIST], a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return lm.map(p => ({
      x: w.x + (p.x - w.x) * c - (p.y - w.y) * s,
      y: w.y + (p.x - w.x) * s + (p.y - w.y) * c,
      z: p.z,
    }));
  }
  const mirrorHand = lm => lm.map(p => ({ x: 1 - p.x, y: p.y, z: p.z }));

  const LABEL_DOWN = {
    open: {}, C: { ring: true }, Am: { middle: true },
    F: { index: true, middle: true }, G: { index: true, middle: true, ring: true },
    mute: { index: true, middle: true, ring: true, pinky: true },
  };

  // ---- V8 self-test ---------------------------------------------------------
  function selfTest(opts = {}) {
    const lines = [];
    let pass = true;
    const fmt = c => FINGER_NAMES.map(f => `${f[0]}=${c[f].toFixed(2)}`).join(' ');

    // (a) rule table on synthetic hands
    for (const r of RULES) {
      const down = Object.fromEntries(FINGER_NAMES.map((f, i) => [f, !!r.down[i]]));
      const lm = syntheticHand(down);
      const c = curls(lm);
      const res = classifyRules(c);
      const ok = res.chord === r.chord;
      if (!ok) pass = false;
      lines.push(`${ok ? 'PASS' : 'FAIL'} rules ${r.chord.padEnd(4)} → ${String(res.chord).padEnd(4)} conf ${res.confidence.toFixed(2)}  [${fmt(c)}]`);
    }

    // (a') invariance: mirror + 40° rotation must not change curls or the frame
    {
      const base = syntheticHand(LABEL_DOWN.G);
      const alt = rotateHand(mirrorHand(base), 40);
      const c0 = curls(base), c1 = curls(alt);
      const n0 = normalize(base), n1 = normalize(alt);
      let curlErr = 0, frameErr = 0;
      for (const f of FINGER_NAMES) curlErr = Math.max(curlErr, Math.abs(c0[f] - c1[f]));
      for (let i = 0; i < 63; i++) frameErr = Math.max(frameErr, Math.abs(n0[i] - n1[i]));
      const ok = curlErr <= 0.02 && frameErr <= 0.05;
      if (!ok) pass = false;
      lines.push(`${ok ? 'PASS' : 'FAIL'} invariance mirror+40°: max curl Δ ${curlErr.toFixed(3)}, max frame Δ ${frameErr.toFixed(3)}`);
    }

    // (a'') hysteresis: a ring curl inside the band keeps its previous state, outside it flips
    {
      const thr = params.downThreshold, h = params.hysteresis;
      const mk = ring => ({ index: 0.05, middle: 0.05, ring, pinky: 0.05 });
      const UP = [0, 0, 0, 0], DOWN = [0, 0, 1, 0];
      const cases = [
        [mk(thr + h * 0.6), UP,   'open', 'in band, was up   → stays open'],
        [mk(thr + h * 0.6), DOWN, 'C',    'in band, was down → stays C'],
        [mk(thr - h * 0.6), DOWN, 'C',    'in band, was down → stays C'],
        [mk(thr + h * 1.4), UP,   'C',    'above band        → flips to C'],
        [mk(thr - h * 1.4), DOWN, 'open', 'below band        → flips to open'],
        [mk(thr + h * 0.6), null, 'C',    'no history        → centre threshold'],
      ];
      for (const [c, prev, want, label] of cases) {
        const res = classifyRules(c, prev);
        const ok = res.chord === want;
        if (!ok) pass = false;
        lines.push(`${ok ? 'PASS' : 'FAIL'} hysteresis ring=${c.ring.toFixed(2)} ${label} (got ${res.chord})`);
      }
    }

    // (b) calibration: stored store, or a synthetic one on request
    let store = calib.has() ? calib : null;
    if (!store && opts.syntheticCalib) {
      store = createCalib();
      let seed = 12345;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      for (const label of ['C', 'G', 'Am', 'F', 'open']) {
        store.begin(label);
        for (let k = 0; k < 60; k++) {
          let lm = syntheticHand(LABEL_DOWN[label]);
          lm = lm.map(p => ({ x: p.x + gauss() * 0.01, y: p.y + gauss() * 0.01, z: p.z + gauss() * 0.01 }));
          lm = rotateHand(lm, (rnd() * 2 - 1) * 20);
          if (rnd() < 0.5) lm = mirrorHand(lm);
          store.addFrame(lm);
        }
        store.end();
      }
      lines.push('calibration: synthetic (60 jittered frames × 5 labels)');
    }
    if (store) {
      const r = store.leaveOneOut();
      const ok = r.accuracy >= 0.90;
      if (!ok) pass = false;
      lines.push(`${ok ? 'PASS' : 'FAIL'} calibration leave-one-out accuracy ${(r.accuracy * 100).toFixed(1)}% over ${r.total} frames`);
      lines.push('      ' + r.labels.map(l => l.padStart(5)).join(''));
      r.labels.forEach((l, i) => lines.push(l.padEnd(6) + r.matrix[i].map(v => String(v).padStart(5)).join('')));
    } else {
      lines.push('calibration: none stored (rules active)');
    }

    lines.unshift(pass ? 'V8 CHORD RULES OK' : 'V8 CHORD FAILED');
    return { pass, lines };
  }

  return {
    params, FINGER_NAMES, LABEL_DOWN,
    normalize, curls, fingerDown, classifyRules, classifyCalibrated, classify,
    calib, createCalib, createVoter,
    syntheticHand, rotateHand, mirrorHand, selfTest,
  };
})();

if (typeof module !== 'undefined') module.exports = { Chord };
