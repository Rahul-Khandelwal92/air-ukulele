// ============================================================================
// AUDIO_WORKLET_SRC — runs on the audio thread. 4 Karplus-Strong strings + body.
// Kept free of backticks and ${} so it can live inside a template string.
// ============================================================================
const AUDIO_WORKLET_SRC = `
// ---------------------------------------------------------------------------
// StringVoice: Karplus-Strong string with a fractional delay line.
// ---------------------------------------------------------------------------
class StringVoice {
  constructor(fs) {
    this.fs = fs;
    this.L = 4096;                    // ring buffer; longest delay we need is C4 at 48 kHz (~183 samples), headroom for 96 kHz too
    this.buf = new Float32Array(this.L);
    this.w = 0;                       // write index
    this.delay = 100;                 // fractional delay N (samples). N = fs/f0 - 0.5
    this.rho = 0.993;                 // loop gain per period. 0.993 -> nylon uke rings ~1-2 s; 0.9 = palm mute
    this.hz = 0;
    this.burstLeft = 0;               // remaining excitation samples
    this.burstAmp = 0;
    this.lp = 0;                      // one-pole lowpass state for the excitation
    // 6 kHz cutoff: a fingertip cannot excite the string much above this; removes fizz
    this.lpA = 1 - Math.exp(-2 * Math.PI * 6000 / fs);
  }
  setFreq(hz) {
    this.hz = hz;
    // -0.5: the two-point averaging loop filter adds exactly half a sample of delay,
    // so the total loop length N + 0.5 must equal fs/f0 for the pitch to be right.
    this.delay = this.fs / hz - 0.5;
  }
  pluck(velocity) {
    this.burstLeft = Math.round(this.delay);   // classic KS: excitation length = one period
    this.burstAmp = 0.6 * velocity;            // 0.6 keeps a 4-string strum under the limiter knee
    this.lp = 0;
    // Deterministic noise per pluck (xorshift32): same pluck → same waveform, so V2 is reproducible
    // and no random burst can hand the octave to the 2nd harmonic in one run and not the next.
    this.pluckCount = (this.pluckCount || 0) + 1;
    this.rng = (0x9E3779B9 ^ (Math.round(this.delay) * 2654435761) ^ (this.pluckCount * 40503)) >>> 0 || 1;
  }
  noise() {
    let x = this.rng; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    this.rng = x;
    return x / 2147483648 - 1;                 // uniform in [-1, 1)
  }
  tick() {
    const b = this.buf, L = this.L, w = this.w;
    const D = this.delay, iD = Math.floor(D), fD = D - iD;
    // Linear-interpolated fractional delay: x[n-D] between x[n-iD] and x[n-iD-1].
    // Linear interpolation has phase delay == fD at low frequencies, so tuning is exact
    // to well under a cent for fundamentals below fs/20.
    const i0 = (w - iD + L) % L;
    const i1 = (i0 - 1 + L) % L;
    const i2 = (i1 - 1 + L) % L;
    const xD  = (1 - fD) * b[i0] + fD * b[i1];   // x[n-D]
    const xD1 = (1 - fD) * b[i1] + fD * b[i2];   // x[n-D-1]
    // Loop filter: rho * 0.5 * (x[n-D] + x[n-D-1]) — lowpass so high harmonics decay faster (like a real string)
    let y = this.rho * 0.5 * (xD + xD1);
    if (this.burstLeft > 0) {
      const n = this.noise();
      this.lp += this.lpA * (n - this.lp);
      y += this.burstAmp * this.lp;
      this.burstLeft--;
    }
    b[w] = y;
    this.w = (w + 1) % L;
    return y;
  }
}

// ---------------------------------------------------------------------------
// Biquad peaking EQ (RBJ cookbook). Used for body resonances.
// ---------------------------------------------------------------------------
class Peak {
  constructor(fs, f0, Q, dB) {
    const A = Math.pow(10, dB / 40);
    const w0 = 2 * Math.PI * f0 / fs;
    const alpha = Math.sin(w0) / (2 * Q);
    const cw = Math.cos(w0);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * cw) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha / A) / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  tick(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// ---------------------------------------------------------------------------
// UkeProcessor: 4 strings -> DC blocker -> body EQ -> tanh limiter
// ---------------------------------------------------------------------------
class UkeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Defaults = gCEA equal temperament from A4 = 440; overwritten by setTuning
    this.openHz = [391.995, 261.626, 329.628, 440.0];
    this.frets = [0, 0, 0, 0];
    this.mute = false;
    this.rho = 0.993;                 // normal ring
    this.rhoMute = 0.9;               // palm mute: dies in ~50 periods (~0.1 s)
    this.strings = [0, 1, 2, 3].map(() => new StringVoice(sampleRate));
    this.queue = [];                  // pending plucks {when, string, velocity}
    // Body: ~300 Hz Helmholtz air resonance of a soprano uke body (Q3, +5 dB),
    // ~700 Hz first top-plate mode (Q2.5, +3 dB).
    this.body1 = new Peak(sampleRate, 300, 3.0, 5);
    this.body2 = new Peak(sampleRate, 700, 2.5, 3);
    this.dcX = 0; this.dcY = 0;       // DC blocker state (noise bursts have a small mean; loop passes DC)
    this.master = 1.0;
    // processorOptions arrive synchronously with construction. Port messages do NOT: in an
    // OfflineAudioContext the render thread runs flat out and messages posted before
    // startRendering() are only dispatched after rendering ends. So offline tests (V2) and the
    // initial tuning use processorOptions; live play uses messages.
    const po = (options && options.processorOptions) || {};
    if (Array.isArray(po.openHz) && po.openHz.length === 4) this.openHz = po.openHz.slice();
    if (Array.isArray(po.frets) && po.frets.length === 4) this.frets = po.frets.slice();
    if (typeof po.mute === 'boolean') this.mute = po.mute;
    if (Array.isArray(po.plucks)) for (const p of po.plucks) this.onMessage(Object.assign({ type: 'pluck' }, p));
    this.port.onmessage = (e) => this.onMessage(e.data);
  }
  onMessage(m) {
    switch (m.type) {
      case 'pluck':
        this.queue.push({ when: (typeof m.when === 'number') ? m.when : 0,
                          string: m.string | 0,
                          velocity: Math.min(1, Math.max(0, +m.velocity || 0)) });
        break;
      case 'setChord':
        if (Array.isArray(m.frets) && m.frets.length === 4) this.frets = m.frets.slice();
        break;
      case 'setMute':
        this.mute = !!m.mute;
        break;
      case 'setTuning':
        if (Array.isArray(m.openHz) && m.openHz.length === 4) this.openHz = m.openHz.slice();
        break;
      case 'setParams':
        if (typeof m.rho === 'number') this.rho = m.rho;
        if (typeof m.rhoMute === 'number') this.rhoMute = m.rhoMute;
        if (typeof m.master === 'number') this.master = m.master;
        break;
    }
  }
  fire(p) {
    const s = this.strings[p.string];
    if (!s) return;
    // Retune THIS string to the current chord at pluck time. Other ringing strings keep pitch.
    const hz = this.openHz[p.string] * Math.pow(2, this.frets[p.string] / 12);
    s.setFreq(hz);
    s.rho = this.mute ? this.rhoMute : this.rho;
    s.pluck(p.velocity);
    this.port.postMessage({ type: 'plucked', string: p.string, hz: hz, when: currentTime });
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    const t0 = currentTime;
    const blockEnd = t0 + n / sampleRate;
    // Pull every pluck due in this block and place it at its sample offset (sub-block accuracy keeps the rake).
    let due = null;
    for (let k = this.queue.length - 1; k >= 0; k--) {
      const p = this.queue[k];
      if (p.when < blockEnd) {
        let off = Math.round((p.when - t0) * sampleRate);
        if (off < 0) off = 0;
        if (off > n - 1) off = n - 1;
        (due || (due = [])).push({ off: off, p: p });
        this.queue.splice(k, 1);
      }
    }
    if (due) due.sort((a, b) => a.off - b.off);
    let di = 0;
    const S = this.strings;
    for (let i = 0; i < n; i++) {
      if (due) while (di < due.length && due[di].off === i) { this.fire(due[di].p); di++; }
      const s = S[0].tick() + S[1].tick() + S[2].tick() + S[3].tick();
      // DC blocker: y = x - x1 + 0.995 y1 (corner ~40 Hz at 48 kHz)
      const dc = s - this.dcX + 0.995 * this.dcY;
      this.dcX = s; this.dcY = dc;
      let y = this.body2.tick(this.body1.tick(dc));
      out[i] = Math.tanh(y * this.master);   // soft limiter: 4 hard strums never clip the speakers
    }
    return true;
  }
}
registerProcessor('uke-processor', UkeProcessor);
`;

// ============================================================================
// audio/ — main-thread wrapper, pitch measurement (pure), V2 self-test.
// Depends on: Tuning (src/tuning.js, concatenated before this file).
// ============================================================================
const AudioEngine = (() => {
  let ctx = null, node = null, analyser = null;
  let lastPluck = null;             // {string, hz} of the most recent pluck the worklet fired
  let currentChord = 'open';
  let workletUrl = null;
  let liveBuf = null;

  // data: URL, not a Blob URL: on file:// the page origin is "null" and Chrome rejects
  // blob:null/... worklet modules as cross-origin. data: URLs pass the CORS check everywhere.
  function moduleUrl() {
    if (!workletUrl) workletUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(AUDIO_WORKLET_SRC);
    return workletUrl;
  }

  // Creates a fresh worklet node on any context (online or offline). Does not touch module state.
  // `initial` = { frets, mute, plucks:[{string, velocity, when}] } is delivered via processorOptions
  // so it is guaranteed to be in place before the first render quantum (see note in the worklet).
  async function makeNode(c, initial) {
    await c.audioWorklet.addModule(moduleUrl());
    const processorOptions = Object.assign({ openHz: Array.from(Tuning.OPEN_HZ) }, initial || {});
    return new AudioWorkletNode(c, 'uke-processor', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions,
    });
  }

  async function init(existingCtx) {
    ctx = existingCtx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended' && ctx.resume) { try { await ctx.resume(); } catch (e) { /* needs user gesture; caller handles */ } }
    node = await makeNode(ctx);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;          // 8192 @ 48 kHz = 171 ms window: ~1 cent resolution after interpolation
    analyser.smoothingTimeConstant = 0;
    node.connect(analyser);
    analyser.connect(ctx.destination);
    liveBuf = new Float32Array(analyser.fftSize);
    node.port.onmessage = (e) => {
      if (e.data && e.data.type === 'plucked') lastPluck = { string: e.data.string, hz: e.data.hz };
    };
    setChord('open');
    return { ctx, node, analyser };
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  function pluck(string, velocity, when) {
    if (!node) return;
    node.port.postMessage({ type: 'pluck', string, velocity: (velocity == null ? 0.8 : velocity), when: (when == null ? 0 : when) });
  }
  function setFrets(frets) {
    if (!node) return;
    node.port.postMessage({ type: 'setChord', frets: Array.from(frets) });
  }
  function setMute(m) {
    if (!node) return;
    node.port.postMessage({ type: 'setMute', mute: !!m });
  }
  function setChord(name) {
    const frets = Tuning.CHORDS[name];
    if (!frets) throw new Error('unknown chord ' + name);
    currentChord = name;
    setMute(name === 'mute');
    setFrets(frets);
  }
  function setParams(p) { if (node) node.port.postMessage(Object.assign({ type: 'setParams' }, p)); }
  function chord() { return currentChord; }

  // ---------------------------------------------------------------------------
  // FFT (radix-2, in place). Small and dependency-free.
  // ---------------------------------------------------------------------------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {           // bit reversal
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < (len >> 1); k++) {
          const a = i + k, b = a + (len >> 1);
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr;        im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // measurePitch — PURE. Hann window, 4x zero-padded FFT, parabolic peak interpolation,
  // subharmonic correction (so a loud 2nd harmonic cannot masquerade as f0),
  // harmonic presence at 2f, 3f within +-1%.
  // ---------------------------------------------------------------------------
  function measurePitch(samples, sampleRate, opts) {
    const fmin = (opts && opts.fmin) || 150;
    const fmax = (opts && opts.fmax) || 1200;
    const len = samples.length;
    let npad = 1; while (npad < len * 4) npad <<= 1;
    if (npad > 262144) npad = 262144;
    const re = new Float32Array(npad), im = new Float32Array(npad);
    let sumW = 0;
    for (let i = 0; i < len; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1));   // Hann
      re[i] = samples[i] * w; sumW += w;
    }
    fft(re, im);
    const half = npad >> 1;
    const mag = new Float32Array(half);
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
    const binHz = sampleRate / npad;
    const toDb = (m) => 20 * Math.log10((2 * m / sumW) + 1e-12);   // full-scale sine ≈ 0 dBFS
    const kmin = Math.max(2, Math.floor(fmin / binHz)), kmax = Math.min(half - 2, Math.ceil(fmax / binHz));

    // local max within +-frac of centre frequency
    function localMax(fc, frac) {
      const a = Math.max(2, Math.floor(fc * (1 - frac) / binHz)), b = Math.min(half - 2, Math.ceil(fc * (1 + frac) / binHz));
      let bk = -1, bm = -1;
      for (let k = a; k <= b; k++) if (mag[k] > bm) { bm = mag[k]; bk = k; }
      return { k: bk, mag: bm };
    }
    function interp(k) {
      const a = Math.log(mag[k - 1] + 1e-20), b = Math.log(mag[k] + 1e-20), c = Math.log(mag[k + 1] + 1e-20);
      const den = a - 2 * b + c;
      const p = den !== 0 ? 0.5 * (a - c) / den : 0;
      return (k + p) * binHz;
    }

    let bk = kmin, bm = -1;
    for (let k = kmin; k <= kmax; k++) if (mag[k] > bm) { bm = mag[k]; bk = k; }
    let peakDb = toDb(bm);
    let k0 = bk;
    // Octave-robust fundamental: candidates are the loudest peak and its sub-multiples f/2, f/3
    // (if a real peak exists there within 30 dB). Score each candidate by the energy of its first
    // five harmonics. The true f0's series contains every peak in the signal (including the loud
    // 2nd harmonic), while the octave candidate misses the odd harmonics, so f0 always scores higher.
    let bestScore = -Infinity;
    for (const div of [1, 2, 3]) {
      const fc = bk * binHz / div;
      if (fc < fmin) continue;
      const lm = div === 1 ? { k: bk, mag: bm } : localMax(fc, 0.03);
      if (lm.k <= 0 || toDb(lm.mag) < peakDb - 30) continue;
      const f = interp(lm.k);
      let score = 0;
      for (let h = 1; h <= 5; h++) {
        if (h * f >= sampleRate / 2) break;
        const hm = localMax(h * f, 0.015);
        if (hm.k > 0) score += Math.max(0, toDb(hm.mag) + 60);   // floor at -60 dBFS
      }
      if (score > bestScore + 1e-9) { bestScore = score; k0 = lm.k; }
    }
    const hz = interp(k0);
    const fundDb = toDb(mag[k0]);
    const harmonics = [];
    for (const n of [2, 3]) {
      const lm = localMax(n * hz, 0.01);
      const present = lm.k > 0 && (n * hz < sampleRate / 2) && toDb(lm.mag) > fundDb - 40;
      harmonics.push({ n, hz: lm.k > 0 ? interp(lm.k) : 0, present });
    }
    return { hz, peakDb: fundDb, harmonics };
  }

  // Live readout for the HUD (V5). Same measurement code as V2.
  function liveReadout() {
    if (!analyser || !liveBuf) return null;
    analyser.getFloatTimeDomainData(liveBuf);
    const r = measurePitch(liveBuf, ctx.sampleRate, { fmin: 150, fmax: 1200 });
    if (r.peakDb < -50) return null;                      // silence
    const targetHz = lastPluck ? lastPluck.hz : null;
    return {
      measuredHz: r.hz,
      targetHz,
      cents: targetHz ? Tuning.cents(r.hz, targetHz) : null,
      note: Tuning.noteName(r.hz),
      string: lastPluck ? lastPluck.string : null,
    };
  }

  // ---------------------------------------------------------------------------
  // V2 — render each note alone offline and measure it.
  // ---------------------------------------------------------------------------
  async function renderOne(frets, string, velocity, sr, seconds) {
    const oc = new OfflineAudioContext(1, Math.round(sr * seconds), sr);
    const nd = await makeNode(oc, { frets: Array.from(frets), mute: false, plucks: [{ string, velocity, when: 0.01 }] });
    nd.connect(oc.destination);
    const buf = await oc.startRendering();
    return buf.getChannelData(0);
  }
  function rms(x, a, b) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }

  async function selfTestV2() {
    const sr = 48000;
    const cases = [];
    for (let s = 0; s < 4; s++) cases.push({ label: 'open', frets: Tuning.CHORDS.open, string: s });
    for (const c of Tuning.CHORD_ORDER) for (let s = 0; s < 4; s++) cases.push({ label: c, frets: Tuning.CHORDS[c], string: s });
    const lines = [];
    let pass = true;
    for (const cs of cases) {
      const x = await renderOne(cs.frets, cs.string, 0.8, sr, 1.0);
      const target = Tuning.fretHz(cs.string, cs.frets[cs.string]);
      const seg = x.subarray(Math.round(0.15 * sr), Math.round(0.65 * sr));
      const m = measurePitch(seg, sr, { fmin: 150, fmax: 1200 });
      const cents = Tuning.cents(m.hz, target);
      const harmOk = m.harmonics.every(h => h.present);
      const early = rms(x, Math.round(0.05 * sr), Math.round(0.15 * sr));
      const late = rms(x, Math.round(0.75 * sr), Math.round(0.85 * sr));
      const decayOk = late < early && early > 1e-4;
      const ok = Math.abs(cents) <= 3 && harmOk && decayOk;
      if (!ok) pass = false;
      lines.push(
        (ok ? 'PASS' : 'FAIL') + ' ' + cs.label.padEnd(4) + ' s' + cs.string + ' ' + Tuning.noteName(target).padEnd(3) +
        ' target ' + target.toFixed(3).padStart(8) + ' Hz  measured ' + m.hz.toFixed(3).padStart(8) + ' Hz  ' +
        (cents >= 0 ? '+' : '') + cents.toFixed(2).padStart(5) + ' c  harmonics ' +
        m.harmonics.map(h => (h.present ? '2f 3f'.split(' ')[h.n - 2] : '--')).join(' ') +
        '  decay ' + (decayOk ? 'ok' : 'NO') + ' (' + early.toFixed(3) + '->' + late.toFixed(3) + ')'
      );
    }
    lines.unshift(pass ? 'V2 PITCH OK' : 'V2 PITCH FAILED');
    return { pass, lines };
  }

  return { init, now, pluck, setChord, setFrets, setMute, setParams, chord,
           measurePitch, liveReadout, selfTestV2, makeNode,
           get ctx() { return ctx; }, get node() { return node; }, get analyser() { return analyser; },
           get lastPluck() { return lastPluck; } };
})();

if (typeof module !== 'undefined') module.exports = { AUDIO_WORKLET_SRC, AudioEngine };
