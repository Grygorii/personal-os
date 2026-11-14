// Serialized, revision-checked writes. The owner check also protects an already-open tab
// when another tab signs into a different account. All effects are injectable for tests.
globalThis.createKeptLibrarySync = function ({ read, write, request, owner = null, status = () => {}, changed = () => {} }) {
  let inFlight = null, loading = null, blocked = false, generation = 0;
  let revision = Number.isSafeInteger(read().serverRevision) ? read().serverRevision : null;
  let dirty = read().syncDirty === true;
  let storageFailed = false;
  const store = (value) => { try { write(value); storageFailed = false; } catch { storageFailed = true; status('storage'); } };
  const persist = () => store({ ...read(), serverRevision: revision, syncDirty: dirty });
  const tell = (kind) => { status(storageFailed ? 'storage' : kind); return false; };
  const conflict = (kind = 'conflict') => { blocked = true; return tell(kind); };
  const valid = (cloud) => Array.isArray(cloud?.books) && Number.isSafeInteger(cloud.revision) && cloud.revision >= 0;
  const accountMatches = (cloud) => !owner || cloud.owner === owner;
  async function load() {
    if (blocked) return false;
    if (inFlight) { await inFlight; if (dirty || blocked) return false; }
    if (loading) return loading;
    const startGeneration = generation;
    loading = (async () => {
      try {
        const r = await request('GET');
        if (r.status === 401) return tell(owner ? 'signedout' : 'local');
        if (!r.ok) return tell('offline');
        const cloud = await r.json();
        if (!valid(cloud)) return tell('offline');
        if (!accountMatches(cloud)) return conflict('account');
        const local = read();
        if (revision === null && cloud.exists === false && (local.books || []).length) {
          revision = cloud.revision; dirty = true; persist(); return true;
        }
        if (revision === null && JSON.stringify(local.books || []) === JSON.stringify(cloud.books)) {
          revision = cloud.revision; dirty = false; persist(); tell('synced'); return true;
        }
        if (dirty || generation !== startGeneration) {
          if (revision !== cloud.revision) return conflict();
          persist(); return true;
        }
        if (revision === null && (local.books || []).length && cloud.exists !== false) return conflict();
        revision = cloud.revision; dirty = false;
        store({ ...local, books: cloud.books, serverRevision: revision, syncDirty: false });
        changed(); tell('synced'); return true;
      } catch { return tell('offline'); }
      finally { loading = null; }
    })();
    return loading;
  }
  async function flush() {
    if (inFlight) return inFlight;
    if (blocked) return false;
    inFlight = (async () => {
      if (loading) await loading;
      if (blocked || !dirty) return !blocked;
      if (revision === null) return tell('offline');
      while (dirty && !blocked) {
        const sentGeneration = generation;
        const books = JSON.parse(JSON.stringify(read().books || []));
        try {
          const r = await request('PUT', { books, revision, ...(owner ? { owner } : {}) });
          if (r.status === 409 || r.status === 428) {
            const detail = await r.json().catch(() => ({}));
            return conflict(detail.error === 'account_changed' ? 'account' : 'conflict');
          }
          if (r.status === 401) return tell(owner ? 'signedout' : 'local');
          if (!r.ok) return tell('offline');
          const out = await r.json();
          if (!out.ok || !Number.isSafeInteger(out.revision) || out.revision <= revision) return tell('offline');
          revision = out.revision; dirty = generation !== sentGeneration; persist();
        } catch { return tell('offline'); }
      }
      tell('synced'); return true;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  function markDirty() { generation++; dirty = true; persist(); tell(blocked ? 'conflict' : 'pending'); }
  async function useCloud() {
    if (inFlight) await inFlight;
    if (loading) await loading;
    const startGeneration = generation, wasBlocked = blocked;
    blocked = true;
    try {
      const r = await request('GET');
      if (!r.ok) { blocked = wasBlocked; return tell(blocked ? 'conflict' : 'offline'); }
      const cloud = await r.json();
      if (!valid(cloud)) { blocked = wasBlocked; return tell(blocked ? 'conflict' : 'offline'); }
      if (!accountMatches(cloud)) return conflict('account');
      if (generation !== startGeneration) return conflict();
      revision = cloud.revision; dirty = false; blocked = false;
      store({ ...read(), books: cloud.books, serverRevision: revision, syncDirty: false });
      changed(); tell('synced'); return true;
    } catch { blocked = wasBlocked; return tell(blocked ? 'conflict' : 'offline'); }
  }
  return { load, flush, markDirty, useCloud, pending: () => dirty || blocked };
};
