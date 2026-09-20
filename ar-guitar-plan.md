# AR Guitar — Build Plan

**Event:** Claude Build Day, New Delhi, Sat 19 Sept 2026. Build window 10:45–13:00 and 13:30–15:00 (≈3h45m). Demo: 2 minutes, no setup.
**Track:** Delight (with a Breakthrough-grade spine underneath).
**Deliverable:** `guitar.html` — one file, double-click, camera on, play.

**One-line pitch:** a real guitar you play in the air. Six physically modelled strings ring through a shared bridge, your strumming hand plucks them with sub-frame timing, and your fretting hand chooses chords. No samples, no wrong notes.

---

## 0. What must be true at 3:00 PM

1. Open the file, click Start, camera and audio come up in under 5 seconds.
2. Strumming across the on-screen strings makes a guitar sound with a human-sounding rake (strings fire 10–20 ms apart, not simultaneously).
3. Sliding the fretting hand along the neck changes the chord; the chord name is shown large.
4. Moving the strumming hand toward the bridge audibly brightens the tone. Strumming faster is louder and harder.
5. A judge can pick it up and not sound bad (pentatonic / chord-locked).
6. Mouse fallback works if the camera dies.

Everything else is stretch.

---

## 1. Architecture (single HTML file)

```
guitar.html
├── <video>  webcam, mirrored, full-bleed
├── <canvas> overlay: guitar body, neck, strings, hand landmarks, HUD
├── <script type="module">
│   ├── audio/      AudioWorklet (inlined as a Blob URL) — 6 coupled Karplus-Strong strings
│   ├── tracking/   MediaPipe HandLandmarker (CDN, with local vendor/ fallback)
│   ├── guitar/     guitar frame, string geometry, chord table, zone → chord
│   ├── strum/      crossing detector, sub-frame scheduler, velocity → dynamics
│   ├── render/     overlay drawing, string vibration animation, HUD
│   └── input/      mouse + keyboard fallback (1–6 pluck, Q/W/E/R chords)
└── SPEC.md (kept alongside, re-read by Claude Code every round)
```

**External dependency (the only one):** `@mediapipe/tasks-vision` JS + wasm + `hand_landmarker.task` model (~10 MB total). Load from CDN; also copy into `vendor/` next to the file and try local first. Pre-warm the tab before going on stage so everything is cached.

**Secure-context check (do at 10:50, not 2:50):** Chrome treats `file://` as a secure context, so `getUserMedia` and `AudioWorklet` should work from a double-clicked file. Verify on the actual laptop. If it fails, the fallback is `python -m http.server` and `localhost:8000`.

---

## 2. Audio engine — the spine

Runs entirely in one `AudioWorkletProcessor` at 48 kHz, 128-sample blocks. Six strings, one bridge, one body.

### 2.1 Per-string: extended Karplus-Strong / digital waveguide

- **Delay line** length `N = fs / f0 − 0.5` (the half-sample corrects for the averaging filter). Use **fractional delay** (linear interpolation or first-order allpass) — integer rounding on the high E puts it ~7 cents out of tune and judges with ears will hear it.
- **Loop filter:** `y[n] = ρ · (0.5·x[n] + 0.5·x[n−1])`, with `ρ ≈ 0.996` for open strings. Lower ρ for muted/palm effect.
- **Excitation:** white noise burst of length N, then two shaping stages:
  - **Pick hardness** — one-pole lowpass on the burst whose cutoff scales with hand velocity. Slow strum = soft, dark pluck. Fast strum = bright, hard pluck.
  - **Pick position** — comb filter `e[n] − e[n − round(β·N)]`, where `β ∈ [0.08, 0.5]` is the distance of the strumming hand from the bridge as a fraction of string length. Near the bridge → small β → thin, bright; over the soundhole → round.
- **Dynamics:** amplitude ∝ clamp(velocity), with a floor so slow strums are still audible.

### 2.2 Coupling: shared bridge

Sum all six string outputs → bridge lowpass (one-pole, ~2 kHz) → feed a small fraction `κ ≈ 0.02` back into every string's delay line. This is what makes untouched strings ring sympathetically when you hit a neighbour. Keep total loop gain strictly below 1 (check: `ρ + 6κ·g_bridge < 1`).

### 2.3 Body

Three peaking biquads on the summed output: ~100 Hz (Helmholtz air resonance, Q≈4), ~200 Hz and ~400 Hz (top plate modes, Q≈2–3), each +4 to +6 dB. Then a gentle high shelf and a limiter (soft clip `tanh`) so a six-string hard strum never distorts the projector speakers.

### 2.4 Tuning and chords

Standard tuning (Hz): E2 82.41 · A2 110.00 · D3 146.83 · G3 196.00 · B3 246.94 · E4 329.63.
`f = f_open · 2^(fret/12)`.

| Chord | Frets (low E → high E) |
|---|---|
| G  | 3 2 0 0 0 3 |
| C  | x 3 2 0 1 0 |
| D  | x x 0 2 3 2 |
| Em | 0 2 2 0 0 0 |
| Am | x 0 2 2 1 0 |
| E  | 0 2 2 1 0 0 |

`x` = string is skipped on strum (or a short muted thump, ρ = 0.9).

**Pentatonic solo mode (judge mode):** fretting-hand position along the neck maps to a G major pentatonic degree; any string plucked plays a note from the scale. Impossible to play a wrong note.

### 2.5 Checker in the loop

Before a camera exists, the engine is driven by keyboard. On every pluck, an `AnalyserNode` FFT measures the fundamental and the HUD prints `target 196.00 Hz · measured 196.1 Hz · +0.9 cents`. Green if within 3 cents. That readout stays in the final build — it is the credibility line for the demo.

---

## 3. Hand tracking

- `HandLandmarker` from `@mediapipe/tasks-vision`, `numHands: 2`, `runningMode: 'VIDEO'`, GPU delegate, `minTrackingConfidence: 0.5`.
- `detectForVideo(video, performance.now())` inside `requestVideoFrameCallback` (falls back to rAF).
- Mirror x so it feels like a mirror. Handedness from MediaPipe flips under mirroring — handle explicitly and let the user swap with a key (**H**) for left-handed players.
- **Strumming hand:** landmark 8 (index tip). Keep a ring buffer of `(x, y, t)` for the last 6 frames.
- **Fretting hand:** landmark 0 (wrist) for neck position; finger extension (tip.y < pip.y) available if we want finger-count chord select as a backup.
- HUD shows tracking FPS. Target ≥ 25 FPS on the laptop; if it falls below, drop camera resolution to 640×360.

---

## 4. Guitar frame and strum detection

### 4.1 Guitar frame

A fixed on-screen guitar, tilted about −20°, occupying the lower two-thirds of the frame. Press **C** to recentre it between the current hand positions. Fixed beats hand-anchored: zero jitter, and chord zones stay stable.

Everything is computed in **guitar-local coordinates**: origin at the bridge, x along the neck toward the headstock, y across the strings. Strings are horizontal lines `y_i = i · spacing`, i = 0..5. One 2×3 affine transform maps screen → local.

### 4.2 Chord zones

The neck is divided into 4 (later 6) zones with chord labels drawn on the fretboard. Chord = zone containing the fretting wrist's local x. Hysteresis of half a zone width so the chord does not flicker at boundaries. Changing chord retunes strings for the *next* pluck only — currently ringing strings keep ringing, like a real guitar.

### 4.3 Sub-frame crossing detection (the hard part)

A fast strum crosses six strings in ~80 ms. At 30 FPS that is two or three frames — you cannot detect six events from frames. So:

1. Transform previous and current fingertip to local: `(x₀, y₀, t₀)` and `(x₁, y₁, t₁)`.
2. For each string i with `y_i` strictly between `y₀` and `y₁`:
   `s_i = (y_i − y₀) / (y₁ − y₀)`, crossing time `τ_i = t₀ + s_i·(t₁ − t₀)`.
3. Sort crossings by τ. Schedule pluck i at `audioCtx.currentTime + (τ_i − τ_min)/1000`. The absolute delay is unavoidable; the **relative** spacing is exact, and that ~13 ms rake is most of what makes a strum sound human.
4. Pick position `β` from local x at the crossing; velocity `v = |y₁ − y₀| / (t₁ − t₀)` → hardness and amplitude; sign of `(y₁ − y₀)` → downstroke or upstroke (upstrokes slightly softer).
5. Debounce: a string cannot retrigger within 40 ms. Ignore frames where the fingertip's confidence dropped or it jumped > 40% of the frame (tracking glitch).

### 4.4 Predictive trigger (stretch, 14:10 slot)

Pipeline latency is 60–100 ms (camera exposure + inference + audio). To cancel it: extrapolate `y_pred = y₁ + v·λ` with λ ≈ measured latency, and fire strings that lie between `y₁` and `y_pred` *now*, marking them so the real crossing next frame does not retrigger. Only enabled when `|v|` is above a threshold (fast strums), since slow movements do not need it and prediction is wrong when the hand decelerates. Expose λ as a slider in the HUD and calibrate on the actual laptop.

---

## 5. Visuals

- Webcam full-bleed, slightly darkened. Guitar drawn as a translucent body silhouette with a soundhole, a fretboard with fret lines and dot inlays, and six strings.
- **Strings vibrate:** on pluck, string i renders as `y_i + A·e^(−t/τ)·sin(kx)·sin(ωt)` with A from velocity. Cheap, and the causal loop (hand crosses → string visibly rings → sound) is what judges latch onto.
- Chord name huge in the corner. Below it the tuning readout (target vs measured Hz). Fingertip drawn as a glowing pick that trails a short path.
- Nothing else. No settings panel on screen during the demo; debug HUD toggled with **D**.

---

## 6. Timeline against the day

| Time | Build | Done means |
|---|---|---|
| **10:45–11:05** | `SPEC.md` (this doc condensed to one page + demo script). HTML skeleton, Start button, camera stream on screen, AudioWorklet loads from Blob URL. **Test `file://` on this laptop.** | Video visible, a test tone plays, no console errors. |
| **11:05–11:50** | Audio engine: string class, six strings, bridge coupling, body EQ, chord table. Keyboard drives it (1–6 pluck, Q/W/E/R chords, space = strum all with 12 ms rake). | Tuning readout green on all six. A keyboard strum of G sounds like a guitar, not a harp. |
| **11:50–12:30** | MediaPipe integration, two hands, handedness, landmark overlay, FPS counter, `vendor/` fallback. Mouse fallback for strumming wired to the same detector. | ≥25 FPS; index tip tracked cleanly under room lighting. |
| **12:30–13:00** | Guitar frame, local transform, crossing detector with sub-frame scheduling, velocity → dynamics, debounce. | Log shows six crossings with monotonic τ from one physical strum. No double triggers. |
| 13:00–13:30 | Lunch. Leave the build alone. |
| **13:30–14:10** | Chord zones with hysteresis, fretboard labels, string vibration animation, pick glow, chord name, pentatonic judge mode. | Full loop: slide → chord changes → strum → sound + visuals. |
| **14:10–14:35** | Pick-position comb (hand toward bridge), latency slider + predictive trigger, soft limiter, left-handed swap, recentre key. Song mode: G–D–Em–C progression prompt that highlights the next zone. | Demo beats 2–5 in §0 all land. |
| **14:35–15:00** | **Freeze.** Record a 60 s backup video of a good run. Rehearse the 2-minute demo twice, out loud, with the laptop where it will be on stage (lighting, distance, speaker volume). Pre-load the tab. Close every other tab. | Nothing changes after 14:35. |

**Rule:** if the 12:30 checkpoint is not met by 12:45, cut predictive triggering and song mode from the plan entirely. The floor is a mouse-strummed guitar that sounds real, and that floor must exist before lunch.

---

## 7. Demo script (120 seconds)

| t | Beat | Line |
|---|---|---|
| 0–10 s | Double-click file, press Start. Camera and guitar appear. Hold hands up, landmarks lock on. | "One file. No samples, no sound library. Six strings modelled as waveguides through a shared bridge." |
| 10–35 s | Slow downstroke on G. Then a fast strum. Then slide fretting hand to D, C, Em. | "The strum crosses six strings in eighty milliseconds — two camera frames. It interpolates the hand path and schedules each string at sub-frame offsets. That rake is why it sounds like a hand and not a chord button." |
| 35–60 s | Strum over the soundhole, then move the hand to the bridge and strum again. Then hit hard vs. soft. | "Pick position is a comb filter. Hardness is your hand speed." Point at the tuning readout: "measured against target, within two cents." |
| 60–95 s | Play the four-chord progression along to the song prompt. Or: hand it to a judge in pentatonic mode. | "You can't play a wrong note." |
| 95–120 s | Toggle bridge coupling off and strum one string — the others go silent. Toggle it back on — they ring. | "That's the bridge. It's the part nobody models." |

Keep one sentence in reserve for the obvious question: *"How is this different from the hand-conductor demo this morning?"* → "The conductor maps gestures to parameters. This is an instrument: the hand is a pick with velocity and position, hitting a physical model with timing under fifteen milliseconds."

---

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Wi-Fi dies, CDN unreachable on stage | Med | `vendor/` folder next to the file, tried first. Tab pre-loaded before demo. Phone hotspot as last resort. |
| Camera permission prompt or `file://` blocks getUserMedia | Low | Verified at 10:50. Fallback `python -m http.server`. |
| Stage lighting kills tracking | Med | Test at the actual spot at 14:40. Drop resolution, raise `minTrackingConfidence`, face a light source. Mouse fallback. |
| Latency feels laggy | High | Sub-frame rake makes it *sound* right even if delayed. Predictive trigger cancels 60–80 ms. Narrate it honestly as a solved problem, not a hidden one. |
| Double triggers / chattering on a string | Med | 40 ms per-string debounce; ignore low-confidence or teleporting frames. |
| Handedness flips mid-demo | Med | Assign roles by screen side (left half = fretting, right half = strumming) rather than by MediaPipe handedness. **H** key to swap. |
| Six hard strings clip the speakers | Med | `tanh` soft limiter on the master. Set the venue volume during rehearsal. |
| Audio starts muted (autoplay policy) | Low | AudioContext created and resumed inside the Start click. |
| Camera fails completely | Low | Backup video recorded at 14:35. Mouse demo still shows the audio engine. |
| Reads as derivative of the opening hand-conductor demo | Med | Lead with the audio engine and the sub-frame timing. Do the coupling on/off beat. |

---

## 9. Fallback ladder (in order of what gets cut)

1. Predictive trigger and latency slider
2. Song mode / chord prompt
3. Pick-position comb filter
4. String vibration animation
5. Chord zones → keyboard chord select
6. Hand tracking → mouse strumming

Never cut: the coupled six-string engine, the tuning readout, the sub-frame rake.

---

## 10. Working with Claude Code during the build

- One `SPEC.md` beside the file. Every prompt starts with "re-read SPEC.md". Spec drift, not model capability, is what kills 4-hour single-file builds.
- Build in the order **engine → tracking → detection → visuals**. Each phase has a printed check (tuning cents, FPS, crossing log). Do not move on with a red check.
- Ask for the AudioWorklet as a separate string constant first so it can be reviewed in isolation; it is the part where a bug is inaudible until it is very audible.
- Keep a `git init` in the folder and commit at every checkpoint in §6 so a bad 14:20 change can be reverted in ten seconds.
