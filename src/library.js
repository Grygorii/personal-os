import { col } from './db.js';

// The reader's shelf — the same document the app renders.
//
// This exists because "I'll add that to your library" was a lie the mentor kept telling:
// it wrote to the `reading` collection while the app read `books`, two parallel stores that
// never met. Anything the mentor puts here shows up in their library on the next sync.

const MAX_BOOKS = 500;
const norm = (s) => String(s || '').trim().toLowerCase();
// A book only ever moves forward — hearing "I want to read that" about a book they already
// finished must not quietly un-finish it.
const RANK = { want: 0, reading: 1, finished: 2 };

export async function addBook({ title, author = '', status = 'want' }) {
  const t = String(title || '').trim().slice(0, 300);
  if (!t) return null;
  const wanted = RANK[status] != null ? status : 'want';

  const doc = await col('books').findOne({ _id: 'library' });
  const books = Array.isArray(doc?.books) ? doc.books : [];
  const write = () => col('books').updateOne({ _id: 'library' }, { $set: { books, updatedAt: new Date() } }, { upsert: true });

  const existing = books.find((b) => norm(b.title) === norm(t));
  if (existing) {
    if (RANK[wanted] > (RANK[existing.status] ?? 0)) {
      existing.status = wanted;
      existing.updated = Date.now();
      await write();
      return { added: false, moved: true, book: existing };
    }
    return { added: false, moved: false, book: existing };
  }

  if (books.length >= MAX_BOOKS) return null;
  const book = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: t,
    author: String(author || '').trim().slice(0, 200),
    total: null,
    page: 0,
    status: wanted,
    rating: 0,
    notes: [],
    exam: null,
    started: Date.now(),
    updated: Date.now(),
  };
  books.push(book);
  await write();
  return { added: true, moved: false, book };
}
