import { col } from './db.js';
import { LibraryConflict, replaceLibrary, revisionOf } from './library-revision.js';

const MAX_BOOKS = 500;
const norm = (s) => String(s || '').trim().toLowerCase();
const RANK = { want: 0, reading: 1, finished: 2 };

// A mentor change is a library write too. Re-read after a race instead of replacing a
// thought saved while the model was answering. Repeating this operation is idempotent.
export async function addBook({ title, author = '', status = 'want' }) {
  const t = String(title || '').trim().slice(0, 300);
  if (!t) return null;
  const wanted = RANK[status] != null ? status : 'want';
  const collection = col('books');
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await collection.findOne({ _id: 'library' });
    const books = Array.isArray(doc?.books) ? doc.books : [];
    const existing = books.find((b) => norm(b.title) === norm(t));
    let result;
    if (existing) {
      if (RANK[wanted] <= (RANK[existing.status] ?? 0)) return { added: false, moved: false, book: existing };
      existing.status = wanted;
      existing.updated = Date.now();
      result = { added: false, moved: true, book: existing };
    } else {
      if (books.length >= MAX_BOOKS) return null;
      const book = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        title: t, author: String(author || '').trim().slice(0, 200), total: null, page: 0,
        status: wanted, rating: 0, notes: [], exam: null, started: Date.now(), updated: Date.now() };
      books.push(book);
      result = { added: true, moved: false, book };
    }
    try {
      await replaceLibrary(collection, books, revisionOf(doc), doc);
      return result;
    } catch (error) {
      if (!(error instanceof LibraryConflict) || attempt === 3) throw error;
    }
  }
}
