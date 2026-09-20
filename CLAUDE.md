# CLAUDE.md — Air Ukulele

Read this file at the start of every turn. If a request conflicts with it, say so before writing code.
Architecture and MVP scope: `architecture.md`. Deep design (guitar-era, still valid for the engine and strum math): `ar-guitar-plan.md`. Event schedule: `hackathon.md`. This file is the contract.

## What we are building

A browser-based air ukulele played through the laptop webcam. One self-contained `uke.html`.

- The webcam feed is shown mirrored, full-screen, with a virtual ukulele drawn on top of it.
- The **fretting hand** (left side of the screen by default) makes a real ukulele chord shape. The app **recognises which chord you are trying to play** from the hand shape and shows it large with a confidence bar. This is the delight beat of the demo.
- The **strumming hand** (right side) plucks the four on-screen strings by crossing them with the index fingertip.
- Sound is **synthesized physically**, not sampled: four Karplus-Strong strings with body resonance, through Web Audio to the laptop speakers.
- Every sound must be **verifiable against what a real standard-tuned ukulele produces**, and chord recognition must be **verifiable with a printed accuracy figure**. See "Verification". Hard requirement.

Target: Claude Build Day, 19 Sept 2026. Build window ends 15:00. Demo is 2 minutes, zero setup.

## Hard constraints

1. **Single file.** `uke.html` contains all HTML, CSS, JS. The AudioWorklet processor is a string constant loaded via a `data:` URL (a Blob URL is cross-origin on `file://` where the page origin is null). Source is developed in `src/*.js` and assembled by `node src/build.js`; the output `uke.html` is the deliverable and has no runtime build step.
2. **Runs with one double-click.** Chrome blocks `import()` of local `.mjs` files and `fetch()` of local wasm from `file://` (CORS, origin null), so the offline `vendor/` path only works over http. Ship `run.bat` that starts `python -m http.server 8000` and opens Chrome at `http://localhost:8000/uke.html`. Plain `file://` still works when online (CDN fallback). Everything else in the file must work in both modes.
3. **One external dependency only:** `@mediapipe/tasks-vision` 0.10.x (JS, wasm, `hand_landmarker.task`). Load from `./vendor/` first, fall back to jsDelivr CDN. Nothing else external.
4. **No audio samples anywhere.**
5. **Audio and camera start only from the Start button click.**
6. **Keyboard and mouse must always be able to drive the whole app** without a camera.

## MVP scope (locked with the user on 19 Sept)

In: ukulele engine (4 strings) · two-hand tracking · **chord recognition from hand shape** (rules by default, calibration optional) · sub-frame strum across 4 strings · velocity → loudness · text HUD with chord name + confidence + pitch readout · keyboard/mouse fallback · verification V1 V2 V4 V5 V8.

Out until MVP is green: bridge coupling, pick-position comb, pick hardness, string vibration animation, song prompt, predictive trigger, left-hand swap. (Neck-zone position gating was added 20 Sept as a post-event phase 8, see "Position layer".)

## File layout inside uke.html

Clearly delimited sections, banner comment each, in this order. Do not interleave.

```
1.  <style>            layout + HUD only
2.  AUDIO_WORKLET_SRC  string constant: StringVoice, Body, UkeProcessor
3.  audio/             AudioContext, worklet load, message API (pluck, setChord, setParams)
4.  tuning/            frequencies, chord table, note names, cents math
5.  tracking/          MediaPipe HandLandmarker, per-frame detect, role by screen side
6.  chord/             hand-shape normalisation, rule classifier, calibration classifier, vote
7.  uke/               fixed instrument frame, screen → local affine, 4 string lines
8.  strum/             crossing solver, sub-frame scheduler, velocity → amplitude, debounce
9.  annot/             on-instrument chord annotations (finger dots, string names, hand glyph) + right help panel
10. anchor/            blue pen-cap body anchor: HSV mask → blobs → tracker → placeFrame (position + size)
11. songs/             learn-a-song: chord charts (no lyrics), practice / play-along session, bottom strip
12. main               render + input + verify runner + wiring (src/main.js)
```

Each section lives in `src/<name>.js` as a plain top-level `const X = (() => {...})();` with a `module.exports` guard for node tests; `node src/build.js` concatenates them into `uke.html` in this order.

## Ground truth: what a real ukulele plays

Standard re-entrant tuning gCEA, A4 = 440 Hz. String 4 is nearest the player's face. Do not round these.

| String | Note | Hz |
|---|---|---|
| 4 (top) | G4 | 391.995 |
| 3 | C4 | 261.626 |
| 2 | E4 | 329.628 |
| 1 (bottom) | A4 | 440.000 |

Fretted pitch: `f = f_open · 2^(fret/12)`. Cents: `1200 · log2(f_measured / f_target)`.

Chord voicings (G C E A order):

| Chord | Frets | Notes sounded | Hz |
|---|---|---|---|
| C  | 0 0 0 3 | G4 C4 E4 C5 | 391.995 261.626 329.628 523.251 |
| G  | 0 2 3 2 | G4 D4 G4 B4 | 391.995 293.665 391.995 493.883 |
| Am | 2 0 0 0 | A4 C4 E4 A4 | 440.000 261.626 329.628 440.000 |
| F  | 2 0 1 0 | A4 C4 F4 A4 | 440.000 261.626 349.228 440.000 |
| open | 0 0 0 0 | G4 C4 E4 A4 | 391.995 261.626 329.628 440.000 |

All values are equal temperament from A4 = 440 (G4 = 440·2^(−2/12) = 391.995). `src/tuning.js` is the reference implementation.

`tuning/` must compute the Notes and Hz columns from the fret table and match this table (Hz within 0.01). That is V1.

## Chord recognition rules

Fretting hand only. Work in a **hand-normalised frame**: translate so wrist (landmark 0) is the origin, rotate so wrist → middle-finger MCP (landmark 9) points up, scale so that distance is 1. All classification uses this frame, never raw screen coordinates.

**Finger curl** for index, middle, ring, pinky: `curl = 1 − dist(tip, wrist) / dist(mcp, wrist)`, clamped to [0, 1]; a finger is *down* (fretting) when `curl > 0.35` and *up* otherwise. Thresholds are constants with a comment; expose them in the debug HUD.

**Default rule classifier** (mirrors how the real shapes are fretted; the user exaggerates on camera):

| Down fingers | Chord |
|---|---|
| none | open |
| ring only | C |
| middle only | Am |
| index + middle | F |
| index + middle + ring | G |
| all four | mute (strings play damped, ρ = 0.9) |
| anything else | keep previous chord |

Confidence for rules = smallest distance of any finger's curl from the 0.35 threshold, mapped to 0–1.

**Optional calibration classifier** (key **K**): for each of C, G, Am, F, open, hold the shape 3 s while ~60 frames of the normalised 21×3 landmark vector are captured. Store centroid and per-dimension std in `localStorage` under `uke.calib.v1`. Classify by nearest centroid with standardised Euclidean distance; confidence = `1 − d_best / d_second`. When calibration exists, it overrides rules; key **R** clears it.

**Stability:** chord output is a majority vote over the last 5 frames and only changes when the winner has ≥ 3 votes and confidence ≥ 0.5. Changing chord retunes strings for the **next** pluck only.

### Position layer (added 20 Sept) — chord *identity* is curl-based, *sounding* is position-gated

The curl classifier above decides **which** chord the hand is shaping and is never fed screen coordinates. A separate layer in `main.js` decides whether that chord may **sound**, using the fretting fingertips in **instrument-local** coordinates (`UkeFrame.toLocal`, fingertip landmark for finger n is `4n + 4`):

- **Over the neck:** ≥ 2 of the 4 fingertips inside `UkeFrame.neckZone()` (local x 0.40L–1.08L, |y| ≤ 4·spacing). Majority vote over 5 frames.
- **On the dots:** `Annot.matchFingers(chord, tips, L, spacing)` compares each fingertip with the dot from `Tuning.FINGERING` at `Annot.dotTargets` (the same numbers `drawInstrument` draws). Tolerance 0.8 of the fret space along the neck, 0.75 of the string spacing across it; `dn = hypot(dx/tolX, dy/tolY) ≤ 1`. Majority vote over 5 frames. Chords with no dots (open, mute) are trivially in position.
- **Sounding rule** (`App.soundingChord`): keyboard override → that chord · no camera → recognised chord · fretting hand absent (> 300 ms) or not over the neck → **open** · over the neck but fingers off the dots → **mute** (ρ = 0.9, a damped thud) · on the dots → the recognised chord. The HUD keeps showing the recognised shape; the line under it says what will sound and why. Song practice is fed the sounding chord, so a right shape in the wrong place never advances a bar.
- **Coaching** (`Annot.drawCoaching`, drawn after `drawInstrument`): live fingertip rings numbered by finger, an arrow from each off-position finger to its dot with a text hint ("finger 3: up one string"), green ring when on the dot, and one arrow from the hand to the fretboard when the hand is off the neck.

## Synthesis engine rules

- One `AudioWorkletProcessor`. Four `StringVoice`, one `Body`.
- `StringVoice`: **fractional delay** (linear interp or first-order allpass; integer delay is not acceptable). `N = fs / f0 − 0.5`. Loop filter `y[n] = ρ · 0.5·(x[n] + x[n−1])`, `ρ = 0.993` (nylon, shorter than guitar), `ρ = 0.9` for mute. Excitation: noise burst of length N, one fixed one-pole lowpass at ~6 kHz.
- `Body`: two peaking biquads (~300 Hz Q3 +5 dB air resonance, ~700 Hz Q2.5 +3 dB top plate) then `tanh` soft limiter on the master.
- Message API: `{type:'pluck', string, velocity, when}`, `{type:'setChord', frets:[4]}`, `{type:'setParams', …}`. `when` is AudioContext time; the processor schedules against `currentTime`.

## Tracking and strum rules

- `HandLandmarker`, `numHands: 2`, `runningMode: 'VIDEO'`, GPU delegate. Detect in `requestVideoFrameCallback`, fall back to rAF.
- Roles by **screen side** after mirroring: left half = fretting, right half = strumming. Never trust MediaPipe handedness for roles.
- Strumming fingertip = landmark 8. Keep a ring buffer of the last 6 `(x, y, t)` in **instrument-local coordinates** (fixed frame, origin at bridge, strings horizontal). Key **C** recentres the frame between current hands.
- **Sub-frame crossing detection is mandatory:** for samples `(y₀,t₀)`, `(y₁,t₁)`, every string with `y_i` strictly between gets `τ_i = t₀ + (y_i−y₀)/(y₁−y₀)·(t₁−t₀)`. Schedule plucks preserving `τ_i − τ_min`. Four strings in one audio block is a bug.
- Velocity `|Δy/Δt|` → amplitude (floor 0.3, clamp 1.0). Per-string debounce 40 ms. Discard fingertip jumps > 40% of frame height **or faster than 2·V_MAX = 6 local units/s** (a hand cannot move that fast; a role swap between hands can).
- **Silence when not strumming (added 20 Sept, after phantom plucks on camera):**
  - *Hysteresis:* each string remembers which side the tip is on and only flips when the tip is past the line by a dead band of 0.3·spacing. A parked, jittering fingertip never crosses anything. `minVelocity` is 0.4 u/s.
  - *Stroke arming:* crossings count only after the tip was seen outside the string band (|y| > 1.5·spacing + band) inside the strum zone. A tip that appears inside the band, or loiters there > 400 ms, is disarmed until it leaves and comes back.
  - *Strummer plausibility:* MediaPipe confidences 0.7 / 0.7 / 0.6; hands with handedness score < 0.6, wrists within 0.03 of the frame edge, or duplicate detections (wrists < 0.08 apart) are dropped. A lone hand changes role only past x = 0.55 / 0.45 (hysteresis). The strumming index must be extended (curl < 0.5). If the strumming wrist jumps > 0.12 local units in one frame the ring buffer is reset.
  - *Frame placement:* default bridge at (0.64, 0.62), not lap height; **C** parks the tip 2.5 spacings above the top string, not on the centreline; window resize never moves an anchored or recentred frame.
  - *Mouse:* primary button only, pointer capture, drag ends on pointerup / pointercancel / lost capture / blur / buttons released.

## Annotations, help, anchor, song (added 19 Sept after the MVP)

- **Annotations** (`Annot.drawInstrument`): real fingering from `Tuning.FINGERING` drawn as numbered dots in the fret space, string names at the nut, open 'o' markers, 'x' for mute, and a hand glyph showing which fingers to curl (`Tuning.CURL_RULE`). Green when the recognised chord equals the target, amber with "seeing: X" when not.
- **Help panel** (`Annot.renderHelp`, key **?**): every chord with a mini diagram, curl rule, key. Live highlight of the recognised chord and the song target.
- **Blue cap anchor** (`Anchor`, key **B** then click the cap): colour sampled at the click (saved in localStorage `uke.anchor.v1`), 160×90 scan per frame, largest plausible blob nearest the previous position, EMA-smoothed. `placeFrame` puts the bridge at anchor + (0.22, 0.20)·scale, scale = clamp(r / 0.025, 0.6, 1.6). Lost for > 1 s → instrument freezes. B again turns it off.
- **Song mode** (`Songs`, key **S**): Rasputin (Boney M., as heard in Dhurandhar: The Revenge) simplified to C G Am F, 126 BPM, plus a four-chord loop. Chord charts only, never lyrics. Practice mode (default) advances a bar only on a strum with the correct chord; **M** toggles play-along with tempo and score; **N** skips a bar.
- **Cover mapping**: the video is `object-fit: cover`, so `main.js` maps MediaPipe and anchor coordinates through the crop before drawing or hit-testing. Camera is requested at 1280×720 to keep the crop small.

## Verification — sound matches a real ukulele, recognition has a number

Not done until `verify/` is green. Every check prints, none is eyeballed.

- **V1 Tuning table.** Compute from `tuning/`, assert against the ground-truth table above. Runs on load.
- **V2 Pitch.** `OfflineAudioContext`: pluck each open string and each fretted note in every chord (4 open + 16 chord notes). Measure f0 with zero-padded FFT + parabolic peak interpolation. Assert `|cents| ≤ 3`, harmonics at 2f and 3f within ±1%, amplitude at 0.8 s < at 0.1 s. Print a table.
- **V4 Rake.** Synthetic fingertip path crossing all 4 strings in 60 ms over 3 fake frames → assert 4 plucks, strictly increasing `when`, in string order, span 40–80 ms. Reversed path → reversed order. Plus: a tip resting on a string with ±0.007 jitter for 2 s → 0 plucks; a 0.3 u jump in 33 ms → 0 plucks while the same jump in 60 ms → 4; entering the string band from over the neck → 0 plucks; recentre leaves the tip clear of the top string.
- **V5 Live pitch readout.** `AnalyserNode` on master; HUD shows `target / measured / cents`, green if `|cents| ≤ 3`. Same measurement function as V2.
- **V8 Chord recognition.**
  - Rules: 6 synthetic normalised hand vectors (one per row of the rule table) must classify correctly. Print each.
  - Calibration (when present): leave-one-out over stored frames, print a 5×5 confusion matrix, assert accuracy ≥ 90%.
  - Live: HUD shows the current chord, confidence, and the four curl values.

- **V9 Songs.** Every chord in every song exists in the chord table; section beat totals are multiples of 4; practice sessions advance only on the correct chord and finish after exactly N correct strums; play-along bar boundaries land within 10 ms at 120 BPM.
- **V10 Anchor.** Synthetic 160×90 frame with a blue disc, a too-small blue distractor, a too-large blue rectangle and a red disc: mask hits only blue, exactly one valid blob with the right area and centroid, tracker output mirrored correctly, hold-when-lost, nearest-to-previous tracking, scale clamps.
- **V11 Annotations.** Fingering dots agree with the chord fret table, finger numbers unique, every chord has a curl rule, fret-space centres lie between the adjacent fret lines, drawing runs without throwing for all chord names. Position layer: `dotTargets` sit in their fret space on their string; a synthetic hand on the dots matches (dn = 0), one string off does not (dn > 1), half a tolerance still counts, missing tips do not; `handOverNeck` true over the board, false over the body, two tips suffice; `drawCoaching` smoke test.
- **Smoke (runtime).** `node src/smoke-run.js` drives the live path headless with synthetic hands: Start, keyboard override, C shape off the neck → open, over the neck off the dots → mute, on the dots → C, hand strum → 4 plucks strictly increasing, resting jittery tip → 0, fist sweep → 0, lost-and-reappearing hand → 0, song hint and debug HUD, no page exceptions.

`uke.html?selftest=1` runs V1, V2, V4, V8, V9, V10, V11 and shows `ALL CHECKS PASS` or a red banner with the first failure. Run after any change to `src/`, then `node src/smoke-run.js`.

## Build order (do not reorder)

1. Shell + Start button + camera on screen + worklet loads. Test `file://`.
2. `tuning/` + V1.
3. 4-string engine, keyboard-driven (1–4 pluck, Space strum with 12 ms rake, Q W E R = C G Am F, O = open). V2 + V5 green.
4. Tracking + landmark overlay + FPS + mouse strum fallback.
5. `chord/` rule classifier + vote + HUD chord name. V8 rules green.
6. Instrument frame + crossing solver + scheduler. V4 green. Real strum plays the recognised chord.
7. Calibration flow (**K**) + V8 confusion matrix.
8. Only if all green: bridge coupling, animation, song prompt.

Do not start a phase while the previous check is red. No decorative styling before phase 6 is green.

## Keyboard map

| Key | Action |
|---|---|
| 1–4 | Pluck string (4 = G top, 1 = A bottom) |
| Space | Strum current chord, 12 ms rake |
| Q W E R | Force chord C G Am F (overrides recognition until O) |
| O | Open strings / release keyboard override |
| ? or / | Toggle help panel |
| S | Toggle song strip (Rasputin practice); restarts when finished |
| M | Song: toggle practice / play-along |
| N | Song: skip a bar |
| B | Arm cap sampling; next click on the blue cap starts anchoring. B again stops anchoring |
| K | Start calibration flow |
| Shift+R | Clear calibration (back to rules) |
| C | Recentre instrument between hands (manual fallback to the cap) |
| D | Toggle debug HUD (curls, anchor, FPS, frame) |
| V | Run self-test |
| Mouse drag across strings | Strum via the same crossing solver (unless B is armed, then click samples the cap) |

## Conventions

- Plain JS in one `<script type="module">`. No frameworks, no TypeScript.
- Every physical or musical constant has a comment with the reason.
- `tuning/`, `chord/`, `strum/` functions are pure so `verify/` can call them without camera or AudioContext.
- No `console.log` in per-frame or per-sample paths. Use the debug HUD.
- Commit at the end of every build-order phase with the phase number in the message.

## Things not to do

- No samples, no Tone.js, no soundfont.
- No strum detection by "fingertip inside a rectangle". It cannot resolve four crossings in two frames.
- No classification on raw screen coordinates. Always the hand-normalised frame.
- No anchoring the instrument to a moving hand. Fixed frame, recentre with **C**.
- No integer delay lines.
- No skipping a red check because it sounds or looks fine.
- No new features after 14:35 on event day.

## How to build, run, test

```
node src/build.js                      # concatenates src/*.js + template.html → uke.html (do this after every src edit)
run.bat                                # offline: http.server on :8000 + Chrome at http://localhost:8000/uke.html
uke.html  (double-click)               # online only: MediaPipe comes from the CDN
uke.html?selftest=1                    # V1 V2 V4 V8 in-browser, no camera needed

# headless verification (used by Claude Code; needs no display):
node src/headless-run.js "file:///C:/Users/Khand/Downloads/Rahul%20Courses/Hackathon/uke.html?selftest=1"
# → prints "PASS Air Ukulele / ALL CHECKS PASS" + the full report. Wait ~2 s between runs (shared profile dir).
node src/smoke-run.js                  # headless runtime smoke: synthetic hands through App.onTrack → "SMOKE OK"

# pure-function suites in node:
node -e "const {Tuning}=require('./src/tuning.js'); console.log(Tuning.selfTest().lines.join('\n'))"
node -e "const {UkeFrame,Strum}=require('./src/strum.js'); console.log(Strum.selfTest().lines.join('\n'))"
node -e "const {Tuning}=require('./src/tuning.js'); global.Tuning=Tuning; const {Chord}=require('./src/chord.js'); console.log(Chord.selfTest().lines.join('\n'))"
```

Status 19 Sept (afternoon): MVP phases 1–7 plus annotations, help panel, blue-cap anchor and song mode built; V1 V2 V4 V8 V9 V10 V11 green headless. The camera path was confirmed working by the user's screenshot (tracking, strum and the live pitch readout at 440 Hz). Still untested on a webcam: the cap anchor with a real pen cap, calibration flow, and song practice with hand strums.

Vendor files in `./vendor/`: `vision_bundle.mjs`, `wasm/vision_wasm_internal.js`, `wasm/vision_wasm_internal.wasm`, `wasm/vision_wasm_nosimd_internal.js`, `wasm/vision_wasm_nosimd_internal.wasm`, `hand_landmarker.task`.
