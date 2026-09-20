// ============================================================================
// fit/ — size and place the instrument from the player's own hands, hands-free
// ----------------------------------------------------------------------------
// The frame stays FIXED while you play: strum detection needs a still frame,
// and a frame that followed a hand could never be strummed. It moves only in
// discrete, animated refits, when both hands have been still for a while with
// the strumming tip clear of the strings (the natural "I'm ready" pose), and
// then only if the change is worth making. Size comes from the palms, so the
// instrument shrinks when you step back and grows when you lean in.
// Pure functions. Depends on the global `UkeFrame` (src/strum.js) for the
// recentre geometry; no DOM, no camera.
// ============================================================================
const Fit = (() => {
  const params = {
    // Size comes from the distance between the hands in the ready pose: on a real ukulele the
    // fretting knuckles sit just past the nut (≈ 1.10 L from the bridge) and the strumming finger
    // over the lower body (0.25 L), so the hands span ≈ 0.85 scale lengths. The palm was tried first
    // (3.5 palms) but hands are nearer the camera than the body and read 1.5–2× too big.
    spanPerLength: 0.85,
    // String spacing as a fraction of scale length. A real uke is 10.5 mm / 350 mm = 0.03; on screen
    // the cells must stay fingertip-sized for position play, so we keep the drawn ratio 0.05 / 0.66.
    spacingRatio: 0.05 / 0.66,
    // Size bounds relative to the layout base (0.66 frame heights ≈ a soprano at chest height):
    // below 0.6 the fret spaces are smaller than a fingertip (see UkeFrame.layout); the base itself
    // is the ceiling — bigger looked zoomed-in on the user's screen.
    minScale: 0.6, maxScale: 1.0,
    // Plausible hand spans in frame heights; outside this one "hand" is a face or a blur.
    spanMin: 0.15, spanMax: 1.5,
    stillMs: 1500,          // both wrists still this long → the player is posed and waiting
    stillTol: 0.015,        // wrist wander allowed while "still": 1.5 % of the frame height
    minIntervalMs: 3000,    // never refit more often than this
    deadBridge: 0.02,       // skip a refit that moves the bridge less than 2 % of the frame height…
    deadScale: 0.05,        // …or changes size by less than 5 %…
    deadAngleDeg: 3,        // …or tilts by less than 3°
    animMs: 300,            // glide time from the old frame to the new one
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isoDist = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

  // Wrist (0) → middle MCP (9) in iso units (kept for the debug HUD).
  function palmLength(landmarks, aspect = 1) { return isoDist(landmarks[0], landmarks[9], aspect); }
  // Fretting knuckles (9) → strumming index tip (8) in iso units: how far apart the player holds the hands.
  function handSpan(fretting, strumming, aspect = 1) { return isoDist(fretting[9], strumming[8], aspect); }

  // Instrument size for a hand span: { length, spacing, scale } with scale relative to `base`.
  function sizeForSpan(span, base) {
    const scale = clamp((span / params.spanPerLength) / base.length, params.minScale, params.maxScale);
    const length = base.length * scale;
    return { length, spacing: length * params.spacingRatio, scale };
  }

  // Stillness detector. push() returns { still, forMs }. Both wrists must stay within stillTol of
  // where they settled and the strumming tip must be clear of the strings; any violation restarts
  // the clock, and a missing hand resets it.
  function createStillness(opts = {}) {
    const tol = opts.stillTol ?? params.stillTol, need = opts.stillMs ?? params.stillMs;
    let refA = null, refB = null, since = 0;
    return {
      push({ a, b, clear, aspect = 1, t }) {
        if (!a || !b || !clear) { refA = refB = null; return { still: false, forMs: 0 }; }
        if (!refA || isoDist(a, refA, aspect) > tol || isoDist(b, refB, aspect) > tol) {
          refA = { x: a.x, y: a.y }; refB = { x: b.x, y: b.y }; since = t;
        }
        const forMs = t - since;
        return { still: forMs >= need, forMs };
      },
      reset() { refA = refB = null; },
    };
  }

  // Is the proposed frame different enough from the current one to be worth a move?
  function worthMoving(cur, next, aspect = 1) {
    return isoDist(cur.bridge, next.bridge, aspect) >= params.deadBridge ||
           Math.abs(next.length / cur.length - 1) >= params.deadScale ||
           Math.abs(next.angleDeg - cur.angleDeg) >= params.deadAngleDeg;
  }

  // Auto-fit controller. update(sample) takes one tracking sample and returns a proposed geometry
  // (bridge, angleDeg, length, spacing, aspect, palm, scale; before layout) when a refit is due,
  // else null. sample = { fretting, strumming: landmark arrays in screen coords or null,
  // tipClear: strumming tip outside the string band, current: UkeFrame geometry, base, t: ms }.
  function createAutoFit(opts = {}) {
    const still = createStillness(opts);
    const minInterval = opts.minIntervalMs ?? params.minIntervalMs;
    let lastFitMs = -Infinity, count = 0, reason = 'waiting for both hands';
    const spans = [];
    return {
      update(s) {
        const aspect = s.current.aspect || 1;
        const st = still.push({ a: s.fretting && s.fretting[0], b: s.strumming && s.strumming[0], clear: s.tipClear, aspect, t: s.t });
        if (!st.still) {
          spans.length = 0;
          reason = !(s.fretting && s.strumming) ? 'waiting for both hands' : !s.tipClear ? 'strumming tip on the strings' : `still for ${Math.round(st.forMs)} ms`;
          return null;
        }
        const sp = handSpan(s.fretting, s.strumming, aspect);
        if (sp >= params.spanMin && sp <= params.spanMax) spans.push(sp);
        if (spans.length > 60) spans.splice(0, spans.length - 60);
        if (s.t - lastFitMs < minInterval) { reason = 'rate limited'; return null; }
        if (spans.length < 4) { reason = 'measuring hand span'; return null; }
        const sorted = spans.slice().sort((x, y) => x - y), span = sorted[sorted.length >> 1];   // median: robust to a bad frame
        const size = sizeForSpan(span, s.base);
        // neck passes through the fretting knuckles (9), strumming tip (8) parks above the strings over the body
        const g = UkeFrame.recenterG({ ...s.current, length: size.length, spacing: size.spacing }, s.fretting[9], s.strumming[8]);
        lastFitMs = s.t; still.reset(); spans.length = 0;
        if (!worthMoving(s.current, g, aspect)) { reason = 'already fitted'; return null; }
        count++; reason = `refit ${count}`;
        return { ...g, span, scale: size.scale };
      },
      status() { return { count, reason }; },
      reset() { still.reset(); spans.length = 0; },
    };
  }

  // Frame animator: eased glide between two geometries. at(t) returns the interpolated geometry
  // with done:true on the final call; active() while a glide is in progress.
  function createAnimator(animMs = params.animMs) {
    let from = null, to = null, t0 = 0;
    const ease = u => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);   // ease-in-out
    const lerp = (a, b, u) => a + (b - a) * u;
    return {
      start(f, target, t) {
        from = { ...f, bridge: { ...f.bridge } };
        to = { aspect: target.aspect ?? f.aspect, bridge: { ...target.bridge }, angleDeg: target.angleDeg, length: target.length, spacing: target.spacing };
        t0 = t;
      },
      active() { return !!to; },
      target() { return to; },
      at(t) {
        if (!to) return null;
        const done = t - t0 >= animMs;
        const u = done ? 1 : ease(clamp((t - t0) / animMs, 0, 1));
        const g = {
          aspect: to.aspect,
          bridge: { x: lerp(from.bridge.x, to.bridge.x, u), y: lerp(from.bridge.y, to.bridge.y, u) },
          angleDeg: lerp(from.angleDeg, to.angleDeg, u),
          length: lerp(from.length, to.length, u),
          spacing: lerp(from.spacing, to.spacing, u),
          done,
        };
        if (done) from = to = null;
        return g;
      },
      cancel() { from = to = null; },
    };
  }

  // ---------------------------------------------------------------- V13 self-test (pure)
  function selfTest() {
    const lines = [];
    let pass = true;
    const check = (ok, msg) => { if (!ok) pass = false; lines.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };
    const base = { length: 0.66, spacing: 0.05 };
    const aspect = 16 / 9;

    // (a) size from the hand span: hands 0.51 frame heights apart → 0.60 neck; clamps both ways
    {
      const s = sizeForSpan(0.51, base);
      check(Math.abs(s.length - 0.6) < 1e-9 && Math.abs(s.spacing / s.length - params.spacingRatio) < 1e-9,
        `span 0.51 → length ${s.length.toFixed(3)} (span / 0.85), spacing/length ${(s.spacing / s.length).toFixed(4)}`);
      check(Math.abs(sizeForSpan(0.1, base).scale - params.minScale) < 1e-9, `hands close together clamp to scale ${params.minScale}`);
      check(Math.abs(sizeForSpan(1.4, base).scale - params.maxScale) < 1e-9, `hands far apart clamp to scale ${params.maxScale} (never bigger than the base)`);
      const wide = sizeForSpan(0.50, base), narrow = sizeForSpan(0.40, base);
      check(wide.length > narrow.length, `wider hand span gets a bigger uke: ${wide.length.toFixed(2)} > ${narrow.length.toFixed(2)}`);
    }

    // (b) stillness: jitter inside the tolerance fires at stillMs, a jump restarts, a tip on the strings never fires
    {
      let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const jit = (p, amp) => ({ x: p.x + (rnd() - 0.5) * amp, y: p.y + (rnd() - 0.5) * amp });
      const A = { x: 0.3, y: 0.5 }, B = { x: 0.7, y: 0.5 };
      const st = createStillness();
      let firedAt = null;
      for (let t = 0; t <= 2000 && firedAt == null; t += 33) { if (st.push({ a: jit(A, 0.006), b: jit(B, 0.006), clear: true, aspect, t }).still) firedAt = t; }
      check(firedAt != null && firedAt >= params.stillMs && firedAt < params.stillMs + 70, `still hands with 0.6 % jitter fire at ${firedAt} ms (need ≥ ${params.stillMs})`);
      const st2 = createStillness();
      let fired2 = null;
      for (let t = 0; t <= 3000 && fired2 == null; t += 33) {
        const b = t >= 1000 ? { x: B.x + 0.03, y: B.y } : B;   // strumming wrist shifts 3 % at 1 s and stays there
        if (st2.push({ a: A, b, clear: true, aspect, t }).still) fired2 = t;
      }
      check(fired2 != null && fired2 >= 1000 + params.stillMs, `a 3 % wrist move at 1 s restarts the clock (fired at ${fired2} ms)`);
      const st3 = createStillness();
      let fired3 = false;
      for (let t = 0; t <= 4000; t += 33) if (st3.push({ a: A, b: B, clear: false, aspect, t }).still) fired3 = true;
      check(!fired3, 'strumming tip on the strings → never fires, however long the hands are still');
    }

    // (c) auto-fit end to end: still synthetic hands → exactly one proposal, then rate limit / dead band
    {
      const mkHand = (wrist, palm) => { const lm = new Array(21).fill(null).map(() => ({ x: wrist.x, y: wrist.y })); lm[0] = { ...wrist }; lm[9] = { x: wrist.x, y: wrist.y - palm }; lm[8] = { x: wrist.x, y: wrist.y - 1.9 * palm }; return lm; };
      // fretting knuckles at (0.35, 0.43), strumming tip at (0.62, 0.55): span 0.495 iso → length 0.582, natural tilt −14° (inside the clamp)
      const fret = mkHand({ x: 0.35, y: 0.55 }, 0.12), strum = mkHand({ x: 0.62, y: 0.778 }, 0.12);
      const wantLen = Math.hypot((fret[9].x - strum[8].x) * aspect, fret[9].y - strum[8].y) / params.spanPerLength;
      const current = { aspect, bridge: { x: 0.64, y: 0.62 }, angleDeg: -18, length: 0.66, spacing: 0.05 };
      const af = createAutoFit();
      const props = [];
      for (let t = 0; t <= 2500; t += 33) { const p = af.update({ fretting: fret, strumming: strum, tipClear: true, current, base, t }); if (p) props.push({ t, p }); }
      check(props.length === 1 && props[0].t >= params.stillMs, `one refit proposed after the still pose (at ${props[0] && props[0].t} ms, ${props.length} total)`);
      const p = props[0] && props[0].p;
      check(p && Math.abs(p.length - wantLen) < 1e-6 && p.scale < 1 && p.scale > params.minScale, `proposal sized from the hand span: length ${p && p.length.toFixed(3)} (span ${p && p.span.toFixed(3)} / 0.85), scale ${p && p.scale.toFixed(2)}`);
      check(p && p.angleDeg <= UkeFrame.TILT_MIN_DEG && p.angleDeg >= UkeFrame.TILT_MAX_DEG, `proposal tilted like a held ukulele: ${p && p.angleDeg.toFixed(1)}° (floor ${UkeFrame.TILT_MIN_DEG}°)`);
      if (p) {
        const kn = UkeFrame.toLocalG(p, fret[9]);
        check(Math.abs(kn.y - UkeFrame.RECENTER_TIP_Y(p.spacing)) < 1e-6 && kn.x > 0.9 * p.length, `neck passes the fretting knuckles just past the nut (local x ${kn.x.toFixed(3)} of L ${p.length.toFixed(3)})`);
      }
      if (p) {
        const tipL = UkeFrame.toLocalG ? UkeFrame.toLocalG(p, strum[8]) : null;
        check(tipL && Math.abs(tipL.x - 0.25 * p.length) < 1e-6 && Math.abs(tipL.y - UkeFrame.RECENTER_TIP_Y(p.spacing)) < 1e-6,
          `strumming tip lands at 25 % of the neck, ${(-UkeFrame.RECENTER_TIP_Y(p.spacing) / p.spacing).toFixed(1)} spacings above the top string (local ${tipL && tipL.x.toFixed(3)}, ${tipL && tipL.y.toFixed(3)})`);
      }
      // holding still after the fit, with the frame now AT the proposal → no second proposal within 6 s
      let again = 0;
      for (let t = 2533; t <= 8500; t += 33) if (af.update({ fretting: fret, strumming: strum, tipClear: true, current: { ...current, ...p }, base, t })) again++;
      check(again === 0, `hands still at the fitted frame → no further refits over 6 s (${again}); reason "${af.status().reason}"`);
      // a small drift (1 % of the frame) is inside the dead band
      const af2 = createAutoFit();
      const near = { ...current, ...p, bridge: { x: p.bridge.x + 0.005, y: p.bridge.y } };
      let moved = 0, sawDead = false;
      for (let t = 0; t <= 2500; t += 33) { if (af2.update({ fretting: fret, strumming: strum, tipClear: true, current: near, base, t })) moved++; if (af2.status().reason === 'already fitted') sawDead = true; }
      check(moved === 0 && sawDead, `1 % drift is inside the dead band → evaluated, judged "already fitted", no refit (${moved})`);
    }

    // (d) animator: starts at the old frame, ends exactly at the new one, monotonic in between
    {
      const an = createAnimator(300);
      const f = { aspect, bridge: { x: 0.6, y: 0.6 }, angleDeg: -18, length: 0.66, spacing: 0.05 };
      const g = { aspect, bridge: { x: 0.7, y: 0.5 }, angleDeg: -10, length: 0.40, spacing: 0.03 };
      an.start(f, g, 1000);
      const a0 = an.at(1000), a1 = an.at(1100), a2 = an.at(1200), a3 = an.at(1300);
      check(a0 && Math.abs(a0.bridge.x - 0.6) < 1e-9 && !a0.done, 'animator starts at the old frame');
      check(a1.bridge.x > a0.bridge.x && a2.bridge.x > a1.bridge.x && a1.length < a0.length && a2.length < a1.length, 'glide is monotonic in position and size');
      check(a3.done && Math.abs(a3.bridge.x - 0.7) < 1e-9 && Math.abs(a3.length - 0.40) < 1e-9 && Math.abs(a3.spacing - 0.03) < 1e-9 && !an.active(), 'animator ends exactly on the new frame and deactivates');
    }

    // (e) a frame move must not pluck: the detector is reset when the move starts, so a tip whose
    // local y jumped across all four strings (because the frame moved, not the hand) plays nothing
    if (typeof Strum !== 'undefined') {
      const det = Strum.createDetector({ stringYs: [-0.075, -0.025, 0.025, 0.075], zoneX: [0.03, 0.30], spacing: 0.05 });
      let plucks = 0;
      for (let i = 0; i < 6; i++) plucks += det.push({ x: 0.15, y: -0.16 + i * 0.001, t: i * 33 }).length;   // armed above the strings
      det.reset();                                                                                          // frame move begins
      for (let i = 0; i < 20; i++) plucks += det.push({ x: 0.15, y: 0.16, t: 300 + i * 33 }).length;          // same screen tip, now below the strings
      check(plucks === 0, `stationary tip re-seen across the strings after a frame move → ${plucks} plucks`);
    }

    lines.unshift(pass ? 'V13 FIT OK' : 'V13 FIT FAILED');
    return { pass, lines };
  }

  return { params, palmLength, handSpan, sizeForSpan, createStillness, worthMoving, createAutoFit, createAnimator, selfTest };
})();

if (typeof module !== 'undefined') module.exports = { Fit };
