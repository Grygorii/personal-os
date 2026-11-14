// Compare-and-swap for the user-scoped library. No network or global state here.
export class LibraryConflict extends Error {
  constructor(code = 'library_conflict', statusCode = 409) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}
export const revisionOf = (doc) => Number.isSafeInteger(doc?.revision) && doc.revision >= 0 ? doc.revision : 0;
export function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LibraryConflict('library_reload_required', 428);
  }
  return value;
}
export async function replaceLibrary(collection, books, expected, before) {
  requireRevision(expected);
  if (revisionOf(before) !== expected) throw new LibraryConflict();
  const version = expected === 0
    ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
    : { revision: expected };
  try {
    const result = await collection.updateOne(
      { _id: 'library', ...version },
      { $set: { books, updatedAt: new Date() }, $inc: { revision: 1 } },
      { upsert: !before && expected === 0 }
    );
    if (!result.matchedCount && !result.upsertedCount) throw new LibraryConflict();
    return expected + 1;
  } catch (error) {
    // Two simultaneous first saves can both see no document. Only one may create it.
    if (error?.code === 11000) throw new LibraryConflict();
    throw error;
  }
}
