// Turning what a camera saw into something a person can read.
//
// A photographed page arrives wrapped to the width of the paper it was printed on, with
// words split across two lines by the typesetter — "de-" on one line, "signed" on the next.
// Neither of those belongs to the writing. They belong to the sheet of paper. Reproduced
// faithfully in a phone-width column, a saved thought reads as gibberish with half its words
// cut in half, which is exactly what a reader reported after keeping a page from Zero to One.
//
// Pure string in, pure string out: no database, no network, no model. Testable in a
// millisecond, which matters, because the failure it prevents is one nobody notices in code
// review — it only shows up on a phone, in someone else's library, days later.

/**
 * Undo a printed page's wrapping. Blank lines survive as paragraph breaks.
 * @param {string} raw
 * @returns {string}
 */
export function reflow(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    // "de-\nsigned" -> "designed". Only before a LOWERCASE letter: a capital after the break
    // is a new sentence or a name, where the hyphen was the writer's own.
    .replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1')
    // A lone newline inside a paragraph is where the paper ran out, so it becomes a space.
    // A line opening with a bullet or "1." is a list the writer meant, and keeps its line.
    .replace(/(\S)\n(?!\n)(?![-*•‣–—]\s)(?!\d+[.)]\s)(?=\S)/g, '$1 ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Does this text look like it was lifted off a printed page, rather than typed by a person?
 *
 * The tell is several lines all running close to the same generous width — that only happens
 * when something else chose where the lines end. Verse, lists and thumb-typed notes are short
 * and uneven, so their line breaks are left exactly as the writer put them.
 * @param {string} s
 * @returns {boolean}
 */
export function looksWrapped(s) {
  if (/\p{L}-\n\p{Ll}/u.test(String(s || ''))) return true;   // a split word is proof on its own
  const lines = String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const long = lines.filter((l) => l.length > 40).length;
  return long >= 3 && long / lines.length > 0.6;
}
