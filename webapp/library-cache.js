// Storage belongs to an account, not to whoever next opens the browser.
// Legacy unlabelled copies are never adopted automatically; they remain recoverable.
globalThis.createKeptLibraryCache = function ({ local, session, owner = null }) {
  const legacy = 'reading-journal-v1', guestKey = 'reading-journal-v2:guest';
  const key = owner ? 'reading-journal-v2:user:' + encodeURIComponent(owner) : guestKey;
  const get = (store, k) => { try { const v = JSON.parse(store.getItem(k) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  const put = (store, k, v) => { store.setItem(k, JSON.stringify(v)); };
  let initial = get(session, key + ':pending') || get(local, key);
  if (owner && !initial) {
    const guest = get(local, guestKey);
    if (guest && !guest.claimedBy && Array.isArray(guest.books) && guest.books.length) {
      // Claim before copying. Retain the source as a recovery copy, but never offer it
      // to a second account. A storage failure aborts adoption rather than risking a leak.
      try {
        put(local, guestKey, { ...guest, claimedBy: owner });
        initial = { books: guest.books, syncDirty: true, serverRevision: null, owner };
        put(local, key, initial);
      } catch { initial = null; }
    }
  }
  if (!initial || (!owner && (initial.claimedBy || get(local, guestKey)?.claimedBy)) || (owner && initial.owner !== owner)) initial = { books: [], owner };
  initial.books = Array.isArray(initial.books) ? initial.books : [];
  return {
    key, initial,
    save(state) {
      const labelled = { ...state, owner };
      if (labelled.syncDirty) put(session, key + ':pending', labelled);
      else session.removeItem(key + ':pending');
      put(local, key, labelled);
    },
    recoveries() {
      return [get(session, legacy + ':pending'), get(local, legacy)]
        .filter((v) => v && Array.isArray(v.books) && v.books.length);
    },
    backup(state) { put(local, key + ':recovery:' + Date.now(), { ...state, owner }); }
  };
};
