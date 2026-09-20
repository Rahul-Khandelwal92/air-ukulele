// ============================================================================
// tuning/  — ground truth for a standard re-entrant ukulele (gCEA), A4 = 440 Hz
// Pure functions, no DOM, no audio. Safe to load in node for tests.
// String index 0..3 = G C E A  (0 = top string nearest the player's face)
// ============================================================================
const Tuning = (() => {
  const A4 = 440; // ISO 16 concert pitch

  // Semitone offsets from A4 for the open strings: G4 = -2, C4 = -9, E4 = -5, A4 = 0
  const OPEN_SEMITONES = [-2, -9, -5, 0];
  const OPEN_NAMES = ['G4', 'C4', 'E4', 'A4'];
  // Equal temperament: f = 440 · 2^(n/12). Not rounded — this is the spec.
  const OPEN_HZ = OPEN_SEMITONES.map(n => A4 * Math.pow(2, n / 12));

  // Fret tables in G C E A order. 'mute' damps all strings (handled by the engine).
  const CHORDS = {
    C:    [0, 0, 0, 3],
    G:    [0, 2, 3, 2],
    Am:   [2, 0, 0, 0],
    F:    [2, 0, 1, 0],
    open: [0, 0, 0, 0],
    mute: [0, 0, 0, 0],
  };
  const CHORD_ORDER = ['C', 'G', 'Am', 'F'];     // the four demo chords
  const RECOGNISED = ['C', 'G', 'Am', 'F', 'open', 'mute'];

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // Real ukulele fingering for the annotations: s = string index (0 G … 3 A), f = fret, finger 1 index … 4 pinky
  const FINGERING = {
    C:    [{ s: 3, f: 3, finger: 3 }],
    G:    [{ s: 1, f: 2, finger: 1 }, { s: 3, f: 2, finger: 2 }, { s: 2, f: 3, finger: 3 }],
    Am:   [{ s: 0, f: 2, finger: 2 }],
    F:    [{ s: 2, f: 1, finger: 1 }, { s: 0, f: 2, finger: 2 }],
    open: [],
    mute: [],
  };
  // Which fingers the recogniser wants curled (mirrors Chord rules) — for the hand glyph and help text
  const CURL_RULE = {
    C:    { fingers: ['ring'],                     text: 'curl the ring finger' },
    G:    { fingers: ['index', 'middle', 'ring'],  text: 'curl index, middle and ring' },
    Am:   { fingers: ['middle'],                   text: 'curl the middle finger' },
    F:    { fingers: ['index', 'middle'],          text: 'curl index and middle' },
    open: { fingers: [],                           text: 'open hand, all fingers straight' },
    mute: { fingers: ['index', 'middle', 'ring', 'pinky'], text: 'make a fist' },
  };

  function fretHz(stringIdx, fret) {
    return OPEN_HZ[stringIdx] * Math.pow(2, fret / 12);
  }
  function chordHz(name) {
    const frets = CHORDS[name];
    if (!frets) throw new Error('unknown chord ' + name);
    return frets.map((f, i) => fretHz(i, f));
  }
  // Nearest equal-tempered note name, e.g. 523.25 → 'C5'
  function noteName(hz) {
    const n = Math.round(12 * Math.log2(hz / A4)) + 57; // 57 = MIDI 69 (A4) − 12
    const octave = Math.floor(n / 12);
    return NOTE_NAMES[n % 12] + octave;
  }
  function chordNotes(name) {
    return chordHz(name).map(noteName);
  }
  function cents(measuredHz, targetHz) {
    return 1200 * Math.log2(measuredHz / targetHz);
  }

  // Ground truth for V1 — copied from CLAUDE.md, compared within 0.01 Hz.
  const GROUND_TRUTH = {
    open: { notes: ['G4', 'C4', 'E4', 'A4'], hz: [391.995, 261.626, 329.628, 440.000] },
    C:    { notes: ['G4', 'C4', 'E4', 'C5'], hz: [391.995, 261.626, 329.628, 523.251] },
    G:    { notes: ['G4', 'D4', 'G4', 'B4'], hz: [391.995, 293.665, 391.995, 493.883] },
    Am:   { notes: ['A4', 'C4', 'E4', 'A4'], hz: [440.000, 261.626, 329.628, 440.000] },
    F:    { notes: ['A4', 'C4', 'F4', 'A4'], hz: [440.000, 261.626, 349.228, 440.000] },
  };

  // V1: returns { pass, lines[] }
  function selfTest() {
    const lines = [];
    let pass = true;
    for (const name of Object.keys(GROUND_TRUTH)) {
      const gt = GROUND_TRUTH[name];
      const hz = chordHz(name);
      const notes = chordNotes(name);
      for (let i = 0; i < 4; i++) {
        const okHz = Math.abs(hz[i] - gt.hz[i]) <= 0.01;
        const okNote = notes[i] === gt.notes[i];
        if (!okHz || !okNote) pass = false;
        lines.push(`${(okHz && okNote) ? 'PASS' : 'FAIL'} ${name.padEnd(4)} string ${i} ` +
          `${notes[i].padEnd(3)} ${hz[i].toFixed(3)} Hz  (expected ${gt.notes[i]} ${gt.hz[i].toFixed(3)})`);
      }
    }
    lines.unshift(pass ? 'V1 TUNING TABLE OK' : 'V1 TUNING TABLE FAILED');
    return { pass, lines };
  }

  return { A4, OPEN_HZ, OPEN_NAMES, CHORDS, CHORD_ORDER, RECOGNISED, FINGERING, CURL_RULE,
           fretHz, chordHz, chordNotes, noteName, cents, GROUND_TRUTH, selfTest };
})();

// node self-test:  node -e "eval(require('fs').readFileSync('src/tuning.js','utf8')); console.log(Tuning.selfTest().lines.join('\n'))"
if (typeof module !== 'undefined') module.exports = { Tuning };
