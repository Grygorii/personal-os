// Browser + node:test compatible. All effects are injected so real race conditions are testable.
globalThis.createKeptLibrarySync = function ({ read, write, request, status = () => {}, changed = () => {} }) {
  let inFlight = null, loading = null, blocked = false, generation = 0;
  let revision = Number.isSafeInteger(read().serverRevision) ? read().serverRevision : null;
  let dirty = read().syncDirty === true;
  const persist = () => write({ ...read(), serverRevision: revision, syncDirty: dirty });
  const cloneBooks = () => JSON.parse(JSON.stringify(read().books || []));
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  const tell = (kind) => { status(kind); return false; };
  const conflict = () => { blocked = true; return tell('conflict'); };
  async function load() {
    if (blocked) return false;
    if (inFlight) { await inFlight; if (dirty || blocked) return false; }
    if (loading) return loading;
    const startGeneration = generation;
    loading = (async () => {
      try {
        const response = await request('GET');
        if (response.status === 401) return tell('local');
        if (!response.ok) return tell('offline');
        const cloud = await response.json();
        if (!Array.isArray(cloud.books) || !Number.isSafeInteger(cloud.revision)) return tell('offline');
        const local = read();
        // First sign-in may lift a guest draft into a genuinely new library, never into
        // an existing (possibly deliberately emptied) library.
        if (revision === null && cloud.exists === false && (local.books || []).length) {
          revision = cloud.revision; dirty = true; persist(); return true;
        }
        if (revision === null && same(local.books, cloud.books)) {
          revision = cloud.revision; dirty = false; persist(); status('synced'); return true;
        }
        // Never copy a stale/unsent shelf over a nonempty cloud shelf or discard local edits.
        if (dirty || generation !== startGeneration) {
          if (revision !== cloud.revision) return conflict();
          persist();
          return true;
        }
        if (revision === null && (local.books || []).length && !same(local.books, cloud.books)) {
          // An existing empty library can be an intentional deletion on another device.
          if (cloud.exists !== false) return conflict();
          revision = cloud.revision;
          dirty = true;
          persist();
          return true;
        }
        revision = cloud.revision;
        dirty = false;
        write({ ...local, books: cloud.books, serverRevision: revision, syncDirty: false });
        changed(); status('synced'); return true;
      } catch { return tell('offline'); }
      finally { loading = null; }
    })();
    return loading;
  }
  async function flush() {
    if (inFlight) return inFlight;
    if (blocked) return false;
    inFlight = (async () => {
      // Do not call load() here: it awaits an in-flight save. Initial load must precede flush.
      if (loading) await loading;
      if (blocked || !dirty) return !blocked;
      if (revision === null) return tell('offline');
      while (dirty && !blocked) {
        const sentGeneration = generation;
        const books = cloneBooks();
        try {
          const response = await request('PUT', { books, revision });
          if (response.status === 409 || response.status === 428) return conflict();
          if (response.status === 401) return tell('local');
          if (!response.ok) return tell('offline');
          const result = await response.json();
          if (!result.ok || !Number.isSafeInteger(result.revision) || result.revision <= revision) return tell('offline');
          revision = result.revision;
          dirty = generation !== sentGeneration;
          persist();
        } catch { return tell('offline'); }
      }
      status('synced'); return true;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  function markDirty() { generation++; dirty = true; persist(); status(blocked ? 'conflict' : 'pending'); }
  async function useCloud() {
    // Caller must preserve/download the local copy and ask for explicit consent first.
    if (inFlight) await inFlight;
    const before = { state: JSON.parse(JSON.stringify(read())), revision, dirty, blocked };
    blocked = false; dirty = false; revision = -1;
    if (await load()) return true;
    revision = before.revision; dirty = before.dirty; blocked = before.blocked;
    write(before.state); status(blocked ? 'conflict' : 'offline'); return false;
  }
  return { load, flush, markDirty, useCloud, pending: () => dirty || blocked };
};
