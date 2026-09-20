# Air Ukulele

**Claude Build Day · New Delhi · 19 September 2026 · Track: Delight**
**Built in one day with Claude Code on Fable 5.1 · one HTML file · `dist/Air-Ukulele.html`**

---

## The pitch in one line

Hold up your hands to a laptop webcam and play a real-sounding ukulele. It names the chord you are making, teaches you a song, and proves every note is in tune.

## The problem

Learning an instrument has a cold-start problem. You need the instrument, you need to know where your fingers go, and you need someone to tell you if it sounded right. Most people never get past the first hour.

Air-instrument apps have never solved this. They play canned recordings, so every strum is a button press. And they cannot tell you what your hand is doing wrong.

## The solution

A webcam, a browser, one file. No install, no hardware, no account.

1. **Left hand makes the chord.** The app reads your finger shape and names the chord live: C, G, Am, F.
2. **Right finger strums.** Sweep across four strings drawn on screen. The four notes ring in order, like a real strum.
3. **The sound is physics, not recordings.** Four simulated strings, tuned to a real ukulele, with a live tuner showing how far each note is from perfect.
4. **It teaches a song.** Rasputin, four chords. It shows you the hand shape, waits until it sees it, and moves on only when you strum it right.
5. **It shows its proof.** Press V and seven test suites run in the browser and print their results. Every note within 3 cents of a real ukulele.

## Why this is different (USP)

| Every other air-instrument app | Air Ukulele |
|---|---|
| Plays recordings | Simulates the strings, and measures the pitch to prove it |
| Sees a hand waving | Knows which chord you meant, and shows how to fix it |
| Toy | Teaches a song and only advances when you get it right |
| "Trust us" | Press V, watch the tests pass |

## The hard parts, in plain words

- **A strum is faster than the camera.** Four strings are crossed in about 60 ms, which is two webcam frames. We reconstruct the finger's path between frames and compute exactly when it crossed each string, so four notes play from two pictures.
- **Hands come in every size and angle.** Landmarks are re-centred on the wrist, rotated and scaled before anything is classified, so the same rule works for everyone.
- **Realistic sound with zero samples.** Physically modelled strings and a body resonance, rendered offline and measured with a spectrum analyser to confirm the pitch.
- **The instrument fits you.** Hold both hands still for two seconds and the ukulele sizes itself from your palm and settles between your hands. Step back and it shrinks; lean in and it grows.

## Why Fable 5.1 was needed

This was not a coding-assistant build. The project spans five fields at once: digital signal processing, computer vision, geometry, browser platform quirks and music theory. Each one has a way to be subtly wrong that still looks and sounds fine. Four things Fable 5.1 did that made the difference.

**1. It held a twelve-module contract in its head and built the modules in parallel.**
Before code, the project was written as a contract: module boundaries, exact message APIs, the ground-truth frequency table, and the test each module had to pass. Fable then forked into agents that built audio, tracking, chord recognition, strum geometry, songs, anchor and annotations at the same time. Every agent shared the same context. The pieces fit on the first integration build. A model that loses track of one interface across a long session produces modules that do not connect, and a one-day build has no time to reconcile them.

**2. It refused to call the audio done until a number said so.**
Every module shipped with a self-test and the rule was: not green, not done. There was no display and no speakers for automated testing, so Fable wrote a DevTools-protocol runner that drives headless Chrome and waits for the offline audio render to finish. That runner is what let us verify pitch to within 3 cents without anyone listening.

**3. It found a root cause instead of patching a symptom.**
The first integrated run showed two notes an octave wrong that had not appeared in the module's own test. A weaker fix would have widened the tolerance. Fable traced it to random noise in the string excitation making the second harmonic occasionally louder than the fundamental, and fixed both sides: seeded the noise so every pluck is reproducible, and changed the pitch detector to score harmonic sums so it cannot be fooled. The tests have been deterministic since.

**4. It debugged the browser, not just the code.**
Three platform behaviours would have burned hours by hand. Chrome blocks local module imports and wasm from `file://`, so the offline path needs a local server. Blob-URL audio worklets fail from `file://` and a `data:` URL is needed. An offline audio context only delivers worklet messages after rendering, so tests must pass initial state through processor options. Fable found, explained and worked around each one, then wrote them into the contract so no agent rediscovered them.

The result: roughly 150 KB of code built in a day, in which every musical claim on screen is backed by a printed number.

## Try it

1. Open `dist/Air-Ukulele.html` in Chrome, click **Start**, allow the camera.
2. Left hand up, palm to camera. Curl only the middle finger: **Am**. Ring only: **C**. Index and middle: **F**. Index, middle and ring: **G**.
3. Sweep your right index finger down across the strings.
4. **?** for chord help · **S** for the song · **C** to recentre by hand · **V** for the self-test.

## Two-minute demo script

| Time | Beat |
|---|---|
| 0:00 | Open, Start, hands up. "One file, a webcam, and you're playing." |
| 0:15 | Curl fingers: Am, C, F appear live. Strum once, slowly, so the four notes ring in order. |
| 0:35 | Point at the tuner. "No recordings. Every note measured against a real ukulele." |
| 0:55 | Fast strum vs slow strum. "The camera sees two frames. We compute four crossings." |
| 1:15 | Press S. Rasputin. Hold the chord until it turns green, strum, advance. Press B, click the cap, lean side to side. |
| 1:40 | Press V. Seven suites, all green, all printed. "This was not built on vibes." |
| 1:55 | "Built today with Claude Code on Fable 5.1. Who wants to try it?" Hand over the laptop. |
