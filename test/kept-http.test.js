import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { startServer } from '../src/webserver.js';

test('the actual HTTP router recognizes word lookup without calling a model or database', async (t) => {
  const server = startServer(0, 'test');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const result = await fetch(base + '/api/word');
  assert.equal(result.status, 401, 'recognized API route requires auth for GET, not a 404');
  assert.deepEqual(await result.json(), { error: 'unauthorized' });
  const helper = await fetch(base + '/library-sync.js');
  assert.equal(helper.status, 200);
  assert.equal(helper.headers.get('cache-control'), 'no-store');
  assert.match(await helper.text(), /createKeptLibrarySync/);
});
test('every inline app script parses, including the new sync and mentor wiring', async () => {
  const html = await readFile(new URL('../reading/journal.html', import.meta.url), 'utf8');
  // Documentation contains literal <script> tags. They are not executable markup.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  let count = 0;
  for (const match of markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) { new Script(match[1], { filename: `journal-inline-${count + 1}.js` }); count++; }
  }
  assert.ok(count >= 2);
  assert.match(html, /src="\/library-sync\.js"/);
  assert.match(html, /if\(!await flushSaves\(\)\)/);
});
