// One-off, branch-only integration of the reviewed changes. Removed after tests pass.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const originals = {
 'src/webserver.js':'fb8aa52a443c199be320a78cad642582437040b9',
 'reading/journal.html':'316bdfb810a20c4163d81cc8075dadf1ede96515',
 'src/coach.js':'356b26b68f767c8042f04288a71a7354669c4af5',
 'src/auth.js':'72cc9ca6838cfea85afa87bbec4dfc656d19e537',
 'src/config.js':'6d056e5cd58939ae7d3a064ce656a6b31c4dbda0',
 'src/index.js':'0ef528a652f0052fa7e48f2f5a0805f8fb0534b7'
};
const files = new Map();
for (const [path, expected] of Object.entries(originals)) {
 const bytes=readFileSync(path);
 const hash=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
 if(hash!==expected) throw new Error('Source changed; inspect before applying: '+path);
 files.set(path,bytes.toString('utf8'));
}
function one(path, from, to) {
 const s=files.get(path);
 if(s.split(from).length!==2) throw new Error('Expected one exact anchor in '+path+': '+from.slice(0,80));
 files.set(path,s.replace(from,()=>to));
}
function between(path,start,end,replacement) {
 const s=files.get(path), a=s.indexOf(start), b=s.indexOf(end,a+start.length);
 if(a<0||b<0||s.indexOf(start,a+1)!==-1) throw new Error('Ambiguous section in '+path);
 files.set(path,s.slice(0,a)+replacement+s.slice(b));
}
const ws='src/webserver.js';
one(ws,"export { verifyInitData } from './miniapp.js';", "export { verifyInitData };");
one(ws,"import http from 'http';", "import http from 'http';\nimport { verifyInitData } from './miniapp.js';");
one(ws,"import { addBook } from './library.js';", "import { addBook } from './library.js';\nimport { LibraryConflict, replaceLibrary, requireRevision, revisionOf } from './library-revision.js';");
one(ws,"path === '/api/tidy' || path === '/api/readpage'\n    )", "path === '/api/tidy' || path === '/api/readpage' || path === '/api/word'\n    )");
one(ws,"return { books: doc?.books || [], updatedAt: doc?.updatedAt || null };", "return { books: doc?.books || [], updatedAt: doc?.updatedAt || null, revision: revisionOf(doc), exists: !!doc };");
one(ws,'async function saveBooks(books) {','async function saveBooks(books, expectedRevision) {\n  requireRevision(expectedRevision);');
one(ws,"  await col('books').updateOne({ _id: 'library' }, { $set: { books: clean, updatedAt: new Date() } }, { upsert: true });\n  return { ok: true, count: clean.length };", "  const revision = await replaceLibrary(col('books'), clean, expectedRevision, before);\n  return { ok: true, count: clean.length, revision };");
one(ws,"saveBooks(body?.books) : getBooks()", "saveBooks(body?.books, body?.revision) : getBooks()");
one(ws,"console.error('[web] api error:', path, err.message);\n        res.writeHead(500, { 'Content-Type': 'application/json' });\n        res.end(JSON.stringify({ error: 'server' }));", "console.error('[web] api error:', path, err.message);\n        const status = err instanceof LibraryConflict ? err.statusCode : 500;\n        res.writeHead(status, { 'Content-Type': 'application/json' });\n        res.end(JSON.stringify({ error: err instanceof LibraryConflict ? err.code : 'server' }));");
one(ws,'const ASSETS = {',"const ASSETS = {\n  '/library-sync.js': { file: 'library-sync.js', type: 'application/javascript', cache: 'no-store' },");
one(ws,"'Content-Type': ASSETS[path].type, 'Cache-Control': 'public, max-age=86400'", "'Content-Type': ASSETS[path].type, 'Cache-Control': ASSETS[path].cache || 'public, max-age=86400'");
const coach='src/coach.js';
one(coach,"import { addBook } from './library.js';", "import { addBook } from './library.js';\nimport { readingEvidence, withReadingEvidence, READING_CONTEXT_RULES } from './reading-context.js';");
one(coach,'const [profile, logs, reading, history, energy, state, pursuitRows] = await Promise.all([','const [profile, logs, reading, history, energy, state, pursuitRows, shelf] = await Promise.all([');
one(coach,"    col('pursuits').find().sort({ lastActive: -1 }).limit(10).toArray(),\n  ]);", "    col('pursuits').find().sort({ lastActive: -1 }).limit(10).toArray(),\n    users.can(currentUser(), 'books') ? col('books').findOne({ _id: 'library' }) : null,\n  ]);");
one(coach,'CONTEXT: it is ${now} (${partOfDay}). Currently reading: ${readingLine}', 'CONTEXT: it is ${now} (${partOfDay}). Current books and progress are in KEPT_LIBRARY_EVIDENCE when supplied.');
one(coach,'  const messages = history.map((m) => ({', "  const evidence = users.can(currentUser(), 'books') ? readingEvidence(shelf, finalUserContent) : '';\n  const messages = history.map((m) => ({");
one(coach,"text: finalUserContent || 'I sent you a photo — take a look and respond.'", "text: withReadingEvidence(finalUserContent || 'I sent you a photo — take a look and respond.', evidence)");
one(coach,'      : finalUserContent,','      : withReadingEvidence(finalUserContent, evidence),');
one(coach,'system: systemPrompt, messages, maxTokens: 3000', "system: systemPrompt + (users.can(currentUser(), 'books') ? READING_CONTEXT_RULES : ''), messages, maxTokens: 3000");
one('src/auth.js',"import { config } from './config.js';", "import { config } from './config.js';\nimport { sessionBase } from './session-secret.js';");
one('src/auth.js',"const base = config.encryptionKey || config.telegramToken || 'insecure-dev-key';",'const base = sessionBase(config);');
one('src/auth.js','export function createSession(userId) {','export function assertSessionSecret() { sessionKey(); }\n\nexport function createSession(userId) {');
one('src/config.js',"  encryptionKey: oneLine(process.env.ENCRYPTION_KEY),", "  encryptionKey: oneLine(process.env.ENCRYPTION_KEY),\n  sessionSecret: oneLine(process.env.SESSION_SECRET),");
one('src/index.js',"import { initPush } from './push.js';", "import { initPush } from './push.js';\nimport { assertSessionSecret } from './auth.js';");
one('src/index.js',"const VERSION = 'reader-2';", "const VERSION = 'reading-reliability-20261114';");
one('src/index.js','async function main() {','async function main() {\n  assertSessionSecret();');
const app='reading/journal.html';
one(app,'<script>\nconst KEY="reading-journal-v1";', '<script src="/library-sync.js"></script>\n<script>\nconst KEY="reading-journal-v1";');
one(app,'let state=JSON.parse(localStorage.getItem(KEY)||"{}"); state.books=state.books||[];',String.raw`let state;
try { state=JSON.parse(sessionStorage.getItem(KEY+":pending")||localStorage.getItem(KEY)||"{}"); }
catch { state={}; }
state.books=Array.isArray(state.books)?state.books:[];`);
one(app,'  <section id="view-library">',String.raw`  <style>#sync-status[hidden]{display:none}</style>
  <aside id="sync-status" class="sec" role="status" hidden>
    <p id="sync-message"></p>
    <button class="btn ghost" id="sync-retry" type="button">Retry sync</button>
    <button class="btn ghost" id="sync-download" type="button">Download this device's copy</button>
    <button class="btn ghost" id="sync-cloud" type="button" hidden>Use latest saved library</button>
  </aside>
  <section id="view-library">`);
between(app,'let syncTimer=null,syncing=false;','const $=id=>document.getElementById(id);',String.raw`let syncTimer=null,syncing=false;
function syncStatus(kind){
  const box=document.getElementById("sync-status");
  box.hidden=["synced","local","pending"].includes(kind);
  document.getElementById("sync-message").textContent=kind==="conflict"
    ? "Your library changed elsewhere. This device's unsent copy is safe here; automatic syncing is paused. Download it before choosing the latest saved library."
    : "Not synced yet. Your changes are kept on this device. Retry when connected, or download a copy.";
  document.getElementById("sync-cloud").hidden=kind!=="conflict";
  document.getElementById("sync-retry").hidden=kind==="conflict";
}
function cacheShelf(next){
  state=next;
  // A tab's pending version survives reload even if another tab updates the shared cache.
  if(state.syncDirty) sessionStorage.setItem(KEY+":pending",JSON.stringify(state));
  else sessionStorage.removeItem(KEY+":pending");
  localStorage.setItem(KEY,JSON.stringify(state));
}
const shelfSync=createKeptLibrarySync({
  read:()=>state, write:cacheShelf,
  request:(method,body)=>api("/api/books",{method,headers:{"Content-Type":"application/json"},
    ...(body?{body:JSON.stringify(body)}:{})}),
  status:syncStatus, changed:()=>renderLibrary()
});
async function pushBooks(){
  if(window.__me?.guest&&!initData()) return true;
  syncing=true;
  try{
    if(!Number.isSafeInteger(state.serverRevision)) await shelfSync.load();
    return await shelfSync.flush();
  }finally{syncing=false;}
}
const save=()=>{
  shelfSync.markDirty();
  clearTimeout(syncTimer); syncTimer=setTimeout(()=>{syncTimer=null;pushBooks();},600);
};
function flushSaves(){
  clearTimeout(syncTimer); syncTimer=null;
  return pushBooks();
}
addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden") flushSaves();});
addEventListener("online",()=>loadBooks());
async function loadBooks(){
  await shelfSync.load();
  if(shelfSync.pending()) await shelfSync.flush();
}
function downloadLocalShelf(){
  const data=JSON.stringify({exportedAt:new Date().toISOString(),books:state.books},null,2);
  const url=URL.createObjectURL(new Blob([data],{type:"application/json"}));
  const a=document.createElement("a");a.href=url;a.download="kept-device-copy-"+Date.now()+".json";
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
document.getElementById("sync-download").onclick=downloadLocalShelf;
document.getElementById("sync-retry").onclick=()=>loadBooks();
document.getElementById("sync-cloud").onclick=async()=>{
  if(!confirm("Keep a recovery copy and download this device's unsent notes, then use the latest saved library? The unsent version will NOT be uploaded.")) return;
  try{
    localStorage.setItem(KEY+":recovery:"+Date.now(),JSON.stringify(state));
    downloadLocalShelf();
    await shelfSync.useCloud();
  }catch(e){syncStatus("offline");}
};
`);
one(app,'const dirty=()=>document.querySelector(".exam-ans, .ed-t")','const dirty=()=>shelfSync.pending() || document.querySelector(".exam-ans, .ed-t")');
between(app,'  async function submit(){','  send.onclick=submit;',String.raw`  async function submit(){
    const text=input.value.trim();
    if(!text||busy) return;
    busy=true; send.disabled=true;
    let t=null;
    try{
      // The mentor must read the thought just saved, not yesterday's cloud version.
      if(!await flushSaves()){
        toast("Sync needs attention in Library. Your message is still here.");
        return;
      }
      if(log.querySelector(".chat-empty")) log.innerHTML="";
      bubble("user",text);input.value="";input.style.height="auto";t=typing();
      const r=await api("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});
      t.remove();t=null;
      if(r.status===401){bubble("coach","Please sign in again.");location.href="/app";return;}
      if(!r.ok) throw new Error("mentor unavailable");
      const d=await r.json();bubble("coach",d.reply||"…");
      await loadBooks();
    }catch(e){if(t)t.remove();bubble("coach","Couldn't reach the mentor — try again.");}
    finally{busy=false;send.disabled=false;input.focus();}
  }
`);
for(const [path,contents] of files) writeFileSync(path,contents);
console.log('Applied exact, SHA-checked integration edits to '+files.size+' files.');
