// Builds the submission copy: dist/Air-Ukulele.html = header comment + uke.html, UTF-8 throughout.
// Usage: node src/build.js && node src/dist.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const header = `<!--
  Air Ukulele — a webcam air ukulele in one file
  Claude Build Day · New Delhi · 19 Sept 2026 · built with Claude Code on Fable 5.1

  HOW TO RUN
    1. Open this file in Google Chrome (double-click). Internet is needed once: the hand tracker
       (Google MediaPipe, ~17 MB) loads from its official CDN and is then cached by the browser.
    2. Click "Start — camera + sound" and allow the camera.
    3. Left hand in the left half of the screen makes the chord shape; right index finger sweeps
       across the strings to strum. Press ? for chord help, S for the Rasputin practice song,
       B then click a blue pen cap on your shirt to make the instrument follow you, V for the self-test.
    Keyboard fallback without a camera: Q W E R = C G Am F, Space = strum, 1–4 = pluck a string.

  WHAT IS INSIDE (no samples, no frameworks, nothing else external)
    · Four Karplus-Strong strings with fractional delay, body resonance and a soft limiter, in an AudioWorklet
    · MediaPipe two-hand tracking; roles assigned by screen side; cover-crop mapping to the display
    · Chord recognition from finger curl in a hand-normalised frame (rules), optional 15 s calibration
    · Sub-frame strum detection: crossing times solved between camera frames, plucks scheduled with the real rake
    · Blue-cap body anchor (HSV blob tracking), on-instrument fingering annotations, help panel, song practice mode
    · Self-test (append ?selftest=1 or press V): every note verified against real ukulele pitch within 3 cents,
      chord recogniser, strum timing, song data, anchor detector and annotations all checked with printed results
-->
`;

const html = fs.readFileSync(path.join(root, 'uke.html'), 'utf8');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'Air-Ukulele.html');
fs.writeFileSync(out, header + html, 'utf8');

// Mojibake guard: UTF-8 text mis-decoded as cp1252 produces these sequences.
const bad = /â€|Ã.|Â./g;
const hits = (header + html).match(bad) || [];
console.log(`wrote ${out}  (${(fs.statSync(out).size / 1024).toFixed(0)} KB)  mojibake sequences: ${hits.length}`);
if (hits.length) process.exit(1);
