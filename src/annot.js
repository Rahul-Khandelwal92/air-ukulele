// ============================================================================
// annot/  — on-instrument chord annotations, hand glyph, right-hand help panel, V11
// ----------------------------------------------------------------------------
// Depends on globals Tuning (CHORDS, CHORD_ORDER, FINGERING, CURL_RULE, OPEN_NAMES)
// and UkeFrame (get, toScreen, stringLocalYs). Drawn right after UkeFrame.draw.
// Fret n sits at local x = L·2^(−n/12) — identical to UkeFrame.draw — so finger
// dots land in the fret space between fret f−1 and fret f (nut = fret 0 at x = L).
// All canvas work is guarded; selfTest() is pure apart from a stub ctx smoke test.
// ============================================================================
const Annot = (() => {
  const FINGER_NAMES = ['index', 'middle', 'ring', 'pinky'];
  const KEYS = { C: 'Q', G: 'W', Am: 'E', F: 'R', open: 'O', mute: 'fist' };
  const HELP_ORDER = () => [...Tuning.CHORD_ORDER, 'open', 'mute'];
  const COLORS = {
    dot: '#ffb74d', dotText: '#1a1a1a', text: 'rgba(255,255,255,0.88)', dim: 'rgba(255,255,255,0.6)',
    ok: '#37d67a', warn: '#ffb74d', string: 'rgba(255,255,255,0.35)', mute: 'rgba(255,92,92,0.95)',
  };

  // ------------------------------------------------------------ geometry helpers
  // Fret line n (0 = nut) measured from the bridge along the neck.
  const fretX = (n, L) => L * Math.pow(2, -n / 12);
  // Centre of the fret space for fret f: midway between fret lines f−1 and f.
  const fretSpaceX = (f, L) => 0.5 * (fretX(f - 1, L) + fretX(f, L));

  function isCtx(ctx) {
    return !!ctx && typeof ctx.beginPath === 'function' && typeof ctx.arc === 'function';
  }

  // ------------------------------------------------------------ position layer (pure)
  // Where each finger of `chord` must be, in instrument-local units, for scale length L and
  // string spacing s. drawInstrument draws exactly these, so the coaching target and the dot
  // on screen are the same number by construction (V11 asserts it).
  function dotTargets(chord, L, s) {
    const fingering = Tuning.FINGERING[chord] || [];
    return fingering.map(d => ({ finger: d.finger, s: d.s, f: d.f,
                                  local: { x: fretSpaceX(d.f, L), y: (d.s - 1.5) * s } }));
  }
  // How far a fingertip may sit from its dot and still count. Fret spaces are only ~0.03 frame-
  // heights wide and a fingertip on camera is about that size, so the tolerance is most of a cell:
  // 0.8 of the fret space along the neck, 0.75 of the string spacing across it.
  const TOL_X_FRAC = 0.8, TOL_Y_FRAC = 0.75;
  function fingerTolerance(f, L, s) {
    return { tolX: TOL_X_FRAC * (fretX(f - 1, L) - fretX(f, L)), tolY: TOL_Y_FRAC * s };
  }
  // tips: array indexed by finger number 1..4 (index, middle, ring, pinky) of local {x,y} or null.
  // Returns per-dot offsets (dx,dy in local units, dn = normalised distance, ok = dn ≤ 1),
  // allOk and a 0..1 score. A chord with no dots (open, mute) is trivially in position.
  function matchFingers(chord, tips, L, s) {
    const dots = dotTargets(chord, L, s).map(d => {
      const tip = tips && tips[d.finger];
      if (!tip || !Number.isFinite(tip.x) || !Number.isFinite(tip.y)) return { ...d, tip: null, dx: NaN, dy: NaN, dn: Infinity, ok: false };
      const { tolX, tolY } = fingerTolerance(d.f, L, s);
      const dx = tip.x - d.local.x, dy = tip.y - d.local.y;
      const dn = Math.hypot(dx / tolX, dy / tolY);
      return { ...d, tip, dx, dy, dn, ok: dn <= 1 };
    });
    const allOk = dots.every(d => d.ok);
    const score = dots.length ? dots.reduce((a, d) => a + Math.max(0, Math.min(1, 1 - d.dn / 2)), 0) / dots.length : 1;
    return { dots, allOk, score };
  }
  // The fretting hand is "over the neck" when at least two fingertips are inside the neck zone
  // ({x0, x1, yHalf} in local units — see UkeFrame.neckZone). Two, not four: curled fingers' tips
  // sit over the palm and can fall just outside the board while the hand is clearly on it.
  const OVER_NECK_MIN_TIPS = 2;
  function handOverNeck(tips, zone) {
    if (!tips || !zone) return false;
    let n = 0;
    for (const t of tips) {
      if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
      if (t.x >= zone.x0 && t.x <= zone.x1 && Math.abs(t.y) <= zone.yHalf) n++;
    }
    return n >= OVER_NECK_MIN_TIPS;
  }
  // Human hint for one dot: which way to move that finger. Local +x runs toward the nut.
  function hintFor(d, L, s) {
    if (!d.tip) return `finger ${d.finger}: not seen`;
    const { tolX, tolY } = fingerTolerance(d.f, L, s);
    const parts = [];
    if (Math.abs(d.dy) > tolY) parts.push(d.dy > 0 ? 'up one string' : 'down one string');
    if (Math.abs(d.dx) > tolX) parts.push(d.dx > 0 ? 'toward the body' : 'toward the nut');
    return `finger ${d.finger}: ${parts.join(', ') || 'almost — hold'}`;
  }

  // Pixel-space view of the current frame: P(local) → [px, py]; spacingPx from
  // two adjacent strings so it is right whatever aspect handling is in force.
  function view(w, h) {
    const fr = UkeFrame.get();
    const ys = UkeFrame.stringLocalYs();
    const P = l => { const q = UkeFrame.toScreen(l); return [q.x * w, q.y * h]; };
    const [ax, ay] = P({ x: fr.length / 2, y: ys[0] });
    const [bx, by] = P({ x: fr.length / 2, y: ys[1] });
    const spacingPx = Math.max(1, Math.hypot(bx - ax, by - ay));
    return { L: fr.length, s: fr.spacing, ys, P, spacingPx };
  }

  // Capsule (stadium) path between two points with radius r — lets us both fill
  // and outline, which round-capped strokes cannot do.
  function capsulePath(ctx, x0, y0, x1, y1, r) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;              // left normal
    const a = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(x0 + nx * r, y0 + ny * r);
    ctx.lineTo(x1 + nx * r, y1 + ny * r);
    ctx.arc(x1, y1, r, a - Math.PI / 2, a + Math.PI / 2, false);
    ctx.lineTo(x0 - nx * r, y0 - ny * r);
    ctx.arc(x0, y0, r, a + Math.PI / 2, a + 3 * Math.PI / 2, false);
    ctx.closePath();
  }

  function text(ctx, str, x, y, px, color, align = 'center', baseline = 'middle', weight = '') {
    ctx.font = `${weight ? weight + ' ' : ''}${Math.max(8, px).toFixed(1)}px system-ui, "Segoe UI", sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(str, x, y);
  }

  // ------------------------------------------------------------ PART A
  function drawInstrument(ctx, w, h, opts = {}) {
    if (!isCtx(ctx)) return;
    const chord = opts.chord;
    if (chord == null || !Tuning.CHORDS[chord]) return;
    const recognised = opts.recognised;
    const fingering = Tuning.FINGERING[chord] || [];
    const rule = Tuning.CURL_RULE[chord] || { fingers: [], text: '' };
    const { L, s, ys, P, spacingPx } = view(w, h);
    const nw = 2.0 * s;                                // neck half-width, as in UkeFrame.draw
    const isMute = chord === 'mute';

    ctx.save();
    ctx.lineJoin = 'round';

    // 4. Sounding strings — thin bright overlay (all four sound on a uke; muted strings are damped)
    if (!isMute) {
      ctx.strokeStyle = COLORS.string;
      ctx.lineWidth = Math.max(1, 0.05 * spacingPx);
      ys.forEach(y => {
        const [x0, y0] = P({ x: 0, y }), [x1, y1] = P({ x: L, y });
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      });
    }

    // 1. String names just past the bridge (tail side) so they never collide with the headstock tuners
    ys.forEach((y, i) => {
      const [x, yy] = P({ x: -0.8 * s, y });
      text(ctx, Tuning.OPEN_NAMES[i][0], x, yy, 0.55 * spacingPx, COLORS.dim, 'center', 'middle', '600');
    });

    // 2. Fret numbers 1–4 centred in the fret space, below the neck
    for (let f = 1; f <= 4; f++) {
      const [x, y] = P({ x: fretSpaceX(f, L), y: nw + 0.8 * s });
      text(ctx, String(f), x, y, 0.55 * spacingPx, COLORS.dim);
    }

    // 3. Finger dots / open markers / mute crosses
    const dotted = new Set(fingering.map(d => d.s));
    const r = 0.42 * spacingPx;
    dotTargets(chord, L, s).forEach(d => {
      const [x, y] = P(d.local);
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = COLORS.dot; ctx.fill();
      ctx.lineWidth = Math.max(1, 0.06 * spacingPx); ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
      text(ctx, String(d.finger), x, y + 0.02 * spacingPx, 0.6 * spacingPx, COLORS.dotText, 'center', 'middle', '700');
    });
    ys.forEach((y, i) => {
      const [x, yy] = P({ x: L + 0.32 * s, y });
      if (isMute) {
        const k = 0.2 * spacingPx;
        ctx.strokeStyle = COLORS.mute; ctx.lineWidth = Math.max(1, 0.1 * spacingPx);
        ctx.beginPath(); ctx.moveTo(x - k, yy - k); ctx.lineTo(x + k, yy + k);
        ctx.moveTo(x - k, yy + k); ctx.lineTo(x + k, yy - k); ctx.stroke();
      } else if (!dotted.has(i)) {
        ctx.beginPath(); ctx.arc(x, yy, 0.2 * spacingPx, 0, 2 * Math.PI);
        ctx.strokeStyle = COLORS.text; ctx.lineWidth = Math.max(1, 0.07 * spacingPx); ctx.stroke();
      }
    });

    // 5. Hand glyph above the neck near the nut, screen-aligned for readability
    drawHandGlyph(ctx, P({ x: 0.78 * L, y: -(nw + 2.6 * s) }), 1.0 * spacingPx, rule, chord, recognised, opts.position);

    ctx.restore();
  }

  // Finger indicator: four vertical pills (index → pinky), short and filled when the finger should
  // be curled, tall and outlined when it should stay straight. Reads at a glance and matches the HUD.
  // `position` (optional): 'ok' | 'off' | 'away' — the position layer's verdict for the fretting hand.
  function drawHandGlyph(ctx, [cx, cy], g, rule, chord, recognised, position) {
    const shapeOk = recognised == null || recognised === chord;
    const match = shapeOk && position !== 'off' && position !== 'away';
    const col = match ? COLORS.ok : COLORS.warn;
    const folded = new Set(rule.fingers || []);
    const pillW = 0.55 * g, gap = 0.35 * g, tall = 1.7 * g, short = 0.85 * g, r = pillW / 2;
    const totalW = 4 * pillW + 3 * gap;
    const base = cy + 0.6 * g;                            // pills stand on a common baseline
    ctx.save();
    // Soft plate behind the indicator
    const padX = 0.7 * g, plateTop = base - tall - 0.5 * g, plateH = tall + 1.9 * g;
    roundRect(ctx, cx - totalW / 2 - padX, plateTop, totalW + 2 * padX, plateH, 0.5 * g);
    ctx.fillStyle = 'rgba(8,10,14,0.55)'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.stroke();
    // Pills
    ctx.lineWidth = Math.max(1, 0.08 * g);
    const letters = ['i', 'm', 'r', 'p'];
    FINGER_NAMES.forEach((name, k) => {
      const x = cx - totalW / 2 + k * (pillW + gap);
      const hgt = folded.has(name) ? short : tall;
      roundRect(ctx, x, base - hgt, pillW, hgt, r);
      if (folded.has(name)) { ctx.fillStyle = col; ctx.fill(); }
      else { ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fill(); ctx.strokeStyle = col; ctx.stroke(); }
      text(ctx, letters[k], x + pillW / 2, base + 0.32 * g, 0.36 * g, COLORS.dim, 'center', 'middle', '600');
    });
    // Labels
    text(ctx, rule.text || '', cx, base + 0.95 * g, 0.42 * g, COLORS.text);
    if (!shapeOk) text(ctx, `seeing: ${recognised}`, cx, base + 1.45 * g, 0.4 * g, COLORS.warn);
    else if (position === 'away') text(ctx, 'left hand: onto the fretboard', cx, base + 1.45 * g, 0.4 * g, COLORS.warn);
    else if (position === 'off') text(ctx, 'fingers: onto the dots', cx, base + 1.45 * g, 0.4 * g, COLORS.warn);
    ctx.restore();
  }

  // Coaching overlay, drawn after drawInstrument. Shows the live fretting fingertips as numbered
  // rings; a finger off its dot gets an arrow to the dot and a text hint, a finger on its dot
  // turns green. When the hand is not over the neck at all, one arrow leads the hand centroid
  // to the middle of the fretboard. Only fingers the chord uses are annotated.
  //   opts: { chord, match (from matchFingers), tips [1..4] local, overNeck, handCentre local|null }
  function drawCoaching(ctx, w, h, opts = {}) {
    if (!isCtx(ctx)) return;
    const chord = opts.chord;
    if (chord == null || !Tuning.CHORDS[chord]) return;
    const { L, s, P, spacingPx } = view(w, h);
    const g = spacingPx;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    const arrow = (x0, y0, x1, y1, col) => {
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
      if (len < 0.3 * g) return;
      const ux = dx / len, uy = dy / len, head = 0.35 * g;
      const ex = x1 - ux * 0.5 * g, ey = y1 - uy * 0.5 * g;   // stop short of the dot
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = Math.max(1.5, 0.09 * g);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - ux * head - uy * 0.5 * head, ey - uy * head + ux * 0.5 * head);
      ctx.lineTo(ex - ux * head + uy * 0.5 * head, ey - uy * head - ux * 0.5 * head);
      ctx.closePath(); ctx.fill();
    };

    if (opts.overNeck === false && opts.handCentre) {
      const [hx, hy] = P(opts.handCentre), [nx, ny] = P({ x: 0.73 * L, y: 0 });
      arrow(hx, hy, nx, ny, COLORS.warn);
      text(ctx, 'move your left hand onto the fretboard', nx, ny - 3.2 * g, 0.55 * g, COLORS.warn, 'center', 'middle', '600');
      ctx.restore();
      return;
    }

    const m = opts.match;
    if (!m || !m.dots.length) { ctx.restore(); return; }
    const hints = [];
    m.dots.forEach(d => {
      const [tx, ty] = P(d.local);
      const col = d.ok ? COLORS.ok : COLORS.warn;
      if (d.ok) {                                            // filled green confirmation over the dot
        ctx.beginPath(); ctx.arc(tx, ty, 0.5 * g, 0, 2 * Math.PI);
        ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, 0.1 * g); ctx.stroke();
      }
      if (d.tip) {                                           // live fingertip ring with the finger number
        const [fx, fy] = P(d.tip);
        ctx.beginPath(); ctx.arc(fx, fy, 0.38 * g, 0, 2 * Math.PI);
        ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, 0.1 * g); ctx.stroke();
        text(ctx, String(d.finger), fx, fy + 0.02 * g, 0.5 * g, col, 'center', 'middle', '700');
        if (!d.ok) arrow(fx, fy, tx, ty, col);
      }
      if (!d.ok) hints.push(hintFor(d, L, s));
    });
    if (hints.length) {
      const [hx, hy] = P({ x: 0.73 * L, y: 2 * s + 2.4 * s });   // under the fret numbers
      hints.slice(0, 3).forEach((t, k) => text(ctx, t, hx, hy + k * 0.62 * g, 0.5 * g, COLORS.warn, 'center', 'middle', '600'));
    }
    ctx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
  }

  // ------------------------------------------------------------ PART B
  const HELP_CSS = `
#help h3{margin:0 0 8px;font:600 15px system-ui,sans-serif;color:#f4f4f4;letter-spacing:.3px}
#help .hrow{display:flex;align-items:center;gap:10px;padding:6px 8px;margin:4px 0;border-radius:8px;border:1.5px solid transparent;border-left:4px solid transparent;background:rgba(255,255,255,.04)}
#help .hrow.seen{border-color:#37d67a;background:rgba(55,214,122,.10)}
#help .hrow.target{border-left-color:#ffb74d}
#help .hrow canvas{width:64px;height:80px;flex:0 0 64px}
#help .hname{font:700 20px system-ui,sans-serif;color:#f4f4f4;display:flex;align-items:baseline;gap:8px}
#help .hkey{font:600 11px ui-monospace,Consolas,monospace;color:#000;background:#ffb74d;border-radius:4px;padding:1px 6px}
#help .hrule{font:13px system-ui,sans-serif;color:rgba(255,255,255,.7);margin-top:2px}
#help .hfoot{font:12px system-ui,sans-serif;color:rgba(255,255,255,.55);margin-top:10px;line-height:1.5}
`;

  function ensureStyle() {
    if (typeof document === 'undefined' || document.getElementById('annot-style')) return;
    const st = document.createElement('style');
    st.id = 'annot-style';
    st.textContent = HELP_CSS;
    document.head.appendChild(st);
  }

  // 64×80 CSS px diagram, drawn at 2× for crispness. Strings vertical (G leftmost), nut at top.
  function drawMiniDiagram(canvas, chord) {
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!isCtx(ctx)) return;
    const S = 2;
    canvas.width = 64 * S; canvas.height = 80 * S;
    ctx.save(); ctx.scale(S, S);
    ctx.clearRect(0, 0, 64, 80);
    const xs = [13, 26, 39, 52], nutY = 14, fh = 13;
    const isMute = chord === 'mute';
    const fingering = Tuning.FINGERING[chord] || [];
    const dotted = new Set(fingering.map(d => d.s));
    // fret lines
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
    for (let k = 1; k <= 4; k++) { ctx.beginPath(); ctx.moveTo(xs[0], nutY + fh * k); ctx.lineTo(xs[3], nutY + fh * k); ctx.stroke(); }
    // strings
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    xs.forEach(x => { ctx.beginPath(); ctx.moveTo(x, nutY); ctx.lineTo(x, nutY + fh * 4); ctx.stroke(); });
    // nut
    ctx.strokeStyle = '#f4f4f4'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(xs[0] - 1, nutY); ctx.lineTo(xs[3] + 1, nutY); ctx.stroke();
    // dots
    fingering.forEach(d => {
      const x = xs[d.s], y = nutY + fh * (d.f - 1) + fh / 2;
      ctx.beginPath(); ctx.arc(x, y, 5.2, 0, 2 * Math.PI); ctx.fillStyle = COLORS.dot; ctx.fill();
      text(ctx, String(d.finger), x, y + 0.5, 8, COLORS.dotText, 'center', 'middle', '700');
    });
    // open / mute markers above the nut
    xs.forEach((x, i) => {
      if (isMute) {
        ctx.strokeStyle = COLORS.mute; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x - 3, 5); ctx.lineTo(x + 3, 11); ctx.moveTo(x - 3, 11); ctx.lineTo(x + 3, 5); ctx.stroke();
      } else if (!dotted.has(i)) {
        ctx.beginPath(); ctx.arc(x, 8, 3, 0, 2 * Math.PI); ctx.strokeStyle = COLORS.text; ctx.lineWidth = 1.2; ctx.stroke();
      }
    });
    // string names
    xs.forEach((x, i) => text(ctx, Tuning.OPEN_NAMES[i][0], x, 74, 8, COLORS.dim));
    ctx.restore();
  }

  function renderHelp(container, opts = {}) {
    if (!container || typeof document === 'undefined') return;
    ensureStyle();
    if (!container.dataset.annotBuilt) {
      container.innerHTML = '';
      const h3 = document.createElement('h3'); h3.textContent = 'Chords'; container.appendChild(h3);
      HELP_ORDER().forEach(chord => {
        const row = document.createElement('div');
        row.className = 'hrow'; row.dataset.chord = chord;
        const cv = document.createElement('canvas');
        drawMiniDiagram(cv, chord);
        const info = document.createElement('div'); info.className = 'hinfo';
        const name = document.createElement('div'); name.className = 'hname';
        name.textContent = chord;
        const key = document.createElement('span'); key.className = 'hkey'; key.textContent = KEYS[chord] || '';
        name.appendChild(key);
        const ruleEl = document.createElement('div'); ruleEl.className = 'hrule';
        ruleEl.textContent = (Tuning.CURL_RULE[chord] || {}).text || '';
        info.appendChild(name); info.appendChild(ruleEl);
        row.appendChild(cv); row.appendChild(info);
        container.appendChild(row);
      });
      const foot = document.createElement('div'); foot.className = 'hfoot';
      foot.textContent = 'Right hand: sweep the index finger across the strings · B: click the blue cap to anchor · S: song · ?: hide';
      container.appendChild(foot);
      container.dataset.annotBuilt = '1';
    }
    const rows = container.querySelectorAll('.hrow');
    rows.forEach(row => {
      const c = row.dataset.chord;
      row.classList.toggle('seen', c === opts.recognised);
      row.classList.toggle('target', c === opts.target);
    });
  }

  // ------------------------------------------------------------ PART C (V11)
  function selfTest() {
    const lines = [];
    let pass = true;
    const check = (ok, msg) => { if (!ok) pass = false; lines.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };

    // (a) fingering ↔ chord table consistency
    for (const chord of Tuning.CHORD_ORDER) {
      const frets = Tuning.CHORDS[chord], dots = Tuning.FINGERING[chord];
      check(Array.isArray(dots), `(a) ${chord} has a FINGERING entry`);
      if (!Array.isArray(dots)) continue;
      const dotOk = dots.every(d => d.s >= 0 && d.s < 4 && frets[d.s] === d.f);
      check(dotOk, `(a) ${chord}: every dot sits on its chord fret (${dots.map(d => `s${d.s}f${d.f}`).join(' ')})`);
      const nonzero = frets.map((f, s) => (f > 0 ? s : -1)).filter(s => s >= 0);
      const oneEach = nonzero.every(s => dots.filter(d => d.s === s).length === 1) && dots.length === nonzero.length;
      check(oneEach, `(a) ${chord}: exactly one dot per fretted string (${nonzero.length} fretted, ${dots.length} dots)`);
      // (b) finger numbers 1–4, unique
      const fingers = dots.map(d => d.finger);
      check(fingers.every(n => Number.isInteger(n) && n >= 1 && n <= 4) && new Set(fingers).size === fingers.length,
        `(b) ${chord}: finger numbers valid and unique (${fingers.join(',') || 'none'})`);
    }
    // (c) curl rule for every chord incl. open/mute
    for (const chord of HELP_ORDER()) {
      const r = Tuning.CURL_RULE[chord];
      const ok = !!r && Array.isArray(r.fingers) && r.fingers.every(f => FINGER_NAMES.includes(f)) && typeof r.text === 'string';
      check(ok, `(c) ${chord}: CURL_RULE present (${r ? r.fingers.join('+') || 'none' : 'missing'})`);
    }
    // (d) fret-space centres lie strictly between fret lines, matching UkeFrame's L·2^(−n/12)
    const L = 0.55;
    for (let f = 1; f <= 4; f++) {
      const x = fretSpaceX(f, L), hi = fretX(f - 1, L), lo = fretX(f, L);
      check(x > lo && x < hi, `(d) fret space ${f}: ${x.toFixed(4)} strictly between fret ${f} (${lo.toFixed(4)}) and fret ${f - 1} (${hi.toFixed(4)})`);
    }
    check(Math.abs(fretX(0, L) - L) < 1e-12, `(d) fret 0 is the nut at x = L`);
    // (e) smoke: drawInstrument runs without throwing for every chord on a recording stub ctx
    {
      const calls = [];
      const stub = new Proxy({}, {
        get(_, prop) { return (...args) => { calls.push(String(prop)); return undefined; }; },
        set() { return true; },
      });
      let threw = null;
      try {
        for (const chord of HELP_ORDER()) drawInstrument(stub, 1920, 1080, { chord, recognised: chord === 'C' ? 'G' : chord });
        drawInstrument(stub, 1920, 1080, { chord: null });
        drawInstrument(null, 1920, 1080, { chord: 'C' });
      } catch (e) { threw = e; }
      check(!threw, `(e) drawInstrument smoke test over ${HELP_ORDER().length} chords (${calls.length} ctx calls)${threw ? ' — ' + threw.message : ''}`);
    }
    // (f) position layer: dot targets agree with the fret table and sit in their fret space on their string
    const s = 0.045;
    for (const chord of Tuning.CHORD_ORDER) {
      const dots = dotTargets(chord, L, s), fing = Tuning.FINGERING[chord];
      const geomOk = dots.length === fing.length && dots.every(d =>
        d.local.x > fretX(d.f, L) && d.local.x < fretX(d.f - 1, L) && Math.abs(d.local.y - (d.s - 1.5) * s) < 1e-12);
      check(geomOk, `(f) ${chord}: ${dots.length} dot target(s) inside fret space on the right string`);
    }
    // (g) a synthetic hand exactly on the dots matches; one string off does not; a hand over the body is not on the neck
    {
      const tipsOn = chord => { const t = [null, null, null, null, null]; dotTargets(chord, L, s).forEach(d => { t[d.finger] = { ...d.local }; }); return t; };
      const zone = { x0: 0.40 * L, x1: 1.08 * L, yHalf: 4 * s };
      for (const chord of Tuning.CHORD_ORDER) {
        const on = matchFingers(chord, tipsOn(chord), L, s);
        check(on.allOk && on.dots.every(d => d.dn < 1e-9) && on.score === 1, `(g) ${chord}: fingertips on the dots → in position (score ${on.score.toFixed(2)})`);
        const shifted = tipsOn(chord).map(t => (t ? { x: t.x, y: t.y + s } : t));        // every finger one string too low
        const off = matchFingers(chord, shifted, L, s);
        check(!off.allOk && off.dots.every(d => d.dn > 1), `(g) ${chord}: one string off → not in position (dn ${off.dots.map(d => d.dn.toFixed(2)).join(',')})`);
        const nearly = tipsOn(chord).map(t => (t ? { x: t.x, y: t.y + 0.5 * TOL_Y_FRAC * s } : t)); // half the tolerance
        check(matchFingers(chord, nearly, L, s).allOk, `(g) ${chord}: within half a tolerance still counts`);
        const missing = matchFingers(chord, [null, null, null, null, null], L, s);
        check(!missing.allOk, `(g) ${chord}: no fingertips seen → not in position`);
        check(hintFor(off.dots[0], L, s).includes('up one string'), `(g) ${chord}: hint for a finger one string too low says "up one string" (${hintFor(off.dots[0], L, s)})`);
      }
      check(matchFingers('open', [null, null, null, null, null], L, s).allOk, `(g) open: no dots → trivially in position`);
      const onNeck = [{ x: 0.7 * L, y: 0 }, { x: 0.75 * L, y: s }, { x: 0.8 * L, y: -s }, { x: 0.85 * L, y: 2 * s }];
      check(handOverNeck(onNeck, zone), `(g) four tips over the fretboard → hand over neck`);
      const onBody = onNeck.map(t => ({ x: t.x - 0.5 * L, y: t.y }));
      check(!handOverNeck(onBody, zone), `(g) tips shifted half a scale length toward the bridge → not over neck`);
      check(handOverNeck([onNeck[0], onNeck[1], null, { x: 2 * L, y: 0 }], zone), `(g) two of four tips over the neck is enough`);
      check(!handOverNeck([onNeck[0], null, null, null], zone), `(g) one tip over the neck is not enough`);
    }
    // (h) smoke: drawCoaching runs on the stub for every chord, in every position state
    {
      const stub = new Proxy({}, { get(_, prop) { return () => undefined; }, set() { return true; } });
      let threw = null;
      try {
        for (const chord of HELP_ORDER()) {
          const tips = [null, { x: 0.7 * L, y: 0 }, { x: 0.75 * L, y: s }, { x: 0.8 * L, y: -s }, { x: 0.85 * L, y: 2 * s }];
          drawCoaching(stub, 1920, 1080, { chord, match: matchFingers(chord, tips, L, s), tips, overNeck: true });
          drawCoaching(stub, 1920, 1080, { chord, match: null, tips, overNeck: false, handCentre: { x: 0.2 * L, y: 0 } });
          drawInstrument(stub, 1920, 1080, { chord, recognised: chord, position: 'off' });
          drawInstrument(stub, 1920, 1080, { chord, recognised: chord, position: 'away' });
        }
        drawCoaching(stub, 1920, 1080, { chord: null });
        drawCoaching(null, 1920, 1080, { chord: 'C' });
      } catch (e) { threw = e; }
      check(!threw, `(h) drawCoaching smoke test${threw ? ' — ' + threw.message : ''}`);
    }

    lines.unshift(pass ? 'V11 ANNOTATIONS OK' : 'V11 ANNOTATIONS FAILED');
    return { pass, lines };
  }

  return { drawInstrument, drawCoaching, renderHelp, drawMiniDiagram, fretX, fretSpaceX,
           dotTargets, fingerTolerance, matchFingers, handOverNeck, hintFor, KEYS, selfTest };
})();

if (typeof module !== 'undefined') module.exports = { Annot };
