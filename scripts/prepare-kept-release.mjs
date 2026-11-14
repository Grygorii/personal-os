import { readFileSync, writeFileSync } from 'node:fs';
const files = new Map();
function edit(path, from, to) {
  const s = files.get(path) ?? readFileSync(path, 'utf8');
  if (s.split(from).length !== 2) throw new Error('Source drift: ' + path + ' / ' + from.slice(0, 80));
  files.set(path, s.replace(from, () => to));
}
const ws = 'src/webserver.js', app = 'reading/journal.html';
edit(ws, "return { books: doc?.books || [], updatedAt: doc?.updatedAt || null, revision: revisionOf(doc), exists: !!doc };",
  "return { books: doc?.books || [], updatedAt: doc?.updatedAt || null, revision: revisionOf(doc), exists: !!doc, owner: uid() };");
edit(ws, 'async function saveBooks(books, expectedRevision) {\n  requireRevision(expectedRevision);', "async function saveBooks(books, expectedRevision, owner) {\n  requireRevision(expectedRevision);\n  if (owner !== uid()) throw new LibraryConflict('account_changed');");
edit(ws, 'saveBooks(body?.books, body?.revision)', 'saveBooks(body?.books, body?.revision, body?.owner)');
edit(ws, 'guest: !signedIn,', 'guest: !signedIn,\n              id: signedIn ? String(acct._id) : null,');
edit(ws, 'const ASSETS = {', "const ASSETS = {\n  '/library-cache.js': { file: 'library-cache.js', type: 'application/javascript', cache: 'no-store' },");
edit(ws, "      // A burst ceiling on the whole API.", "      if (req.headers['x-kept-user'] && req.headers['x-kept-user'] !== String(acct._id)) {\n        res.writeHead(409, { 'Content-Type': 'application/json' });\n        res.end(JSON.stringify({ error: 'account_changed' }));\n        return;\n      }\n      // A burst ceiling on the whole API.");
edit(ws, "      req.destroy();\n      res.writeHead(303, { Location: '/app?shared=retry' });\n      res.end();", "      res.writeHead(303, { Location: '/app?shared=retry', Connection: 'close' });\n      res.end();\n      // No body parser or storage: close after the response is delivered.\n      res.on('finish', () => req.socket?.end());");
edit(app, '<script src="/library-sync.js"></script>', '<script src="/library-cache.js"></script>\n<script src="/library-sync.js"></script>');
edit(app, `const KEY="reading-journal-v1";
let state;
try { state=JSON.parse(sessionStorage.getItem(KEY+":pending")||localStorage.getItem(KEY)||"{}"); }
catch { state={}; }
state.books=Array.isArray(state.books)?state.books:[];`, `const cacheOwner=window.__me?.id || (window.Telegram?.WebApp?.initData ? String(window.Telegram.WebApp.initDataUnsafe?.user?.id || '') : '') || null;
const libraryCache=createKeptLibraryCache({local:localStorage,session:sessionStorage,owner:cacheOwner});
const KEY=libraryCache.key;
let state=libraryCache.initial;`);
edit(app, '  return fetch(path,o);', '  if(cacheOwner) o.headers["x-kept-user"]=cacheOwner;\n  return fetch(path,o);');
edit(app, `  // A tab's pending version survives reload even if another tab updates the shared cache.
  if(state.syncDirty) sessionStorage.setItem(KEY+":pending",JSON.stringify(state));
  else sessionStorage.removeItem(KEY+":pending");
  localStorage.setItem(KEY,JSON.stringify(state));`, '  libraryCache.save(state);');
edit(app, '  read:()=>state, write:cacheShelf,', '  read:()=>state, write:cacheShelf, owner:cacheOwner,');
edit(app, '    localStorage.setItem(KEY+":recovery:"+Date.now(),JSON.stringify(state));', '    libraryCache.backup(state);');
edit(app, '  document.getElementById("sync-cloud").hidden=kind!=="conflict";', `  if(kind==="account") document.getElementById("sync-message").textContent="This tab belongs to a different signed-in account. Download its notes, then reload. Nothing has been uploaded to the new account.";
  if(kind==="signedout") document.getElementById("sync-message").textContent="Sign in again to sync. Your unsent notes remain on this device.";
  if(kind==="storage") document.getElementById("sync-message").textContent="Browser storage could not save a copy. Keep this tab open and download your notes now.";
  document.getElementById("sync-cloud").hidden=kind!=="conflict";`);
edit(app, '  <style>#sync-status[hidden]{display:none}</style>', '  <style>#sync-status[hidden],#sync-status button[hidden],#legacy-recovery[hidden]{display:none}</style>\n  <aside id="legacy-recovery" class="sec" hidden><p>Older notes are still stored on this device. They have not been uploaded or removed.</p><button class="btn ghost" id="legacy-download" type="button">Download older device copies</button></aside>');
edit(app, 'document.getElementById("sync-download").onclick=downloadLocalShelf;', `document.getElementById("sync-download").onclick=downloadLocalShelf;
const olderCopies=libraryCache.recoveries();
document.getElementById("legacy-recovery").hidden=!olderCopies.length;
document.getElementById("legacy-download").onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),copies:olderCopies},null,2)],{type:"application/json"}));
  const a=document.createElement("a");a.href=url;a.download="kept-older-device-copies.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
};`);
edit(app, '        toast("Sync needs attention in Library. Your message is still here.");', '        document.getElementById("tab-library").click();\n        toast("Sync needs attention. Your mentor message is still in its text box.");');
for (const [path, content] of files) writeFileSync(path, content);
console.log('Applied release hardening to ' + files.size + ' files.');
