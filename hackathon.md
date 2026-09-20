# Claude Build Day — Winning Ideas

**Event:** New Delhi | Claude Build Day — Sat 19 Sept, 10:00–16:00, Webkul, Sector 63 Noida
**Model:** Fable 5.1 (`/model` → `claude-fable-5-1`) — set this before you start, not mid-build.
**Tracks:** Delight · Breakthrough · Everyday

> These are pattern-matched to this exact format — ~4 hours of build time, a 2-minute demo, a judged round — not a list of verified past winners.

The constraint that decides everything: **your demo is 120 seconds with no setup.** That kills most good ideas and elevates a specific shape.

---

## What actually wins this format

1. **Zero-setup.** Single `.html` file, double-click, runs. No npm, no API key on stage, no "let me just start the server."
2. **A number or a sound that changes live.** Judges need a visible causal loop: I do X → the thing responds. Static beauty loses to responsive beauty.
3. **A hard spine underneath.** The Delight bar is "couldn't have made it this good, this fast." That means real math — a solver, a parser, a physical model — not a CSS animation.
4. **One idea, executed fully.** Three half-features lose to one feature that's airtight.
5. **Don't build what the opening demo builds.** They're showing a webcam hand-conductor and an N-body sim at 10:15. Anything adjacent reads as derivative by 3pm.

---

## Delight

### Draw-a-shape wind tunnel — *top pick*
Sketch any 2D shape with the mouse; real-time stable-fluids Navier–Stokes solves flow around it in a GPU shader, with streamlines, a pressure heatmap, and a live-computed drag coefficient.

- **Demo beat:** draw a teardrop → Cd reads low; draw a brick → Cd triples and you watch the vortex street start shedding.
- **Hard part:** semi-Lagrangian advection, pressure projection, arbitrary boundary masks from a canvas.
- **Why it wins:** best ratio of demo impact to build risk. Self-explanatory with zero narration, plus the number-that-changes judges latch onto.

### Physically-modeled tabla + raga engine
Modal synthesis of a mass-loaded circular membrane — the loading at the center is *why* a tabla has harmonic (not inharmonic) overtones, unlike a Western drum. Layer a tanpura drone and a melodic agent constrained to a raga's aaroh/avaroh and pakad.

- **Demo beat:** set the loading mass to zero on stage and the tabla audibly becomes a tom.
- **Why it wins:** a Delhi room reacts to this in a way it won't react to another particle sim.

### Cymatics plate you play with your voice
Mic → FFT → drive a Chladni plate solved as a 2D wave equation; sand-like particles migrate to the nodal lines. Sing a pitch, watch a symmetric figure crystallize. Audio-reactive, but with an actual PDE under it.

---

## Breakthrough

Pick something that reads as *obviously* beyond a weekend.

### Earth→Mars mission planner
Solve Lambert's problem properly, generate a porkchop plot (departure date × arrival date, colored by Δv), let a judge click the minimum, then fly the patched-conic transfer against a real ephemeris.

- **Demo beat:** "click anywhere on this plot and we fly that mission."
- **Hard part:** the universal-variable Lambert solver has nasty convergence behavior — exactly the thing that used to take three rounds of debugging.

### A spreadsheet engine from scratch
Formula tokenizer → parser → dependency DAG → cycle detection → incremental recalculation over 100k cells, plus a real grid UI.

- **Demo beat:** introduce a circular reference, watch it get caught and localized instead of hanging.
- **Why it wins:** unglamorous on purpose. It's a correctness problem, not a graphics problem, and judges who've written one know it.

### A visible CPU
8-bit ISA, an assembler, and an animated datapath — type assembly, hit run, watch values move along buses through the ALU into registers, with a clock you can slow to 1 Hz.

- **Demo beat:** single-step a multiply loop and narrate the carry flag.

### SQL engine in the browser
Tokenizer → AST → cost-based planner → executor with hash joins and a B-tree index, rendering the query plan as a tree next to the results.

- **Demo beat:** the same query with and without the index, side by side, with row counts and timings.

---

## Everyday

The trap here is building something judges have to take your word for. Beat it by running on *their* data, live.

### Indian bureaucracy decoder
Drop in any government/insurance/telecom PDF — GST notice, policy document, EPFO statement — and get back: what this actually says, what you must do, by when, and what it costs if you don't.

- **Demo beat:** ask someone in the room for a document you've never seen and run it cold.

### Statement → answers
Point it at a folder of bank/credit-card PDFs in whatever inconsistent formats they arrive in; get a normalized table plus a natural-language query box over it. The hard part is real — every bank's PDF layout differs — and the payoff is immediate.

### A retro for your own week
Reads local git history across repos and produces the honest version of the week: not commit titles, but where time went sideways, what you touched and abandoned. Everyone in that room has to write this update on Monday.

---

## If I had to pick one

**Draw-a-shape wind tunnel** for Delight — best impact-to-risk ratio.
**Lambert porkchop planner** if you'd rather compete on difficulty than on beauty.

---

## Timeboxing against the schedule

| Time | Focus |
|---|---|
| 10:45–11:15 | Write a one-page spec first: the algorithm, the file layout, and the demo script you'll perform at 3pm. Work backwards from the 120 seconds. |
| 11:15–13:00 | Core engine only. No styling. Get the solver correct and prove it against a known case — for the wind tunnel, uniform flow past a cylinder should give a visible Kármán street at the right Reynolds number. |
| 13:30–14:30 | Interaction and visuals. |
| 14:30–15:00 | **Freeze.** Rehearse the demo twice out loud, at projector resolution, unplugged from wifi. Most demos die here, not in the code. |

**One more:** keep a `SPEC.md` next to the file and have Claude Code re-read it each round. On a 4-hour single-file build, spec drift is the main failure mode — not model capability.

---

*See also: [build-day-ideas.md](build-day-ideas.md) — a wider, more divergent set from an earlier pass.*
