// ============================================================================
// anchor/  — blue-pen-cap body anchor. The instrument follows the cap on the
// player's T-shirt: position AND size. The user clicks the cap once to sample
// its colour. Detection maths are pure functions over an ImageData-like
// {data, width, height} so they run in node; only sampleFrame touches the DOM.
// ============================================================================
const Anchor = (() => {
  const params = {
    hueTol: 18,        // degrees of circular hue distance accepted around the target; blue ink varies ±15° under mixed lighting
    satMin: 0.35,      // below this a pixel is grey/white (T-shirt, wall), never the cap
    valMin: 0.2,       // below this it is shadow; hue is unreliable in the dark
    minAreaFrac: 0.0004, // 160×90 → 5.8 px: rejects specks and blue sensor noise
    maxAreaFrac: 0.02,   // 160×90 → 288 px: rejects jeans, blue walls, blue shirts
    smooth: 0.15,      // EMA alpha per update; ~6 frames to settle, kills jitter without visible lag
    lostMs: 1000,      // after this long unseen the integrator freezes the instrument in place
    scanW: 160,        // scan resolution; 160×90 keeps mask+blobs well under 3 ms
    scanH: 90,
  };

  const STORE_KEY = 'uke.anchor.v1';
  const DEFAULT_TARGET = { h: 220, s: 0.7, v: 0.6 };   // generic blue pen cap before the user samples
  let target = { ...DEFAULT_TARGET };

  // R_REF: a pen cap seen at arm's length on a 640×480 webcam is ~12 px tall in a 480 px frame
  // ≈ 2.5% of frame height. r/R_REF = 1 means "the size we designed the default instrument for".
  const R_REF = 0.025;

  // -------------------------------------------------------------- colour
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    return { h, s: max > 0 ? d / max : 0, v: max };
  }
  function hueDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // -------------------------------------------------------------- target colour
  function setTarget(t) { target = { h: +t.h, s: +t.s, v: +t.v }; }
  function getTarget() { return { ...target }; }
  function save() {
    if (typeof localStorage === 'undefined') return false;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(target)); return true; } catch (e) { return false; }
  }
  function load() {
    if (typeof localStorage === 'undefined') return false;
    try {
      const s = localStorage.getItem(STORE_KEY);
      if (!s) return false;
      const t = JSON.parse(s);
      if (typeof t.h === 'number' && typeof t.s === 'number' && typeof t.v === 'number') { setTarget(t); return true; }
    } catch (e) { }
    return false;
  }
  // Average HSV of a (2r+1)² patch. (nx, ny) are MIRRORED normalized screen coords, so un-mirror x.
  function sampleColorAt(img, nx, ny, radius) {
    radius = radius == null ? 2 : radius;
    const W = img.width, H = img.height, d = img.data;
    const px = Math.round((1 - nx) * (W - 1)), py = Math.round(ny * (H - 1));
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = Math.max(0, py - radius); y <= Math.min(H - 1, py + radius); y++)
      for (let x = Math.max(0, px - radius); x <= Math.min(W - 1, px + radius); x++) {
        const i = 4 * (y * W + x);
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    if (!n) return null;
    return rgbToHsv(r / n, g / n, b / n);
  }

  // -------------------------------------------------------------- frame capture (DOM only here)
  let scanCanvas = null, scanCtx = null;
  function sampleFrame(videoEl, scanW, scanH) {
    scanW = scanW || params.scanW; scanH = scanH || params.scanH;
    if (!videoEl || videoEl.readyState < 2) return null;
    if (!scanCanvas || scanCanvas.width !== scanW || scanCanvas.height !== scanH) {
      scanCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(scanW, scanH) : document.createElement('canvas');
      scanCanvas.width = scanW; scanCanvas.height = scanH;
      scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    }
    scanCtx.drawImage(videoEl, 0, 0, scanW, scanH);   // not mirrored; coordinates are mirrored later
    return scanCtx.getImageData(0, 0, scanW, scanH);
  }

  // -------------------------------------------------------------- mask + blobs (pure)
  function mask(img, tgt, p) {
    tgt = tgt || target; p = p || params;
    const W = img.width, H = img.height, d = img.data;
    const out = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      const c = rgbToHsv(d[j], d[j + 1], d[j + 2]);
      if (c.s >= p.satMin && c.v >= p.valMin && hueDiff(c.h, tgt.h) <= p.hueTol) out[i] = 1;
    }
    return out;
  }

  // Connected components, 4-neighbour, iterative flood fill with an explicit stack (no recursion).
  function blobs(m, W, H, p) {
    p = p || params;
    const minA = p.minAreaFrac * W * H, maxA = p.maxAreaFrac * W * H;
    const seen = new Uint8Array(W * H);
    const stack = new Int32Array(W * H);
    const out = [];
    for (let s = 0; s < W * H; s++) {
      if (!m[s] || seen[s]) continue;
      let sp = 0, area = 0, sx = 0, sy = 0;
      stack[sp++] = s; seen[s] = 1;
      while (sp > 0) {
        const i = stack[--sp];
        const x = i % W, y = (i - x) / W;
        area++; sx += x; sy += y;
        if (x > 0     && m[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < W - 1 && m[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
        if (y > 0     && m[i - W] && !seen[i - W]) { seen[i - W] = 1; stack[sp++] = i - W; }
        if (y < H - 1 && m[i + W] && !seen[i + W]) { seen[i + W] = 1; stack[sp++] = i + W; }
      }
      if (area < minA || area > maxA) continue;
      out.push({ cx: sx / area, cy: sy / area, area, r: Math.sqrt(area / Math.PI) });
    }
    out.sort((a, b) => b.area - a.area);
    return out;
  }

  // prev = {cx, cy} in pixels. Prefer the blob nearest to prev within 25% of the width; else the largest.
  function pick(list, prev, W) {
    if (!list.length) return null;
    if (prev && W) {
      let best = null, bd = 0.25 * W;
      for (const b of list) {
        const d = Math.hypot(b.cx - prev.cx, b.cy - prev.cy);
        if (d <= bd) { bd = d; best = b; }
      }
      if (best) return best;
    }
    return list[0];
  }

  // -------------------------------------------------------------- tracker
  function createTracker(p) {
    p = Object.assign({}, params, p || {});
    let last = null;            // {x, y, r} smoothed, mirrored normalized
    let prevPx = null;          // {cx, cy} pixels, unmirrored, for nearest-to-prev
    let lastSeenMs = null;
    function update(img, nowMs) {
      const W = img.width, H = img.height;
      const b = pick(blobs(mask(img, target, p), W, H, p), prevPx, W);
      if (b) {
        prevPx = { cx: b.cx, cy: b.cy };
        const x = 1 - b.cx / W, y = b.cy / H, r = b.r / H;   // mirrored to match the displayed video
        if (!last) last = { x, y, r };
        else { const a = p.smooth; last = { x: last.x + a * (x - last.x), y: last.y + a * (y - last.y), r: last.r + a * (r - last.r) }; }
        lastSeenMs = nowMs;
        return { x: last.x, y: last.y, r: last.r, visible: true, lostForMs: 0 };
      }
      const lost = lastSeenMs == null ? Infinity : nowMs - lastSeenMs;
      if (last) return { x: last.x, y: last.y, r: last.r, visible: false, lostForMs: lost };
      return { x: NaN, y: NaN, r: NaN, visible: false, lostForMs: lost };
    }
    function reset() { last = null; prevPx = null; lastSeenMs = null; }
    return { update, reset, last: () => (last ? { ...last } : null) };
  }

  // -------------------------------------------------------------- geometry (pure)
  // The cap sits on the chest. In the mirrored view the strumming hand is on the right, so the
  // uke body (bridge) hangs below-right of the cap. Offsets scale with apparent cap size.
  function placeFrame(anchor, base) {
    const scale = Math.min(1.6, Math.max(0.6, anchor.r / R_REF));
    return {
      bridge: { x: anchor.x + 0.22 * scale, y: anchor.y + 0.20 * scale },
      length: base.length * scale,
      spacing: base.spacing * scale,
      scale,
    };
  }

  function drawMarker(ctx, a, w, h) {
    if (!ctx || !a || !isFinite(a.x)) return;
    const x = a.x * w, y = a.y * h, r = Math.max(6, a.r * h);
    ctx.save();
    ctx.strokeStyle = a.visible ? '#37d67a' : 'rgba(255,255,255,.4)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r * 1.4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - r * 0.6, y); ctx.lineTo(x + r * 0.6, y);
    ctx.moveTo(x, y - r * 0.6); ctx.lineTo(x, y + r * 0.6);
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------- V10 self-test
  function makeFrame(W, H, shapes) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { data[4 * i] = 120; data[4 * i + 1] = 120; data[4 * i + 2] = 120; data[4 * i + 3] = 255; }
    const put = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = 4 * (y * W + x); data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
    for (const s of shapes) {
      if (s.type === 'disc') {
        for (let y = Math.floor(s.cy - s.r); y <= Math.ceil(s.cy + s.r); y++)
          for (let x = Math.floor(s.cx - s.r); x <= Math.ceil(s.cx + s.r); x++)
            if ((x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r) put(x, y, s.c);
      } else if (s.type === 'rect') {
        for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) put(x, y, s.c);
      }
    }
    return { data, width: W, height: H };
  }

  function selfTest() {
    const lines = [];
    let pass = true;
    const check = (ok, msg) => { pass = pass && !!ok; lines.push((ok ? 'PASS ' : 'FAIL ') + msg); };
    const BLUE = [30, 80, 220], RED = [220, 40, 40];
    const W = 160, H = 90;
    const savedTarget = getTarget();
    setTarget({ ...DEFAULT_TARGET });

    const hsvBlue = rgbToHsv(0, 0, 255);
    check(Math.abs(hsvBlue.h - 240) < 1e-9 && hsvBlue.s === 1 && hsvBlue.v === 1, `rgbToHsv(0,0,255) → h ${hsvBlue.h.toFixed(1)} s ${hsvBlue.s} v ${hsvBlue.v}`);
    const capHsv = rgbToHsv(...BLUE);
    check(hueDiff(capHsv.h, DEFAULT_TARGET.h) <= params.hueTol, `synthetic cap colour hue ${capHsv.h.toFixed(1)}° within ${params.hueTol}° of default target ${DEFAULT_TARGET.h}°`);

    const frame = makeFrame(W, H, [
      { type: 'disc', cx: 40, cy: 30, r: 6, c: BLUE },            // the cap
      { type: 'disc', cx: 120, cy: 60, r: 1, c: BLUE },           // too small
      { type: 'rect', x0: 90, y0: 40, x1: 150, y1: 80, c: BLUE }, // too large (61×41 = 2501 px > 288)
      { type: 'disc', cx: 80, cy: 45, r: 6, c: RED },             // wrong colour
    ]);
    const m = mask(frame);
    const at = (x, y) => m[y * W + x];
    check(at(40, 30) === 1, 'mask: cap centre (40,30) is 1');
    check(at(120, 40) === 1, 'mask: big blue rect (120,40) is 1 (colour matches, size filter is later)');
    check(at(80, 45) === 0, 'mask: red disc (80,45) is 0');
    check(at(10, 10) === 0, 'mask: grey background (10,10) is 0');

    const bl = blobs(m, W, H);
    check(bl.length === 1, `blobs: exactly one valid blob (got ${bl.length})`);
    if (bl.length) {
      const b = bl[0], expA = Math.PI * 36;
      check(Math.abs(b.area - expA) / expA <= 0.15, `blobs: area ${b.area} within ±15% of π·36 = ${expA.toFixed(1)}`);
      check(Math.abs(b.cx - 40) <= 1 && Math.abs(b.cy - 30) <= 1, `blobs: centroid (${b.cx.toFixed(2)}, ${b.cy.toFixed(2)}) within 1 px of (40,30)`);
    }

    const tr = createTracker();
    const t1 = tr.update(frame, 0);
    check(t1.visible && Math.abs(t1.x - 0.75) < 0.01 && Math.abs(t1.y - 30 / 90) < 0.01, `tracker: mirrored x ${t1.x.toFixed(3)} ≈ 0.750, y ${t1.y.toFixed(3)} ≈ 0.333, visible`);
    check(Math.abs(t1.r - 6 / 90) < 0.01, `tracker: r ${t1.r.toFixed(4)} ≈ ${(6 / 90).toFixed(4)} (radius / frame height)`);

    const empty = makeFrame(W, H, []);
    let te = null;
    for (let i = 1; i <= 3; i++) te = tr.update(empty, 400 * i);
    check(te && !te.visible && te.lostForMs === 1200 && Math.abs(te.x - t1.x) < 1e-12, `tracker: after 3 empty frames visible=false, lostForMs ${te && te.lostForMs}, position held`);
    check(te.lostForMs >= params.lostMs, `tracker: lostForMs ${te.lostForMs} ≥ lostMs ${params.lostMs} → integrator would freeze`);

    // Nearest-to-prev: cap moved 5 px right, same-size decoy far away (decoy is first in area order if slightly bigger)
    const frame2 = makeFrame(W, H, [
      { type: 'disc', cx: 45, cy: 30, r: 6, c: BLUE },
      { type: 'disc', cx: 130, cy: 75, r: 6.5, c: BLUE },
    ]);
    const bl2 = blobs(mask(frame2), W, H);
    const chosen = pick(bl2, { cx: 40, cy: 30 }, W);
    check(bl2.length === 2 && chosen && Math.abs(chosen.cx - 45) <= 1, `pick: nearest-to-prev chooses moved cap at cx ${chosen && chosen.cx.toFixed(1)} (decoy at 130 is larger)`);
    check(pick(bl2, null, W).cx > 100, 'pick: without prev, the largest blob wins');
    const tr2 = createTracker();
    tr2.update(frame, 0);
    const t2 = tr2.update(frame2, 33);
    check(t2.visible && t2.x > 0.70 && t2.x < 0.75, `tracker: follows moved cap (x ${t2.x.toFixed(3)}, EMA toward 0.719) not the decoy`);

    const base = { length: 0.55, spacing: 0.045 };
    const p1 = placeFrame({ x: 0.5, y: 0.4, r: R_REF }, base);
    check(Math.abs(p1.scale - 1) < 1e-12 && Math.abs(p1.bridge.x - 0.72) < 1e-12 && Math.abs(p1.bridge.y - 0.60) < 1e-12, `placeFrame: r = R_REF → scale 1, bridge (${p1.bridge.x.toFixed(2)}, ${p1.bridge.y.toFixed(2)})`);
    check(placeFrame({ x: 0, y: 0, r: 0.001 }, base).scale === 0.6, 'placeFrame: tiny cap clamps scale to 0.6');
    check(placeFrame({ x: 0, y: 0, r: 1 }, base).scale === 1.6, 'placeFrame: huge cap clamps scale to 1.6');
    check(Math.abs(placeFrame({ x: 0, y: 0, r: R_REF * 1.2 }, base).length - 0.55 * 1.2) < 1e-12, 'placeFrame: length scales linearly with r');

    // click-to-sample: mirrored click on the cap should return the cap's hue
    const sampled = sampleColorAt(frame, 1 - 40 / 159, 30 / 89, 2);
    check(sampled && hueDiff(sampled.h, capHsv.h) < 2, `sampleColorAt (mirrored coords) hue ${sampled && sampled.h.toFixed(1)}° ≈ cap ${capHsv.h.toFixed(1)}°`);

    // timing
    const tt = createTracker();
    const t0 = Date.now();
    const N = 200;
    for (let i = 0; i < N; i++) tt.update(frame, i * 33);
    const msPer = (Date.now() - t0) / N;
    check(msPer < 3, `timing: ${msPer.toFixed(3)} ms per update at 160×90 (< 3 ms)`);

    setTarget(savedTarget);
    lines.unshift(pass ? 'V10 ANCHOR OK' : 'V10 ANCHOR FAILED');
    return { pass, lines };
  }

  return { params, R_REF, DEFAULT_TARGET, rgbToHsv, hueDiff, sampleFrame, setTarget, getTarget, save, load,
           sampleColorAt, mask, blobs, pick, createTracker, placeFrame, drawMarker, selfTest };
})();

if (typeof module !== 'undefined') module.exports = { Anchor };
