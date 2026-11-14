import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../webapp/library-cache.js';
import '../webapp/library-sync.js';
const memory = () => { const m = new Map(); return { getItem:k=>m.get(k)??null, setItem:(k,v)=>m.set(k,v), removeItem:k=>m.delete(k) }; };
const book=title=>({id:title,title,notes:[]});
const reply=(data,status=200)=>({ok:status===200,status,json:async()=>data});
test('another account never inherits an unsent labelled cache',()=>{
  const local=memory(),session=memory();
  const a=createKeptLibraryCache({local,session,owner:'A'});
  a.save({books:[book('private draft')],serverRevision:1,syncDirty:true});
  const b=createKeptLibraryCache({local,session,owner:'B'});
  assert.deepEqual(b.initial.books,[]);
  assert.equal(createKeptLibraryCache({local,session,owner:'A'}).initial.books[0].title,'private draft');
});
test('guest draft is claimed by one account, not a second reader or signed-out view',()=>{
  const local=memory(),session=memory();
  createKeptLibraryCache({local,session}).save({books:[book('guest thought')],syncDirty:true});
  const a=createKeptLibraryCache({local,session,owner:'A'});
  assert.equal(a.initial.books.length,1);
  assert.deepEqual(createKeptLibraryCache({local,session,owner:'B'}).initial.books,[]);
  assert.deepEqual(createKeptLibraryCache({local,session}).initial.books,[]);
});
test('unlabelled legacy notes remain downloadable but are not adopted by any account',()=>{
  const local=memory(),session=memory();local.setItem('reading-journal-v1',JSON.stringify({books:[book('legacy')]}));
  const c=createKeptLibraryCache({local,session,owner:'B'});
  assert.deepEqual(c.initial.books,[]);assert.equal(c.recoveries()[0].books[0].title,'legacy');
});
test('switching the session in another tab blocks a same-revision stale upload',async()=>{
  let state={books:[book('A draft')],serverRevision:1,syncDirty:true},writes=0;
  const c=createKeptLibrarySync({owner:'A',read:()=>state,write:s=>state=s,request:async(method)=>{
    if(method==='PUT')writes++;return reply({books:[book('B shelf')],revision:1,exists:true,owner:'B'});
  }});
  assert.equal(await c.load(),false);assert.equal(await c.flush(),false);assert.equal(writes,0);
  assert.equal(state.books[0].title,'A draft');
  assert.equal(await c.useCloud(),false);assert.equal(state.books[0].title,'A draft');
});
test('library saves carry the bound owner as well as the revision',async()=>{
  let state={books:[],serverRevision:0},sent;
  const c=createKeptLibrarySync({owner:'A',read:()=>state,write:s=>state=s,request:async(m,b)=>{
    sent=b;return reply({ok:true,revision:1});}});
  state.books=[book('A')];c.markDirty();await c.flush();assert.equal(sent.owner,'A');
});
test('storage refusal retains the in-memory draft and reports a recovery warning',()=>{
  const state={books:[book('in memory')],serverRevision:0};const statuses=[];
  const c=createKeptLibrarySync({read:()=>state,write:()=>{throw Error('quota')},request:async()=>reply({}),status:s=>statuses.push(s)});
  assert.doesNotThrow(()=>c.markDirty());assert.equal(c.pending(),true);assert.equal(statuses.at(-1),'storage');
});
