import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../webapp/library-sync.js';

const book = (title) => ({ id: title, title, notes: [] });
const response = (status, data = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(data) });
function fixture(code) {
  let resolve;
  const gate = new Promise((r) => { resolve = r; });
  let state = { books: [book('draft')], serverRevision: 1, syncDirty: true };
  const statuses = [];
  const sync = globalThis.createKeptLibrarySync({
    read: () => state,
    write: (value) => { state = value; },
    status: (value) => statuses.push(value),
    request: async () => { await gate; return response(code, { books: [book('remote')], revision: 3, exists: true }); },
  });
  return { sync, resolve, statuses, read: () => state,
    edit: () => { state.books = [book('new edit made after the download')]; sync.markDirty(); } };
}
test('editing during cloud recovery keeps the new edit instead of replacing it with a downloaded version', async () => {
  const c = fixture(200);
  const recovery = c.sync.useCloud();
  c.edit(); c.resolve();
  assert.equal(await recovery, false);
  assert.equal(c.read().books[0].title, 'new edit made after the download');
  assert.equal(c.read().syncDirty, true);
  assert.equal(c.statuses.at(-1), 'conflict');
});
test('failed cloud recovery never rolls back an edit made while the request was travelling', async () => {
  const c = fixture(500);
  const recovery = c.sync.useCloud();
  c.edit(); c.resolve();
  assert.equal(await recovery, false);
  assert.equal(c.read().books[0].title, 'new edit made after the download');
  assert.equal(c.read().syncDirty, true);
});
