// ============================================================================
// tracking/  — MediaPipe HandLandmarker wrapper. Two hands, roles by screen side.
//
// Coordinate convention handed to the rest of the app:
//   landmarks[i] = { x, y, z } with x, y normalised to [0, 1] of the video frame,
//   x ALREADY MIRRORED (x' = 1 − x) so it lines up with the mirrored <video>
//   (CSS transform: scaleX(-1)). y grows downward. z is MediaPipe's relative
//   depth (wrist ≈ 0, negative = toward camera), left unchanged.
//   Multiply by canvas width/height to draw.
//
// Roles are assigned by screen side AFTER mirroring, never by MediaPipe
// handedness (it flips under mirroring): smaller wrist x = fretting (left
// side of the screen), larger = strumming. setSwap(true) inverts for lefties.
//
// Loading: Chrome refuses import() of local .mjs and fetch() of local wasm from
// file:// (origin null). So over http(s) we try ./vendor first then the CDN;
// over file:// we go straight to the CDN.
// ============================================================================
const Tracking = (() => {
  const MP_VERSION = '0.10.14';
  const CDN_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
  const CDN_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  // Standard MediaPipe hand topology (21 points). Kept here so the integrator
  // never needs to know it.
  const CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
    [0, 5], [5, 6], [6, 7], [7, 8],          // index
    [5, 9], [9, 10], [10, 11], [11, 12],     // middle
    [9, 13], [13, 14], [14, 15], [15, 16],   // ring
    [13, 17], [17, 18], [18, 19], [19, 20],  // pinky
    [0, 17],                                 // palm base
  ];

  let landmarker = null;
  let source = null;        // 'vendor' | 'cdn'
  let delegate = null;      // 'GPU' | 'CPU'
  let swap = false;

  // per-frame guard + fps EMA
  let lastVideoTime = -1;
  let lastResult = { fretting: null, strumming: null, fps: 0 };
  let lastDetectMs = 0;
  let fps = 0;
  const FPS_ALPHA = 0.1;   // EMA smoothing; ~10-frame memory

  function resolveBaseDir() {
    // Directory of the page (uke.html sits at the project root; the test page
    // sits in src/, so allow an override via Tracking.vendorPath).
    return Tracking.vendorPath || './vendor';
  }

  function candidateSources() {
    const isHttp = location.protocol === 'http:' || location.protocol === 'https:';
    const vendorBase = resolveBaseDir();
    const vendor = {
      name: 'vendor',
      bundle: `${vendorBase}/vision_bundle.mjs`,
      wasm: `${vendorBase}/wasm`,
      model: `${vendorBase}/hand_landmarker.task`,
    };
    const cdn = {
      name: 'cdn',
      bundle: `${CDN_BASE}/vision_bundle.mjs`,
      wasm: `${CDN_BASE}/wasm`,
      model: CDN_MODEL,
    };
    return isHttp ? [vendor, cdn] : [cdn];
  }

  // Resolve a possibly-relative URL against the page so import() and the wasm
  // loader agree on where things live.
  function abs(url) {
    try { return new URL(url, location.href).href; } catch (_) { return url; }
  }

  async function createLandmarker(vision, HandLandmarker, modelAssetPath, wantDelegate) {
    return HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath, delegate: wantDelegate },
      runningMode: 'VIDEO',
      numHands: 2,
      // Raised from the 0.5 defaults: in VIDEO mode a hand leaving the frame lingers on its old
      // ROI with a jittery skeleton until tracking confidence fails, and that ghost sat exactly
      // where the strings are. Real hands at arm's length score > 0.9.
      minHandDetectionConfidence: 0.7,
      minHandPresenceConfidence: 0.7,
      minTrackingConfidence: 0.6,
    });
  }

  async function init({ onStatus } = {}) {
    const status = (m) => { if (onStatus) onStatus(m); };
    const errors = [];
    for (const src of candidateSources()) {
      try {
        status(`loading MediaPipe from ${src.name}…`);
        const mod = await import(abs(src.bundle));
        const { FilesetResolver, HandLandmarker } = mod;
        const vision = await FilesetResolver.forVisionTasks(abs(src.wasm));
        const model = abs(src.model);
        try {
          landmarker = await createLandmarker(vision, HandLandmarker, model, 'GPU');
          delegate = 'GPU';
        } catch (gpuErr) {
          status(`GPU delegate failed (${gpuErr && gpuErr.message}); trying CPU`);
          landmarker = await createLandmarker(vision, HandLandmarker, model, 'CPU');
          delegate = 'CPU';
        }
        source = src.name;
        Tracking.source = source;
        Tracking.delegate = delegate;
        status(`MediaPipe ready (${source}, ${delegate})`);
        return { source, delegate };
      } catch (e) {
        errors.push(`${src.name}: ${e && e.message ? e.message : e}`);
        status(`MediaPipe ${src.name} failed: ${e && e.message ? e.message : e}`);
      }
    }
    throw new Error('MediaPipe failed to load. ' + errors.join(' | '));
  }

  async function startCamera(videoEl, { width = 640, height = 480 } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: width }, height: { ideal: height }, facingMode: 'user' },
      audio: false,
    });
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    await new Promise((resolve) => {
      if (videoEl.readyState >= 1) return resolve();
      videoEl.onloadedmetadata = () => resolve();
    });
    await videoEl.play();
    return { width: videoEl.videoWidth, height: videoEl.videoHeight, stream };
  }

  function toHand(rawLandmarks, handednessEntry) {
    const landmarks = rawLandmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })); // mirror x
    const cat = handednessEntry && handednessEntry[0];
    return {
      landmarks,
      handedness: cat ? cat.categoryName : 'Unknown',   // raw MediaPipe label, informational
      score: cat ? cat.score : 0,
    };
  }

  // Plausibility filters before roles are assigned. All in mirrored normalised coords.
  const MIN_HANDEDNESS_SCORE = 0.6; // ambiguous left/right is a good proxy for a bad detection (face, sleeve, ghost)
  const DUP_WRIST_DIST = 0.08;      // two "hands" with wrists this close are one hand detected twice
  const EDGE_MARGIN = 0.03;         // a wrist this close to the frame border is a hand leaving the frame
  const ROLE_HI = 0.55, ROLE_LO = 0.45; // single-hand role hysteresis around the x = 0.5 midline
  let lastSingleRole = null;        // 'fretting' | 'strumming' — what the lone hand was last frame

  function plausibleHands(hands) {
    const out = [];
    for (const h of hands) {
      if (h.score < MIN_HANDEDNESS_SCORE) continue;
      const w = h.landmarks[0];
      if (w.x < EDGE_MARGIN || w.x > 1 - EDGE_MARGIN || w.y < EDGE_MARGIN || w.y > 1 - EDGE_MARGIN) continue;
      const dup = out.findIndex(o => Math.hypot(o.landmarks[0].x - w.x, o.landmarks[0].y - w.y) < DUP_WRIST_DIST);
      if (dup >= 0) { if (h.score > out[dup].score) out[dup] = h; continue; }
      out.push(h);
    }
    return out;
  }

  // Assign roles by mirrored wrist x. Returns { fretting, strumming }.
  // With one hand, the role only changes when the wrist is clearly past the midline, so a
  // hand hovering near x = 0.5 cannot flip roles frame to frame (which would teleport the
  // "strumming tip" and rake every string between the two positions).
  function assignRoles(rawHands) {
    const hands = plausibleHands(rawHands);
    let fretting = null, strumming = null;
    if (hands.length >= 2) {
      const [a, b] = hands;
      const aLeft = a.landmarks[0].x < b.landmarks[0].x;
      fretting = aLeft ? a : b;
      strumming = aLeft ? b : a;
      lastSingleRole = null;
    } else if (hands.length === 1) {
      const h = hands[0], x = h.landmarks[0].x;
      let role = lastSingleRole;
      if (x > ROLE_HI) role = 'strumming';
      else if (x < ROLE_LO) role = 'fretting';
      else if (!role) role = x < 0.5 ? 'fretting' : 'strumming';
      lastSingleRole = role;
      if (role === 'fretting') fretting = h; else strumming = h;
    } else {
      lastSingleRole = null;
    }
    if (swap) return { fretting: strumming, strumming: fretting };
    return { fretting, strumming };
  }

  function detect(videoEl, nowMs) {
    if (!landmarker) return lastResult;
    if (videoEl.readyState < 2) return lastResult;
    // Only run inference once per new video frame.
    if (videoEl.currentTime === lastVideoTime) return lastResult;
    lastVideoTime = videoEl.currentTime;

    const t = (typeof nowMs === 'number') ? nowMs : performance.now();
    const res = landmarker.detectForVideo(videoEl, t);

    if (lastDetectMs > 0) {
      const inst = 1000 / Math.max(1, t - lastDetectMs);
      fps = fps === 0 ? inst : fps + FPS_ALPHA * (inst - fps);
    }
    lastDetectMs = t;

    const handednessList = res.handednesses || res.handedness || [];
    const hands = (res.landmarks || []).map((lm, i) => toHand(lm, handednessList[i]));
    const roles = assignRoles(hands);
    lastResult = { fretting: roles.fretting, strumming: roles.strumming, fps };
    return lastResult;
  }

  // Drive detect() from the video's own frame clock. cb(result, nowMs).
  function onFrame(videoEl, cb) {
    let stopped = false;
    const useRVFC = typeof videoEl.requestVideoFrameCallback === 'function';
    const tick = (now) => {
      if (stopped) return;
      const t = (typeof now === 'number') ? now : performance.now();
      const result = detect(videoEl, t);
      cb(result, t);
      if (useRVFC) videoEl.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    if (useRVFC) videoEl.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
    return () => { stopped = true; };
  }

  function drawLandmarks(ctx, hand, w, h, color = '#4cf') {
    if (!hand) return;
    const pts = hand.landmarks;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      ctx.moveTo(pts[a].x * w, pts[a].y * h);
      ctx.lineTo(pts[b].x * w, pts[b].y * h);
    }
    ctx.stroke();
    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(pts[i].x * w, pts[i].y * h, i === 8 || i === 0 ? 6 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function setSwap(v) { swap = !!v; }
  function getSwap() { return swap; }
  function isReady() { return !!landmarker; }

  return {
    init, startCamera, detect, onFrame, drawLandmarks, assignRoles, plausibleHands,
    setSwap, getSwap, isReady,
    CONNECTIONS, MP_VERSION,
    vendorPath: null,   // override e.g. '../vendor' when the page is not at project root
    source: null,       // 'vendor' | 'cdn' after init
    delegate: null,     // 'GPU' | 'CPU' after init
  };
})();

if (typeof module !== 'undefined') module.exports = { Tracking };
