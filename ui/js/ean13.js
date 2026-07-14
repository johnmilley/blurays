// Pure-JS EAN-13 / UPC-A decoder for browsers without the BarcodeDetector
// API (iOS Safari — the phone half of this app's whole reason to exist).
//
// Approach: sample horizontal scanlines from a grayscale frame, adaptive-
// threshold each into bar/space runs, locate the start/middle/end guard
// patterns, and classify every digit's 4 runs against the EAN code tables
// by run-length signature. Checksum-validated; the caller additionally
// requires two consecutive identical reads before trusting a result.

const L_PATTERNS = [
  "0001101", "0011001", "0010011", "0111101", "0100011",
  "0110001", "0101111", "0111011", "0110111", "0001011",
];

function runsOf(bits) {
  const runs = [];
  let n = 1;
  for (let i = 1; i < bits.length; i++) {
    if (bits[i] === bits[i - 1]) n++;
    else {
      runs.push(n);
      n = 1;
    }
  }
  runs.push(n);
  return runs;
}

// Left-odd (L) digits start with a space; their run signature is 4 lengths
// summing to 7 modules. G = reverse(complement(L)) reversed — which works
// out to L's signature reversed. R (right side) shares L's signature with
// colors swapped, which run lengths don't care about.
const L_SIG = L_PATTERNS.map(runsOf);
const G_SIG = L_SIG.map((s) => [...s].reverse());

// First digit is encoded in the parity pattern of the six left digits
// (O = odd/L, E = even/G).
const PARITY = [
  "OOOOOO", "OOEOEE", "OOEEOE", "OOEEEO", "OEOOEE",
  "OEEOOE", "OEEEOO", "OEOEOE", "OEOEEO", "OEEOEO",
];

/** Best-matching digit for 4 runs against a signature table.
 * Returns { digit, err } where err is total module deviation. */
function matchDigit(runs, table) {
  const total = runs[0] + runs[1] + runs[2] + runs[3];
  let best = -1;
  let bestErr = Infinity;
  for (let d = 0; d < 10; d++) {
    const sig = table[d];
    let err = 0;
    for (let k = 0; k < 4; k++) err += Math.abs((runs[k] * 7) / total - sig[k]);
    if (err < bestErr) {
      bestErr = err;
      best = d;
    }
  }
  return { digit: best, err: bestErr };
}

const DIGIT_ERR_LIMIT = 1.6; // total module deviation across 4 runs
const GUARD_TOL = 0.55; // guard runs must be within this of 1 module

function checksumOk(digits) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += digits[i] * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === digits[12];
}

/** Decode one thresholded scanline (array of run lengths; runs[startIsBar]
 * tells the color phase). Returns a 13-digit string or null. */
function decodeRuns(runs, firstIsBar) {
  // A full EAN-13 is 59 runs: guard(3) + 6*4 + guard(5) + 6*4 + guard(3).
  for (let i = firstIsBar ? 0 : 1; i + 59 <= runs.length; i += 2) {
    // candidate start guard: bar space bar, ~1 module each
    const m = (runs[i] + runs[i + 1] + runs[i + 2]) / 3;
    if (m <= 0) continue;
    if (
      Math.abs(runs[i] / m - 1) > GUARD_TOL ||
      Math.abs(runs[i + 1] / m - 1) > GUARD_TOL ||
      Math.abs(runs[i + 2] / m - 1) > GUARD_TOL
    )
      continue;
    // quiet zone before (or line start)
    if (i > 0 && runs[i - 1] < 3 * m) continue;

    const digits = [];
    let parity = "";
    let ok = true;
    let pos = i + 3;

    for (let d = 0; d < 6 && ok; d++, pos += 4) {
      const quad = runs.slice(pos, pos + 4);
      const asL = matchDigit(quad, L_SIG);
      const asG = matchDigit(quad, G_SIG);
      const pick = asL.err <= asG.err ? asL : asG;
      if (pick.err > DIGIT_ERR_LIMIT) ok = false;
      digits.push(pick.digit);
      parity += asL.err <= asG.err ? "O" : "E";
    }
    if (!ok) continue;

    // middle guard: 5 alternating single-module runs
    let guardOk = true;
    for (let k = 0; k < 5; k++) {
      if (Math.abs(runs[pos + k] / m - 1) > GUARD_TOL + 0.25) guardOk = false;
    }
    if (!guardOk) continue;
    pos += 5;

    for (let d = 0; d < 6 && ok; d++, pos += 4) {
      const pick = matchDigit(runs.slice(pos, pos + 4), L_SIG);
      if (pick.err > DIGIT_ERR_LIMIT) ok = false;
      digits.push(pick.digit);
    }
    if (!ok) continue;

    // end guard
    if (
      Math.abs(runs[pos] / m - 1) > GUARD_TOL ||
      Math.abs(runs[pos + 1] / m - 1) > GUARD_TOL ||
      Math.abs(runs[pos + 2] / m - 1) > GUARD_TOL
    )
      continue;

    const first = PARITY.indexOf(parity);
    if (first < 0) continue;

    const all = [first, ...digits];
    if (!checksumOk(all)) continue;
    return all.join("");
  }
  return null;
}

function lineToRuns(gray, offset, width) {
  let min = 255;
  let max = 0;
  for (let x = 0; x < width; x++) {
    const v = gray[offset + x];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 40) return null; // no contrast, no barcode
  const thr = (min + max) / 2;

  const runs = [];
  let firstIsBar = gray[offset] < thr;
  let cur = firstIsBar;
  let n = 1;
  for (let x = 1; x < width; x++) {
    const bar = gray[offset + x] < thr;
    if (bar === cur) n++;
    else {
      runs.push(n);
      cur = bar;
      n = 1;
    }
  }
  runs.push(n);
  return { runs, firstIsBar };
}

/** Try to decode an EAN-13/UPC-A from a grayscale frame. Samples several
 * scanlines across the middle band, in both directions. Returns the digit
 * string or null. */
export function decodeFrame(gray, width, height) {
  const ROWS = 15;
  for (let r = 0; r < ROWS; r++) {
    const y = Math.floor(height * (0.25 + (0.5 * r) / (ROWS - 1)));
    const line = lineToRuns(gray, y * width, width);
    if (!line) continue;
    let hit = decodeRuns(line.runs, line.firstIsBar);
    if (hit) return hit;
    // upside-down barcodes: same runs, reversed
    const rev = [...line.runs].reverse();
    const revFirstIsBar = line.runs.length % 2 ? line.firstIsBar : !line.firstIsBar;
    hit = decodeRuns(rev, revFirstIsBar);
    if (hit) return hit;
  }
  return null;
}
