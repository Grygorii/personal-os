// How a grade is built, and how it is read back out of the model.
//
// ---- why this file exists at all ----
// The grading endpoint used to demand one JSON object and threw the whole run away if it did
// not parse. It did not parse: the model wrote `"score">52`, one character where a colon
// belonged, and five carefully written answers were discarded on the strength of it.
// Reproduced twice against the live model, two different slips, the same class both times.
//
// The lesson is not "retry harder". A grade is PROSE WITH NUMBERS IN IT, and prose does not
// survive being carried inside JSON: one stray quote or colon anywhere in six sentences
// destroys all six. So the model is asked for one fact per line, and each line is read on its
// own — a mangled line costs that line and nothing else.
//
// ---- the structure of a grade ----
// A bare 52% tells a reader nothing they can act on, and it hides the one thing this product
// claims to measure. The exam already has a shape — generateExam asks for Q1-Q2 on the book's
// ideas, Q3-Q4 on applying them to the reader's own life, Q5 on pushing back — so the grade is
// built along the same three lines:
//
//   UNDERSTOOD   (Q1-Q2)  can you explain it to a colleague? Table stakes.
//   USED         (Q3-Q4)  did you do anything with it? This IS the product's claim.
//   CHALLENGED   (Q5)     can you say where the author is wrong? Reader, not repeater.
//
// "You understood it (78) and you have not used it (41)" is a sentence worth reading. It is
// also the motto stated as a measurement, which is why USED carries the most weight in the
// overall — finishing a book is not the achievement being scored.
//
// Every answer gets both halves: what LANDED and what was MISSING. A mark with no "missing" is
// a verdict; a mark with one is a next step.
//
// Pure — no network, no database — so the malformations that broke it live in the test suite.

export const clampScore = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

// What a number means, so a reader does not have to be handed the rubric to interpret it.
// The thresholds are the ones the grading prompt is held to, in one place, so the words on
// screen and the instruction to the model cannot drift apart.
const BANDS = [
  { min: 80, label: 'used it in your own life', tone: 'good' },
  { min: 60, label: "you own the book's idea", tone: 'good' },
  { min: 40, label: 'the right idea, not yet owned', tone: 'mid' },
  { min: 0, label: 'generic, restated or bluffed', tone: 'bad' },
];

export function bandFor(score) {
  if (score == null || Number.isNaN(Number(score))) return null; // absent is not the bottom band
  return BANDS.find((b) => score >= b.min) || BANDS[BANDS.length - 1];
}

// The rubric, rendered for the prompt from the same constant the UI reads.
export const RUBRIC = BANDS.slice().reverse()
  .map((b, i, a) => {
    const hi = i + 1 < a.length ? a[i + 1].min - 1 : 100;
    return `${b.min}-${hi}: ${b.label}`;
  })
  .join(' · ');

// Which questions feed which dimension. Derived from position rather than declared per exam,
// because generateExam builds the paper in this order and has since it was written.
export function dimensionsOf(scores) {
  const at = (i) => (scores[i] == null ? null : scores[i]);
  const avg = (idx) => {
    const xs = idx.map(at).filter((x) => x != null);
    return xs.length ? clampScore(xs.reduce((n, x) => n + x, 0) / xs.length) : null;
  };
  return { understood: avg([0, 1]), used: avg([2, 3]), challenged: avg([4]) };
}

// Weighted toward using it. The product's whole claim is that reading is for using, so an exam
// that scored comprehension and application equally would be marking the wrong thing.
const WEIGHT = { understood: 0.3, used: 0.5, challenged: 0.2 };

export function overallFrom({ understood, used, challenged }, scores) {
  const parts = Object.entries({ understood, used, challenged }).filter(([, v]) => v != null);
  if (parts.length) {
    const w = parts.reduce((n, [k]) => n + WEIGHT[k], 0);
    return clampScore(parts.reduce((n, [k, v]) => n + v * WEIGHT[k], 0) / w);
  }
  const xs = (scores || []).filter((x) => x != null);
  return xs.length ? clampScore(xs.reduce((n, x) => n + x, 0) / xs.length) : 0;
}

// Kept tolerant on purpose: `:` is the character the model gets wrong, so `>` and `=` and `-`
// are accepted in its place rather than treated as a failure.
const SEP = '\\s*[:>=\\-]+\\s*';
const tidy = (s) => String(s).trim().replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 600);
const line = (text, label) => {
  const m = new RegExp(`^\\s*${label}${SEP}(.+)$`, 'im').exec(text);
  return m ? tidy(m[1]) : '';
};
const num = (text, label) => {
  const m = new RegExp(`^\\s*${label}${SEP}(\\d{1,3})`, 'im').exec(text);
  return m ? clampScore(m[1]) : null;
};

// JSON is still accepted when it happens to arrive — a model told to write lines will sometimes
// write JSON anyway, and a reply that parses is a reply we should use.
function fromJson(text) {
  const clean = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
  let j = null;
  try { j = JSON.parse(clean); } catch { /* try an embedded object */ }
  if (!j) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) try { j = JSON.parse(m[0]); } catch { /* no */ }
  }
  return j && Array.isArray(j.grades) && j.grades.length ? j : null;
}

export function parseGrades(raw, n) {
  const text = String(raw || '');
  const out = { grades: [], understood: null, used: null, challenged: null, overall: null, verdict: '' };

  const j = fromJson(text);
  if (j) {
    out.grades = j.grades.slice(0, n).map((g) => ({
      score: g?.score == null ? null : clampScore(g.score),
      landed: tidy(g?.landed || g?.feedback || ''),
      missing: tidy(g?.missing || ''),
    }));
    out.verdict = tidy(j.verdict || '');
    for (const k of ['understood', 'used', 'challenged']) if (j[k] != null) out[k] = clampScore(j[k]);
    if (j.overall != null) out.overall = clampScore(j.overall);
  } else {
    for (let i = 1; i <= n; i++) {
      const score = num(text, `Q?${i}\\s*SCORE`);
      const landed = line(text, `Q?${i}\\s*LANDED`) || line(text, `Q?${i}\\s*NOTE`);
      const missing = line(text, `Q?${i}\\s*MISSING`);
      if (score == null && !landed && !missing) continue;
      out.grades[i - 1] = { score, landed, missing };
    }
    out.understood = num(text, 'UNDERSTOOD');
    out.used = num(text, 'USED');
    out.challenged = num(text, 'CHALLENGED');
    out.overall = num(text, 'OVERALL');
    out.verdict = line(text, 'VERDICT');
  }

  // A gap in the middle must not shift Q4's mark onto Q3. A grade in the wrong slot is worse
  // than a missing one, because it looks correct.
  for (let i = 0; i < n; i++) if (!out.grades[i]) out.grades[i] = { score: null, landed: '', missing: '' };

  // A missing line must never mean a missing dimension — the questions already carry the shape,
  // so the numbers can always be derived from the per-question marks.
  const scores = out.grades.map((g) => g.score);
  const derived = dimensionsOf(scores);
  for (const k of ['understood', 'used', 'challenged']) if (out[k] == null) out[k] = derived[k];
  if (out.overall == null) out.overall = overallFrom(out, scores);

  return out;
}

// Did we get anything worth showing? An absent score is not a zero — a 0% is a judgement and
// silence is not, so "nothing readable" has to be distinguishable from "you scored nothing".
export const gradedAny = (g) =>
  g.grades.some((x) => x.score != null || x.landed || x.missing);
