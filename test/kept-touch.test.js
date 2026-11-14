import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('the reader thought button respects the declared tap floor and selection clearance',async()=>{
  const html=await readFile(new URL('../reading/journal.html',import.meta.url),'utf8');
  const rule=html.match(/\.rdkeep\{([^}]+)\}/)?.[1];
  assert.ok(rule,'reader thought control exists');
  assert.match(rule,/height:var\(--tap\)/);
  assert.match(rule,/min-height:var\(--tap\)/);
  const tooSmall=[...html.matchAll(/min-height:\s*(\d+)px/g)].map(m=>Number(m[1])).filter(n=>n>0&&n<44);
  assert.deepEqual(tooSmall,[]);
  assert.match(html,/\.rdsel\{[^}]*bottom:calc\(60px \+ env\(safe-area-inset-bottom\)\)/);
});
