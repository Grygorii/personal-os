// The shape of what a reader writes down, and nothing else.
//
// Pure functions, no database and no network, so they can be tested directly — the sanitizer
// in webserver.js is a whitelist, and a whitelist that drops a field silently is indis-
// tinguishable from a feature that doesn't work. That already happened once: the quiz record
// was written by the client for a day and thrown away by the server on every sync.

// Where a link is allowed to point. These end up as href on his own screen, so the scheme is
// checked rather than assumed: `javascript:` in an href is script, and "he pasted it himself"
// is no guarantee when the thing he pasted came out of a stranger's comment.
export function safeUrl(v) {
  const s = String(v || '').trim().slice(0, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Steps ARE the progress. There is no stored percentage, because a percentage set beside a
// checklist is a second copy of the same fact and the two drift — which is how a task once
// read "done" above a bar sitting at 40%.
export function cleanSteps(v) {
  return (Array.isArray(v) ? v : [])
    .slice(0, 20)
    .map((s) => ({ text: String(s?.text || '').trim().slice(0, 200), done: !!s?.done }))
    .filter((s) => s.text);
}

export function cleanTasks(v) {
  return (Array.isArray(v) ? v : [])
    .slice(-200)
    .map((t) => ({
      id: String(t?.id || '').slice(0, 32) || rid(),
      title: String(t?.title || '').trim().slice(0, 200),
      // The line that caused it. A task with no "why" is a to-do; a task that remembers the
      // sentence it came from is the motto working.
      why: String(t?.why || '').trim().slice(0, 1000),
      page: t?.page == null ? null : Number(t.page) || null,
      steps: cleanSteps(t?.steps),
      status: ['open', 'done'].includes(t?.status) ? t.status : 'open',
      due: t?.due == null ? null : Number(t.due) || null,
      partners: (Array.isArray(t?.partners) ? t.partners : [])
        .slice(0, 8)
        .map((p) => ({ name: String(p?.name || '').trim().slice(0, 60), at: Number(p?.at) || Date.now() }))
        .filter((p) => p.name),
      share: t?.share ? String(t.share).slice(0, 32) : null,
      ts: Number(t?.ts) || Date.now(),
      doneAt: t?.doneAt == null ? null : Number(t.doneAt) || null,
    }))
    .filter((t) => t.title);
}

export const THREAD_WHERE = ['reddit', 'x', 'whatsapp', 'telegram', 'facebook', 'linkedin', 'email', 'link'];

// ---- What came back from a word lookup ----
// Pure on purpose, and separate from the call that produced it, because this is the part that
// actually breaks: a model told to reply with bare JSON will still wrap it in a ``` fence,
// prepend "Here you go:", drop a key, or return a number where a string was asked for. The
// reader is mid-sentence in a book — a lookup that throws costs them the page they were on.
//
// Returns null when there is nothing worth showing, so the caller can say "couldn't look that
// one up" rather than opening a card with empty rows in it.
const WORD_MAX = 90;
export function cleanWord(raw, fallbackTerm = '') {
  const text = String(raw == null ? '' : raw);
  // The outermost braces, not the whole reply: a fence, a preamble, or a trailing "Hope that
  // helps!" all leave valid JSON in the middle of invalid text.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // Collapse whitespace: a multi-line "meaning" breaks the card's layout, and a stray newline
  // in a value that gets stored is a line break in a saved thought later.
  const str = (v, n) => (v == null || typeof v === 'object' ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);
  const term = String(fallbackTerm || '').replace(/\s+/g, ' ').trim().slice(0, WORD_MAX);
  const out = {
    word: str(parsed.word, WORD_MAX) || term,
    phonetic: str(parsed.phonetic, 80),
    say: str(parsed.say, 80),
    meaning: str(parsed.meaning, 600),
    example: str(parsed.example, 400),
    translation: str(parsed.translation, 120),
  };
  // The meaning is the only field with no useful fallback. Everything else can be blank and
  // the card still earns its place; without this it is an empty box that reads as a bug.
  return out.meaning ? out : null;
}

export function cleanQuestions(v) {
  return (Array.isArray(v) ? v : [])
    .slice(-200)
    .map((q) => ({
      id: String(q?.id || '').slice(0, 32) || rid(),
      text: String(q?.text || '').trim().slice(0, 1000),
      page: q?.page == null ? null : Number(q.page) || null,
      ts: Number(q?.ts) || Date.now(),
      share: q?.share ? String(q.share).slice(0, 32) : null,
      // Every place he asked it, kept, so the conversation stays reachable from the question
      // instead of being lost in whichever app he happened to post it to.
      threads: (Array.isArray(q?.threads) ? q.threads : [])
        .slice(0, 12)
        .map((th) => ({
          where: THREAD_WHERE.includes(th?.where) ? th.where : 'link',
          url: safeUrl(th?.url),
          note: String(th?.note || '').trim().slice(0, 200),
          at: Number(th?.at) || Date.now(),
        }))
        .filter((th) => th.url),
      // What he landed on after asking. The whole reason to ask is to end up somewhere.
      answer: String(q?.answer || '').trim().slice(0, 2000),
    }))
    .filter((q) => q.text);
}
