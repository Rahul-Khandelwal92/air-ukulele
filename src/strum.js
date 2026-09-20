// ============================================================================
// uke/  — fixed on-screen instrument frame and screen ↔ local transform
// ----------------------------------------------------------------------------
// Screen coords are NORMALIZED (0..1, x already mirrored by tracking, y down).
// Local frame: origin at the bridge, +x along the neck toward the headstock
// (screen-left), +y across the strings (screen-down when the neck is level).
// Strings are horizontal lines in local coords at y_i = (i − 1.5)·spacing,
// i = 0..3  (0 = G top … 3 = A bottom), spanning local x ∈ [0, length].
//
// `aspect` (default 1) lets the integrator make the geometry isotropic on a
// non-square canvas: screen (x,y) → iso (x·aspect, y) before the rotation, so
// a −15° neck really is 15° on a 16:9 canvas. With aspect ≠ 1, lengths are in
// "frame heights" (0.55 ≈ 0.31 of width on 16:9) — bump `length` accordingly.
// Pure math except draw(), which is guarded.
// ============================================================================
const UkeFrame = (() => {
  // Default geometry — lower-centre of a 16:9 frame with hands naturally placed.
  const state = {
    bridge: { x: 0.68, y: 0.62 },
    angleDeg: -15,   // negative = headstock rises up-left
    length: 0.55,    // bridge → nut (scale length) in normalized units
    spacing: 0.045,  // string-to-string distance in normalized units
    aspect: 1,       // canvas w/h for isotropic geometry; 1 = pure normalized
  };

  // Unit vectors of the local axes in iso-screen coords.
  // Neck direction u points screen-left; for a<0 it also points up (y down).
  function axes() {
    const a = (state.angleDeg * Math.PI) / 180;
    const u = { x: -Math.cos(a), y: Math.sin(a) };  // local +x
    const v = { x: Math.sin(a), y: Math.cos(a) };   // local +y (perpendicular, down when a=0)
    return { u, v };
  }

  function set(opts = {}) {
    if (opts.bridge) state.bridge = { x: opts.bridge.x, y: opts.bridge.y };
    if (typeof opts.angleDeg === 'number') state.angleDeg = opts.angleDeg;
    if (typeof opts.length === 'number') state.length = opts.length;
    if (typeof opts.spacing === 'number') state.spacing = opts.spacing;
    if (typeof opts.aspect === 'number' && opts.aspect > 0) state.aspect = opts.aspect;
    return get();
  }
  function get() {
    return { bridge: { ...state.bridge }, angleDeg: state.angleDeg,
             length: state.length, spacing: state.spacing, aspect: state.aspect };
  }

  function toLocal(p) {
    const { u, v } = axes();
    const dx = (p.x - state.bridge.x) * state.aspect;
    const dy = p.y - state.bridge.y;
    return { x: dx * u.x + dy * u.y, y: dx * v.x + dy * v.y };
  }
  // Same transform for an arbitrary geometry object (used by layout() before committing to state).
  function toScreenG(g, l) {
    const a = (g.angleDeg * Math.PI) / 180;
    const u = { x: -Math.cos(a), y: Math.sin(a) }, v = { x: Math.sin(a), y: Math.cos(a) };
    const ix = l.x * u.x + l.y * v.x;
    const iy = l.x * u.y + l.y * v.y;
    return { x: g.bridge.x + ix / g.aspect, y: g.bridge.y + iy };
  }
  function toScreen(l) { return toScreenG(state, l); }

  // ---- layout: keep the whole instrument clear of the HUD and panels ---------------------------
  // Local-space box enclosing everything drawn for the instrument INCLUDING the annotation layer:
  // body tail −0.16L … headstock end 1.17L along the neck; body ±3.15·s, fret numbers to +2.8·s and
  // the hand-glyph plate above the neck to about −7.5·s across it. Multiples of L (x) and spacing (y).
  const EXTENT = { x0: -0.18, x1: 1.19, y0: -7.6, y1: 3.6 };
  function boundsOf(g = state) {
    const pts = [[EXTENT.x0, EXTENT.y0], [EXTENT.x1, EXTENT.y0], [EXTENT.x0, EXTENT.y1], [EXTENT.x1, EXTENT.y1]]
      .map(([kx, ky]) => toScreenG(g, { x: kx * g.length, y: ky * g.spacing }));
    return { x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)),
             x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) };
  }
  const intersects = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const insideViewport = b => b.x0 >= 0 && b.y0 >= 0 && b.x1 <= 1 && b.y1 <= 1;

  // Default placement: body right of centre at chest height, neck rising up-left at −18°.
  const LAYOUT_DEFAULT = { bridge: { x: 0.64, y: 0.62 }, angleDeg: -18 };
  // Search space when the default collides: bridge grid (normalised), neck angles from the default
  // down to level (a flatter neck is narrower), scale steps down to 0.6 (below that the fret spaces
  // are smaller than a fingertip and position play stops working). Tilt is worth more than size: a
  // tilted neck is how a ukulele is held, so the requested angle is kept down to scale 0.76 before
  // the neck is flattened (20 Sept: the level, full-size neck in the user's screenshot read as wrong).
  const LAYOUT_BX = [0.50, 0.90, 0.02], LAYOUT_BY = [0.40, 0.86, 0.02];
  const LAYOUT_ANGLES = a => [a, a / 2, 0];
  const LAYOUT_SCALES = [1, 0.92, 0.84, 0.76, 0.68, 0.6];
  const LAYOUT_MIN_SCALE_TILTED = 0.76;
  // The strum zone must stay in the right half: roles are assigned by screen side, so a strumming
  // hand working left of the midline would be taken for the fretting hand.
  const zoneMidX = g => toScreenG(g, { x: 0.25 * g.length, y: 0 }).x;
  const overlapArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

  // Pure. Given the canvas aspect, the unscaled base size and obstacle rects (normalised screen
  // coords, e.g. the HUD card, the status bar, open side panels), return a geometry whose bounds
  // sit inside the viewport and touch no obstacle, with the strum zone in the right half. Prefers
  // the default; otherwise the nearest bridge position at the largest scale (then the steepest
  // angle) that fits. If nothing fits, the least-overlapping smallest placement with `ok:false`.
  function layout({ aspect = 1, base, avoid = [], defaults = LAYOUT_DEFAULT } = {}) {
    const mk = (bx, by, k, ang) => ({ aspect, bridge: { x: bx, y: by }, angleDeg: ang, length: base.length * k, spacing: base.spacing * k });
    const clear = g => { const b = boundsOf(g); return insideViewport(b) && !avoid.some(r => intersects(b, r)); };
    const fits = g => zoneMidX(g) >= 0.5 && clear(g);
    const g0 = mk(defaults.bridge.x, defaults.bridge.y, 1, defaults.angleDeg);
    if (fits(g0)) return { ...g0, ok: true, scale: 1, moved: false };
    const cands = [];
    for (let by = LAYOUT_BY[0]; by <= LAYOUT_BY[1] + 1e-9; by += LAYOUT_BY[2]) {
      for (let bx = LAYOUT_BX[0]; bx <= LAYOUT_BX[1] + 1e-9; bx += LAYOUT_BX[2]) {
        cands.push({ bx, by, d: Math.hypot((bx - defaults.bridge.x) * aspect, by - defaults.bridge.y) });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    for (const ang of LAYOUT_ANGLES(defaults.angleDeg)) {
      for (const k of LAYOUT_SCALES) {
        if (ang !== 0 && k < LAYOUT_MIN_SCALE_TILTED) break;
        for (const c of cands) { const g = mk(c.bx, c.by, k, ang); if (fits(g)) return { ...g, ok: true, scale: k, moved: true }; }
      }
    }
    // Nothing fits: take the smallest instrument with the least UI overlap (still right-half, still inside).
    let best = null, bestCost = Infinity;
    const kMin = LAYOUT_SCALES[LAYOUT_SCALES.length - 1];
    for (const ang of LAYOUT_ANGLES(defaults.angleDeg)) {
      for (const c of cands) {
        const g = mk(c.bx, c.by, kMin, ang);
        if (zoneMidX(g) < 0.5) continue;
        const b = boundsOf(g);
        if (!insideViewport(b)) continue;
        const cost = avoid.reduce((s, r) => s + overlapArea(b, r), 0);
        if (cost < bestCost) { bestCost = cost; best = g; }
      }
    }
    return { ...(best || g0), ok: false, scale: best ? kMin : 1, moved: !!best };
  }

  function stringLocalYs() {
    return [0, 1, 2, 3].map(i => (i - 1.5) * state.spacing);
  }
  function stringScreenSegments() {
    return stringLocalYs().map(y => ({
      a: toScreen({ x: 0, y }),
      b: toScreen({ x: state.length, y }),
    }));
  }
  // Crossings only count in this local-x band over the body — waving over the
  // neck must not pluck.
  function strumZone() {
    return [0.05 * state.length, 0.45 * state.length];
  }
  // Where the fretting hand has to be for a chord to count as fretted. The board is drawn
  // 0.46L → L with half-width 2·spacing; the margins let fingertips sit a little above/below
  // the board (the hand hovers over it on camera) and past the nut.
  function neckZone() {
    return { x0: 0.40 * state.length, x1: 1.08 * state.length, yHalf: 4 * state.spacing };
  }

  // Aim the neck from the strumming tip toward the fretting wrist and place the
  // bridge so the tip sits at 25% of the scale length, 2.5 string spacings ABOVE the
  // top string (on the "armed" side of the string band): a resting hand recentred with C
  // must not be parked on a string line, or jitter would pluck it.
  const RECENTER_TIP_Y = spacing => -(1.5 + 2.5) * spacing;
  // A ukulele is held with the neck rising toward the fretting hand: 12°–40° above level (players sit
  // around 15°–25°). Level or neck-down never happens on a real instrument, so the tilt is clamped to
  // this range even when the hands are level: the nut then sits ≤ 0.1 frame heights above the fretting
  // knuckles, well within the reach of the fingers, and the coaching arrows guide the hand up.
  const TILT_MIN_DEG = -12, TILT_MAX_DEG = -40;
  // Pure: the recentred geometry for an arbitrary geometry g (its length/spacing/aspect are kept).
  // `frettingAim` is where the neck should pass: the fretting hand's knuckles (middle MCP, landmark 9)
  // in live use, so the fingers curl down onto the strings like on a real neck.
  function recenterG(g, frettingAim, strummingTip) {
    const out = { aspect: g.aspect, bridge: { ...g.bridge }, angleDeg: g.angleDeg, length: g.length, spacing: g.spacing };
    if (!frettingAim || !strummingTip) return out;
    const ax = (frettingAim.x - strummingTip.x) * g.aspect;
    const ay = frettingAim.y - strummingTip.y;
    const n = Math.hypot(ax, ay);
    if (n < 1e-6) return out;
    const ux = ax / n, uy = ay / n;
    // u = (−cos a, sin a)  ⇒  a = atan2(uy, −ux); negative = headstock rises up-left
    let a = Math.atan2(uy, -ux);
    a = Math.min((TILT_MIN_DEG * Math.PI) / 180, Math.max((TILT_MAX_DEG * Math.PI) / 180, a));
    out.angleDeg = (a * 180) / Math.PI;
    const u = { x: -Math.cos(a), y: Math.sin(a) }, v = { x: Math.sin(a), y: Math.cos(a) };
    const d = 0.25 * g.length, ty = RECENTER_TIP_Y(g.spacing);
    // tip_local = (d, ty)  ⇒  bridge = tip − (d·u + ty·v) in iso coords
    out.bridge = {
      x: strummingTip.x - (d * u.x + ty * v.x) / g.aspect,
      y: strummingTip.y - (d * u.y + ty * v.y),
    };
    return out;
  }
  function recenter(frettingWrist, strummingTip) {
    const g = recenterG(state, frettingWrist, strummingTip);
    state.angleDeg = g.angleDeg; state.bridge = g.bridge;
    return get();
  }
  // Pure inverse of toScreenG for an arbitrary geometry.
  function toLocalG(g, p) {
    const a = (g.angleDeg * Math.PI) / 180;
    const u = { x: -Math.cos(a), y: Math.sin(a) }, v = { x: Math.sin(a), y: Math.cos(a) };
    const dx = (p.x - g.bridge.x) * g.aspect, dy = p.y - g.bridge.y;
    return { x: dx * u.x + dy * u.y, y: dx * v.x + dy * v.y };
  }

  // Appearance only — geometry lives above. Tweak freely.
  const theme = {
    wood: ['#5e3418', '#8a5230', '#a8683b'],   // koa/mahogany top, dark → light across the body
    woodAlpha: 0.86,
    woodSheen: 'rgba(255, 220, 170, 0.18)',
    binding: 'rgba(38, 22, 12, 0.95)',
    bindingInner: 'rgba(255, 232, 196, 0.35)',
    soundhole: ['#1c110a', '#050302'],
    rosette: '#f5b74a',
    rosetteDark: 'rgba(50, 28, 14, 0.9)',
    fretboard: '#2a1a12',
    fretboardAlpha: 0.94,
    grain: 'rgba(255, 255, 255, 0.045)',
    nut: '#efe6d2',
    fret: '#d9d9d9',
    fretShadow: 'rgba(30, 30, 30, 0.75)',
    dot: '#e8e2d0',
    headstock: '#22140d',
    tuner: '#cfd3d6',
    tunerRing: 'rgba(0,0,0,0.5)',
    bridge: '#2a1a12',
    saddle: '#efe6d2',
    string: '#f2eee6',
    stringShadow: 'rgba(60, 50, 35, 0.55)',
    stringWidths: [2.4, 3.0, 2.0, 1.5],        // px: G C E A — the C string is thickest, A thinnest
    highlight: '#ffd27a',
    glow: 'rgba(245, 183, 74, 0.95)',
    zone: 'rgba(245, 183, 74, 0.06)',
    shadow: 'rgba(0, 0, 0, 0.35)',
  };

  // Optional rendering. ctx2d is a CanvasRenderingContext2D; w,h in pixels.
  // Draws in LOCAL coordinates through the exact local→screen affine, so every
  // element lands where toScreen() says it does; only the looks changed.
  function draw(ctx, w, h, opts = {}) {
    if (!ctx || typeof ctx.beginPath !== 'function') return;
    const highlight = opts.highlight || [];
    const L = state.length, s = state.spacing;

    // local → device-pixel affine from three probe points
    const o = toScreen({ x: 0, y: 0 }), ex = toScreen({ x: 1, y: 0 }), ey = toScreen({ x: 0, y: 1 });
    const m = { a: (ex.x - o.x) * w, b: (ex.y - o.y) * h, c: (ey.x - o.x) * w, d: (ey.y - o.y) * h, e: o.x * w, f: o.y * h };
    const k = Math.hypot(m.a, m.b) || 1;   // pixels per local unit
    const px = 1 / k;                      // one device pixel in local units
    const safe = fn => { try { return fn(); } catch (e) { return null; } };
    const T = theme;

    // Closed Catmull-Rom spline → cubic beziers
    const spline = pts => {
      const n = pts.length;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
        ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
                          p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
      }
      ctx.closePath();
    };
    const rrect = (x0, y0, x1, y1, r) => {
      ctx.beginPath();
      ctx.moveTo(x0 + r, y0); ctx.lineTo(x1 - r, y0); ctx.quadraticCurveTo(x1, y0, x1, y0 + r);
      ctx.lineTo(x1, y1 - r); ctx.quadraticCurveTo(x1, y1, x1 - r, y1);
      ctx.lineTo(x0 + r, y1); ctx.quadraticCurveTo(x0, y1, x0, y1 - r);
      ctx.lineTo(x0, y0 + r); ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
      ctx.closePath();
    };
    const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
    const circle = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); };

    ctx.save();
    if (typeof ctx.transform === 'function') ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // ---- body: figure-8 soprano silhouette (tail at −0.16L, neck joint at 0.50L) ----
    const outline = [
      [-0.160, 0.0], [-0.135, 1.7], [-0.060, 2.85], [0.040, 3.15], [0.130, 2.95], [0.200, 2.45],
      [0.250, 2.20], [0.305, 2.35], [0.375, 2.62], [0.440, 2.35], [0.490, 1.55], [0.500, 0.0],
      [0.490, -1.55], [0.440, -2.35], [0.375, -2.62], [0.305, -2.35], [0.250, -2.20], [0.200, -2.45],
      [0.130, -2.95], [0.040, -3.15], [-0.060, -2.85], [-0.135, -1.7],
    ].map(([x, y]) => ({ x: x * L, y: y * s }));

    // drop shadow (device-space offsets, deliberately not transformed)
    ctx.save();
    ctx.shadowColor = T.shadow; ctx.shadowBlur = 22; ctx.shadowOffsetY = 8;
    spline(outline);
    ctx.fillStyle = 'rgba(60, 35, 18, 0.9)';
    ctx.fill();
    ctx.restore();

    // wood top
    spline(outline);
    ctx.globalAlpha = T.woodAlpha;
    const wg = safe(() => ctx.createLinearGradient(0, -3.2 * s, 0, 3.2 * s));
    if (wg) { wg.addColorStop(0, T.wood[0]); wg.addColorStop(0.5, T.wood[2]); wg.addColorStop(1, T.wood[1]); ctx.fillStyle = wg; }
    else ctx.fillStyle = T.wood[1];
    ctx.fill();
    // soft sheen along the top edge
    const sg = safe(() => ctx.createLinearGradient(0, -3.2 * s, 0, 0.5 * s));
    if (sg) { sg.addColorStop(0, T.woodSheen); sg.addColorStop(1, 'rgba(255,220,170,0)'); ctx.fillStyle = sg; ctx.fill(); }
    // faint grain lines
    ctx.globalAlpha = 1;
    ctx.strokeStyle = T.grain; ctx.lineWidth = 1 * px;
    for (let g = -2.8; g <= 2.8; g += 0.45) line(-0.14 * L, g * s, 0.48 * L, g * s * 0.92);
    // binding: dark edge + thin cream inner line
    spline(outline);
    ctx.strokeStyle = T.binding; ctx.lineWidth = 2.2 * px; ctx.stroke();
    spline(outline);
    ctx.strokeStyle = T.bindingInner; ctx.lineWidth = 0.8 * px; ctx.stroke();

    // ---- soundhole + rosette ----
    const shx = 0.16 * L, shr = 1.05 * s;
    circle(shx, 0, shr);
    const hg = safe(() => ctx.createRadialGradient(shx, 0, shr * 0.2, shx, 0, shr));
    if (hg) { hg.addColorStop(0, T.soundhole[1]); hg.addColorStop(1, T.soundhole[0]); ctx.fillStyle = hg; } else ctx.fillStyle = T.soundhole[0];
    ctx.fill();
    circle(shx, 0, shr + 2.5 * px); ctx.strokeStyle = T.rosetteDark; ctx.lineWidth = 3 * px; ctx.stroke();
    circle(shx, 0, shr + 5.5 * px); ctx.strokeStyle = T.rosette; ctx.lineWidth = 2 * px; ctx.stroke();
    circle(shx, 0, shr + 9 * px); ctx.strokeStyle = T.rosetteDark; ctx.lineWidth = 1.2 * px; ctx.stroke();

    // ---- strum zone: barely-there soft band over the body ----
    const [z0, z1] = strumZone();
    ctx.fillStyle = T.zone;
    rrect(z0, -2.6 * s, z1, 2.6 * s, 0.6 * s); ctx.fill();

    // ---- headstock (beyond the nut) ----
    const nw = 2.0 * s;
    // Kept slim and pushed outward so the annotation layer's string names / open markers
    // just beyond the nut stay readable.
    const hs0 = L, hs1 = L + 0.17 * L;
    ctx.fillStyle = T.headstock;
    ctx.globalAlpha = T.fretboardAlpha;
    rrect(hs0 - 0.5 * px, -1.15 * nw, hs1, 1.15 * nw, 0.9 * s); ctx.fill();
    ctx.globalAlpha = 1;
    rrect(hs0 - 0.5 * px, -1.15 * nw, hs1, 1.15 * nw, 0.9 * s);
    ctx.strokeStyle = T.binding; ctx.lineWidth = 1.5 * px; ctx.stroke();
    // tuners: two per side
    for (const tx of [hs0 + 0.095 * L, hs0 + 0.14 * L]) {
      for (const ty of [-0.85 * nw, 0.85 * nw]) {
        circle(tx, ty, 0.30 * s); ctx.fillStyle = T.tuner; ctx.fill();
        ctx.strokeStyle = T.tunerRing; ctx.lineWidth = 1 * px; ctx.stroke();
        circle(tx, ty, 0.12 * s); ctx.fillStyle = T.tunerRing; ctx.fill();
      }
    }

    // ---- neck / fretboard (0.46L → L) ----
    ctx.globalAlpha = T.fretboardAlpha;
    ctx.fillStyle = T.fretboard;
    ctx.beginPath();
    ctx.moveTo(0.46 * L, -nw); ctx.lineTo(L, -nw); ctx.lineTo(L, nw); ctx.lineTo(0.46 * L, nw); ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    // grain highlight along the fretboard
    ctx.strokeStyle = T.grain; ctx.lineWidth = 1 * px;
    for (let g = -0.75; g <= 0.75; g += 0.5) line(0.47 * L, g * nw, L, g * nw);
    // edges
    ctx.strokeStyle = T.binding; ctx.lineWidth = 1.2 * px;
    line(0.46 * L, -nw, L, -nw); line(0.46 * L, nw, L, nw);

    // frets: distance from the bridge = L·2^(−n/12) (equal temperament); draw to the body joint
    const fretX = n => L * Math.pow(2, -n / 12);
    for (let n = 1; n <= 12; n++) {
      const x = fretX(n);
      if (x < 0.47 * L) break;
      ctx.strokeStyle = T.fretShadow; ctx.lineWidth = 1.2 * px; line(x - 1.2 * px, -nw, x - 1.2 * px, nw);
      ctx.strokeStyle = T.fret; ctx.lineWidth = 1.8 * px; line(x, -nw, x, nw);
    }
    // pearl position dots at frets 5 and 7 (centred in the fret space)
    for (const n of [5, 7]) {
      const x = (fretX(n - 1) + fretX(n)) / 2;
      if (x < 0.47 * L) continue;
      circle(x, 0, 0.26 * s); ctx.fillStyle = T.dot; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.8 * px; ctx.stroke();
    }
    // nut (bone)
    ctx.strokeStyle = T.nut; ctx.lineWidth = 4 * px; line(L, -nw, L, nw);

    // ---- bridge + saddle (strings start at local x = 0) ----
    ctx.fillStyle = T.bridge;
    rrect(-0.035 * L, -2.2 * s, 0.02 * L, 2.2 * s, 0.35 * s); ctx.fill();
    ctx.strokeStyle = T.binding; ctx.lineWidth = 1 * px; ctx.stroke();
    ctx.strokeStyle = T.saddle; ctx.lineWidth = 3 * px; line(0, -1.9 * s, 0, 1.9 * s);

    // ---- strings ----
    stringLocalYs().forEach((y, i) => {
      const wpx = T.stringWidths[i] * px;
      // shadow line for depth
      ctx.strokeStyle = T.stringShadow; ctx.lineWidth = wpx; line(0, y + 1.2 * px, L, y + 1.2 * px);
      if (highlight[i]) {
        ctx.save();
        ctx.shadowColor = T.glow; ctx.shadowBlur = 14;
        ctx.strokeStyle = T.highlight; ctx.lineWidth = wpx * 1.5; line(0, y, L, y);
        ctx.restore();
      } else {
        ctx.strokeStyle = T.string; ctx.lineWidth = wpx; line(0, y, L, y);
      }
    });

    ctx.restore();
  }

  // -------------------------------------------------------------- V12 self-test (layout)
  // The instrument must never sit under the HUD, the status bar or an open side panel, on any
  // plausible window. Obstacles are modelled in CSS pixels like the real DOM: HUD card top-left
  // (24 px inset, width min(320 px, 28 vw), up to 480 px tall), status bar 40 px along the bottom,
  // and optionally a 300 px right-hand panel (help / song).
  function selfTest() {
    const lines = [];
    let pass = true;
    const check = (ok, msg) => { if (!ok) pass = false; lines.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };
    const viewports = [[1920, 1080], [1665, 663], [1536, 864], [1366, 768], [1280, 720], [1024, 640], [2560, 1080], [1280, 1024]];
    const baseFor = aspect => ({ length: Math.min(0.66, 0.38 * aspect), spacing: 0.05 });
    const px = (W, H, x, y, w, h, pad = 12) => ({ x0: (x - pad) / W, y0: (y - pad) / H, x1: (x + w + pad) / W, y1: (y + h + pad) / H });
    const fmt = b => `[${b.x0.toFixed(2)},${b.y0.toFixed(2)}]–[${b.x1.toFixed(2)},${b.y1.toFixed(2)}]`;
    for (const [W, H] of viewports) {
      const aspect = W / H, base = baseFor(aspect);
      const hudW = Math.min(320, 0.28 * W), hudH = Math.min(480, 0.8 * H - 24);
      const hud = px(W, H, 24, 24, hudW, hudH), status = px(W, H, 0, H - 40, W, 40);
      for (const panel of [null, px(W, H, W - 324, 24, 300, H - 120)]) {
        const avoid = [hud, status].concat(panel ? [panel] : []);
        const g = layout({ aspect, base, avoid });
        const b = boundsOf(g);
        const hit = avoid.filter(r => intersects(b, r)).length;
        const zoneMid = toScreenG(g, { x: 0.25 * g.length, y: 0 });
        check(g.ok && hit === 0 && insideViewport(b),
          `${W}×${H}${panel ? ' +panel' : ''}: instrument ${fmt(b)} clear of ${avoid.length} obstacles, scale ${g.scale}${g.moved ? ` bridge (${g.bridge.x.toFixed(2)},${g.bridge.y.toFixed(2)})` : ' default'}`);
        check(zoneMid.x > 0.5, `${W}×${H}${panel ? ' +panel' : ''}: strum zone stays in the right half (x ${zoneMid.x.toFixed(2)})`);
      }
    }
    // a collision must cost size before it costs tilt: a 300 px panel on 1920×1080 → still −18°, smaller
    {
      const W = 1920, H = 1080, aspect = W / H;
      const hud = px(W, H, 24, 24, Math.min(320, 0.28 * W), Math.min(480, 0.8 * H - 24)), status = px(W, H, 0, H - 40, W, 40), panel = px(W, H, W - 324, 24, 300, H - 120);
      const g = layout({ aspect, base: baseFor(aspect), avoid: [hud, status, panel] });
      check(g.ok && g.angleDeg === LAYOUT_DEFAULT.angleDeg, `cramped 1920×1080 +panel keeps the ${LAYOUT_DEFAULT.angleDeg}° tilt (got ${g.angleDeg}°, scale ${g.scale})`);
    }
    // no obstacles → default geometry untouched
    const free = layout({ aspect: 16 / 9, base: baseFor(16 / 9), avoid: [] });
    check(free.ok && !free.moved && free.scale === 1 && free.bridge.x === LAYOUT_DEFAULT.bridge.x && free.bridge.y === LAYOUT_DEFAULT.bridge.y, 'no obstacles → default placement');
    // an obstacle covering the whole screen → reported, not silently accepted
    const blocked = layout({ aspect: 16 / 9, base: baseFor(16 / 9), avoid: [{ x0: 0, y0: 0, x1: 1, y1: 1 }] });
    check(!blocked.ok, 'impossible layout is reported as ok:false');
    // bounds really enclose the drawn extents: strings, headstock end, body tail, glyph
    {
      const g = { aspect: 16 / 9, bridge: { x: 0.64, y: 0.62 }, angleDeg: -18, length: 0.66, spacing: 0.05 };
      const b = boundsOf(g);
      const probes = [{ x: 0, y: -0.075 }, { x: 0.66, y: 0.075 }, { x: -0.16 * 0.66, y: 0 }, { x: 1.17 * 0.66, y: 0 }, { x: 0.78 * 0.66, y: -7.2 * 0.05 }, { x: 0.5 * 0.66, y: 3.15 * 0.05 }];
      const inside = probes.every(l => { const p = toScreenG(g, l); return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1; });
      check(inside, 'boundsOf() encloses bridge, nut, tail, headstock, glyph and body probes');
    }
    lines.unshift(pass ? 'V12 LAYOUT OK' : 'V12 LAYOUT FAILED');
    return { pass, lines };
  }

  return { set, get, toLocal, toLocalG, toScreen, toScreenG, stringLocalYs, stringScreenSegments,
           strumZone, neckZone, recenter, recenterG, RECENTER_TIP_Y, TILT_MIN_DEG, TILT_MAX_DEG, draw, theme,
           boundsOf, intersects, layout, LAYOUT_DEFAULT, EXTENT, selfTest };
})();

// ============================================================================
// strum/  — sub-frame string-crossing solver, scheduler, keyboard strum, V4
// ----------------------------------------------------------------------------
// A strum crosses four strings in ~60 ms = two camera frames. We never test
// "fingertip inside a rectangle". For consecutive samples (y0,t0),(y1,t1) each
// string with y_i strictly between gets its crossing time by interpolation:
//     τ_i = t0 + (y_i − y0)/(y1 − y0) · (t1 − t0)
// Relative offsets τ_i − τ_min are then preserved when scheduling audio.
// ============================================================================
const Strum = (() => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // A fast strum crosses the 0.135 string span in ~50 ms ≈ 2.7 local units/s.
  const V_MAX = 3.0;

  function velocityToAmp(v, minVelocity) {
    return clamp(0.3 + 0.7 * (v - minVelocity) / (V_MAX - minVelocity), 0.3, 1.0);
  }

  // Three guards keep a hand that is merely *near* the strings silent:
  //  1. hysteresis — each string remembers which side the tip is on and only flips when
  //     the tip is clearly past the line (dead band), so a parked, jittering tip never
  //     "crosses" anything;
  //  2. speed gate — a per-sample speed above 2·V_MAX is a tracker glitch (or a role
  //     swap teleporting the tip between hands), not a finger, and resyncs instead of raking;
  //  3. stroke arming — crossings only count after the tip was seen OUTSIDE the string
  //     band inside the strum zone (a real stroke starts above or below the strings);
  //     a tip that appears inside the band, or loiters there, is disarmed.
  function createDetector(opts = {}) {
    const stringYs = opts.stringYs || UkeFrame.stringLocalYs();
    const zoneX = opts.zoneX || UkeFrame.strumZone();
    const spacing = opts.spacing ?? (stringYs.length > 1 ? Math.abs(stringYs[1] - stringYs[0]) : 0.045);
    const debounceMs = opts.debounceMs ?? 40;     // one string cannot retrigger faster than this
    const maxJump = opts.maxJump ?? 0.4;          // hard bound: larger Δ in one sample is never a finger
    const maxSpeed = opts.maxSpeed ?? 2 * V_MAX;  // u/s; twice the fastest strum — glitch above this (frame-rate independent)
    const minVelocity = opts.minVelocity ?? 0.4;  // u/s; a lazy 300 ms full strum ≈ 0.42, tracker jitter < 0.2
    const band = opts.band ?? 0.3 * spacing;      // hysteresis dead band ≈ 9 px at 720p, ~2× fingertip jitter
    const outerY = 1.5 * spacing + band;          // |y| beyond this = outside the string band (arming zone)
    const strokeMaxMs = opts.strokeMaxMs ?? 400;  // a stroke through 3 spacings at minVelocity takes ~340 ms; longer = loitering

    let prev = null;
    let lastV = 0;
    let armed = false, enteredBandMs = null;
    const side = new Array(stringYs.length).fill(0);   // −1 above (y < y_i), +1 below, 0 unknown
    const lastPluck = new Array(stringYs.length).fill(-Infinity);

    const inZone = x => x >= zoneX[0] && x <= zoneX[1];
    function sideOf(y, yi) { return y < yi - band ? -1 : y > yi + band ? 1 : 0; }
    function initSides(y) { for (let i = 0; i < stringYs.length; i++) side[i] = sideOf(y, stringYs[i]); }
    function updateArming(s) {
      if (Math.abs(s.y) > outerY) {               // outside the band: arm iff over the body
        armed = inZone(s.x);
        enteredBandMs = null;
      } else {
        if (enteredBandMs == null) enteredBandMs = s.t;
        if (armed && s.t - enteredBandMs > strokeMaxMs) armed = false;   // loitering among the strings
      }
    }
    function resync(s) { prev = s; initSides(s.y); armed = false; enteredBandMs = null; updateArming(s); }

    function push(s) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.t)) {
        prev = null; side.fill(0); armed = false; enteredBandMs = null; return [];
      }
      if (!prev) { resync(s); return []; }
      const dx = s.x - prev.x, dy = s.y - prev.y, dt = s.t - prev.t;
      if (dt <= 0) { prev = s; return []; }
      const speed = (Math.hypot(dx, dy) / dt) * 1000;
      if (Math.abs(dx) > maxJump || Math.abs(dy) > maxJump || speed > maxSpeed) { resync(s); return []; } // glitch: resync

      const v = (Math.abs(dy) / dt) * 1000; // local units per second, across the strings
      lastV = v;
      const out = [];
      const wasArmed = armed;                 // arming state as of `prev` governs this segment
      const dir = dy > 0 ? 1 : -1;            // +1 = downstroke G→A
      for (let i = 0; i < stringYs.length; i++) {
        const yi = stringYs[i];
        const ns = sideOf(s.y, yi);
        if (ns === 0) continue;                              // in the dead band: side unchanged
        const flipped = side[i] !== 0 && ns !== side[i];
        side[i] = ns;
        if (!flipped || !wasArmed || v < minVelocity) continue;
        const f = clamp((yi - prev.y) / (dy || 1e-9), 0, 1);   // prev may sit inside the dead band
        const tau = prev.t + f * dt;
        const xAt = prev.x + f * dx;
        if (!inZone(xAt)) continue;                          // over the neck, not the body
        if (tau - lastPluck[i] < debounceMs) continue;
        lastPluck[i] = tau;
        out.push({ string: i, velocity: velocityToAmp(v, minVelocity), tMs: tau, dir });
      }
      out.sort((a, b) => a.tMs - b.tMs);
      updateArming(s);
      prev = s;
      return out;
    }
    function reset() { prev = null; lastV = 0; lastPluck.fill(-Infinity); side.fill(0); armed = false; enteredBandMs = null; }
    function lastVelocity() { return lastV; }
    function isArmed() { return armed; }
    return { push, reset, lastVelocity, isArmed, params: { band, minVelocity, maxSpeed, outerY, strokeMaxMs } };
  }

  // τ (ms, performance.now domain) → AudioContext seconds, exact relative rake,
  // all in the future. nowMs is accepted for symmetry / future latency comp.
  function schedule(plucks, audioNowSec, nowMs) { // eslint-disable-line no-unused-vars
    if (!plucks || !plucks.length) return [];
    const tMin = Math.min(...plucks.map(p => p.tMs));
    return plucks.map(p => ({
      string: p.string, velocity: p.velocity, dir: p.dir,
      when: audioNowSec + (p.tMs - tMin) / 1000,
    }));
  }

  // Keyboard / mouse-button strum: all 4 strings always play on a uke.
  function keyboardStrum(chordFrets, dir = 1, rakeMs = 12, audioNowSec = 0, velocity = 0.8) {
    const order = dir >= 0 ? [0, 1, 2, 3] : [3, 2, 1, 0];
    return order.map((string, k) => ({
      string, velocity, dir: dir >= 0 ? 1 : -1,
      when: audioNowSec + (k * rakeMs) / 1000,
    }));
  }

  // -------------------------------------------------------------- V4 self-test
  function selfTest() {
    const lines = [];
    let pass = true;
    const check = (ok, msg) => { if (!ok) pass = false; lines.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };

    const spacing = 0.045;
    const ys = [0, 1, 2, 3].map(i => (i - 1.5) * spacing); // ±0.0675, ±0.0225
    const zone = [0.05 * 0.55, 0.45 * 0.55];                 // [0.0275, 0.2475]
    const xIn = 0.12, xOut = 0.40;
    const mk = () => createDetector({ stringYs: ys, zoneX: zone });

    // (a) top→bottom, 60 ms, 3 samples, inside zone
    {
      const d = mk();
      const pl = [
        ...d.push({ x: xIn, y: -0.10, t: 0 }),
        ...d.push({ x: xIn, y: 0.00, t: 30 }),
        ...d.push({ x: xIn, y: 0.10, t: 60 }),
      ];
      check(pl.length === 4, `(a) 4 plucks from a 60 ms downstroke (got ${pl.length})`);
      check(pl.map(p => p.string).join() === '0,1,2,3', `(a) strings in order 0,1,2,3 (got ${pl.map(p => p.string).join()})`);
      const inc = pl.every((p, i) => i === 0 || p.tMs > pl[i - 1].tMs);
      check(inc, `(a) strictly increasing τ: ${pl.map(p => p.tMs.toFixed(2)).join(' → ')} ms`);
      const span = pl.length ? pl[pl.length - 1].tMs - pl[0].tMs : 0;
      check(span >= 40 && span <= 80, `(a) rake span ${span.toFixed(2)} ms within 40–80`);
      check(pl.every(p => p.dir === 1), `(a) dir = +1 (downstroke)`);
      check(pl.every(p => p.velocity >= 0.3 && p.velocity <= 1.0), `(a) amplitudes in [0.3,1]: ${pl.map(p => p.velocity.toFixed(2)).join(',')}`);
      const sch = schedule(pl, 100.0, 60);
      const rel = sch.map(s => ((s.when - 100.0) * 1000).toFixed(2));
      check(sch[0] && Math.abs(sch[0].when - 100.0) < 1e-9 && sch.every((s, i) => i === 0 || s.when > sch[i - 1].when),
        `(a) schedule() preserves rake from audioNow: +${rel.join(', +')} ms`);
    }
    // (b) reversed path → 3,2,1,0, dir −1
    {
      const d = mk();
      const pl = [
        ...d.push({ x: xIn, y: 0.10, t: 0 }),
        ...d.push({ x: xIn, y: 0.00, t: 30 }),
        ...d.push({ x: xIn, y: -0.10, t: 60 }),
      ];
      check(pl.map(p => p.string).join() === '3,2,1,0', `(b) upstroke order 3,2,1,0 (got ${pl.map(p => p.string).join()})`);
      check(pl.length === 4 && pl.every(p => p.dir === -1), `(b) dir = −1`);
    }
    // (c) outside zone → 0
    {
      const d = mk();
      const pl = [
        ...d.push({ x: xOut, y: -0.10, t: 0 }),
        ...d.push({ x: xOut, y: 0.00, t: 30 }),
        ...d.push({ x: xOut, y: 0.10, t: 60 }),
      ];
      check(pl.length === 0, `(c) 0 plucks when x is over the neck (got ${pl.length})`);
    }
    // (d) armed stroke to just past string 2, then back across it within 10 ms → string 2 plucks once
    {
      const d = mk();
      const y2 = ys[2];
      const pl = [
        ...d.push({ x: xIn, y: -0.10, t: 0 }),           // outside the band: arms the stroke
        ...d.push({ x: xIn, y: y2 + 0.02, t: 30 }),      // crosses strings 0, 1, 2
        ...d.push({ x: xIn, y: y2 - 0.02, t: 40 }),      // back over string 2 inside the debounce
      ];
      const n2 = pl.filter(p => p.string === 2).length;
      check(n2 === 1 && pl.length === 3, `(d) debounce: string 2 re-crossed within 10 ms plucks once (got ${n2} of ${pl.length} plucks)`);
    }
    // (g) a parked, jittering tip on a string line → 0 plucks (hysteresis)
    {
      const d = mk();
      const y1 = ys[1];
      let seed = 777;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      d.push({ x: xIn, y: -0.10, t: 0 });                 // arrives armed from above …
      const arrive = d.push({ x: xIn, y: y1, t: 33 });     // … and comes to rest on string 1 (legitimately crossing string 0)
      check(arrive.length === 1 && arrive[0].string === 0, `(g) arriving on string 1 from above plucks only string 0 (got ${arrive.map(p => p.string).join()})`);
      let pl = [];
      for (let k = 2; k <= 60; k++) {                     // 2 s at 30 fps, ±5 px of jitter (0.007 u) about the line, still armed at first
        pl = pl.concat(d.push({ x: xIn + (rnd() - 0.5) * 0.01, y: y1 + (rnd() - 0.5) * 0.014, t: k * 33 }));
      }
      check(pl.length === 0, `(g) tip resting on string 1 with ±0.007 jitter for 2 s → 0 plucks (got ${pl.length})`);
      check(!d.isArmed(), `(g) loitering inside the string band disarms the stroke`);
      // and a real stroke afterwards still works: leave the band, come back through
      const after = [...d.push({ x: xIn, y: -0.12, t: 2100 }), ...d.push({ x: xIn, y: 0.00, t: 2140 }), ...d.push({ x: xIn, y: 0.12, t: 2180 })];
      check(after.length === 4, `(g) next real stroke after resting plays 4 strings (got ${after.length})`);
    }
    // (h) fast teleport (role swap between hands): Δ = 0.3 u in 33 ms = 9 u/s > 2·V_MAX → 0 plucks
    {
      const d = mk();
      const pl = [
        ...d.push({ x: xIn, y: -0.15, t: 0 }),
        ...d.push({ x: xIn, y: 0.15, t: 33 }),
      ];
      check(pl.length === 0, `(h) 0.3 u jump in 33 ms (9 u/s) is a glitch → 0 plucks (got ${pl.length})`);
      const slow = mk();
      const ok = [...slow.push({ x: xIn, y: -0.15, t: 0 }), ...slow.push({ x: xIn, y: 0.15, t: 60 })];
      check(ok.length === 4, `(h) the same 0.3 u over 60 ms (5 u/s) is a real fast strum → 4 plucks (got ${ok.length})`);
    }
    // (i) tip appears from over the neck straight into the string band → not armed → 0 plucks
    {
      const d = mk();
      const pl = [
        ...d.push({ x: 0.30, y: -0.02, t: 0 }),          // over the neck, between strings 1 and 2
        ...d.push({ x: 0.20, y: 0.05, t: 33 }),           // slides into the body zone across string 2 (3.7 u/s, no glitch)
        ...d.push({ x: 0.20, y: 0.055, t: 66 }),
      ];
      check(pl.length === 0, `(i) entering the band from the neck without leaving it first → 0 plucks (got ${pl.length})`);
    }
    // (e) teleport → 0 plucks, no crash
    {
      const d = mk();
      let pl, threw = false;
      try {
        pl = [
          ...d.push({ x: xIn, y: -0.30, t: 0 }),
          ...d.push({ x: xIn, y: 0.30, t: 33 }),
        ];
      } catch (e) { threw = true; pl = []; }
      check(!threw && pl.length === 0, `(e) teleport Δy=0.6 → 0 plucks, no crash`);
      // and detection resumes after the glitch
      const after = [...d.push({ x: xIn, y: 0.15, t: 66 }), ...d.push({ x: xIn, y: -0.15, t: 120 })];
      check(after.length === 4, `(e) detector resyncs after glitch (got ${after.length} plucks on next stroke)`);
    }
    // (f) UkeFrame round trip
    {
      const saved = UkeFrame.get();
      UkeFrame.set({ bridge: { x: 0.68, y: 0.62 }, angleDeg: -15, length: 0.55, spacing, aspect: 1 });
      let maxErr = 0;
      let seed = 12345;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let k = 0; k < 200; k++) {
        const p = { x: rnd() * 0.6 - 0.1, y: rnd() * 0.3 - 0.15 };
        const q = UkeFrame.toLocal(UkeFrame.toScreen(p));
        maxErr = Math.max(maxErr, Math.abs(q.x - p.x), Math.abs(q.y - p.y));
      }
      check(maxErr < 1e-9, `(f) toLocal(toScreen(p)) round trip max error ${maxErr.toExponential(2)}`);
      const segs = UkeFrame.stringScreenSegments();
      const lys = UkeFrame.stringLocalYs();
      const midOk = segs.every((sg, i) => {
        const m = UkeFrame.toLocal({ x: (sg.a.x + sg.b.x) / 2, y: (sg.a.y + sg.b.y) / 2 });
        return Math.abs(m.y - lys[i]) < 1e-9 && Math.abs(m.x - 0.55 / 2) < 1e-9;
      });
      check(midOk, `(f) string segment midpoints map to local (L/2, y_i)`);
      // aspect-corrected round trip too
      UkeFrame.set({ aspect: 16 / 9 });
      let err2 = 0;
      for (let k = 0; k < 100; k++) {
        const p = { x: rnd() * 0.6 - 0.1, y: rnd() * 0.3 - 0.15 };
        const q = UkeFrame.toLocal(UkeFrame.toScreen(p));
        err2 = Math.max(err2, Math.abs(q.x - p.x), Math.abs(q.y - p.y));
      }
      check(err2 < 1e-9, `(f) round trip with aspect 16:9 max error ${err2.toExponential(2)}`);
      // recenter puts the tip inside the strum zone, above the top string on the armed side
      const tip = { x: 0.7, y: 0.6 }, wrist = { x: 0.3, y: 0.40 };   // fretting knuckles up-left of the tip: −15.7° neck, inside the clamp
      UkeFrame.recenter(wrist, tip);
      const lt = UkeFrame.toLocal(tip);
      const [z0, z1] = UkeFrame.strumZone();
      const wantY = UkeFrame.RECENTER_TIP_Y(spacing), topY = UkeFrame.stringLocalYs()[0];
      check(Math.abs(lt.y - wantY) < 1e-9 && lt.y < topY - 0.3 * spacing && lt.x > z0 && lt.x < z1,
        `(f) recenter(): tip at local (${lt.x.toFixed(3)}, ${lt.y.toFixed(3)}) inside zone [${z0.toFixed(3)}, ${z1.toFixed(3)}], clear of the top string (${topY.toFixed(3)})`);
      const lw = UkeFrame.toLocal(wrist);
      check(Math.abs(lw.y - wantY) < 1e-6 && lw.x > lt.x, `(f) recenter(): neck aims at the fretting knuckles (local y ${lw.y.toFixed(3)} = tip y, angle ${UkeFrame.get().angleDeg.toFixed(1)}°)`);
      // level hands still give a tilted neck; a neck-down pose is clamped to the same floor
      const gl = UkeFrame.recenterG(UkeFrame.get(), { x: 0.3, y: 0.6 }, tip), gd = UkeFrame.recenterG(UkeFrame.get(), { x: 0.3, y: 0.8 }, tip);
      check(Math.abs(gl.angleDeg - UkeFrame.TILT_MIN_DEG) < 1e-9 && Math.abs(gd.angleDeg - UkeFrame.TILT_MIN_DEG) < 1e-9, `(f) recenterG(): level hands → ${gl.angleDeg.toFixed(1)}°, hands neck-down → ${gd.angleDeg.toFixed(1)}° (floor ${UkeFrame.TILT_MIN_DEG}°, never level or neck-down)`);
      const gs = UkeFrame.recenterG(UkeFrame.get(), { x: 0.3, y: 0.0 }, tip);
      check(Math.abs(gs.angleDeg + 40) < 1e-9, `(f) recenterG(): steep pose clamps at −40° (${gs.angleDeg.toFixed(1)}°)`);
      // neck zone covers the drawn fretboard (0.46L..L, half-width 2·spacing) with margin
      const nz = UkeFrame.neckZone();
      check(nz.x0 < 0.46 * 0.55 && nz.x1 > 0.55 && nz.yHalf > 2 * spacing, `(f) neckZone [${nz.x0.toFixed(3)}, ${nz.x1.toFixed(3)}] ±${nz.yHalf.toFixed(3)} encloses the fretboard`);
      UkeFrame.set(saved);
    }

    lines.unshift(pass ? 'V4 RAKE OK' : 'V4 RAKE FAILED');
    return { pass, lines };
  }

  return { createDetector, schedule, keyboardStrum, velocityToAmp, V_MAX, selfTest };
})();

if (typeof module !== 'undefined') module.exports = { UkeFrame, Strum };
