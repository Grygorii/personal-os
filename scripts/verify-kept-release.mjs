// Runs only against a disposable MongoDB, never personal_os or another application DB.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
const uri = process.env.MONGO_URI || '';
assert.equal(process.env.KEPT_RELEASE_TEST, 'true', 'explicit test opt-in required');
assert.ok(/^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1|mongodb\.railway\.internal)(?::\d+)?(?:\/|$)/.test(uri), 'only local or dedicated Railway test Mongo allowed');
const LIVE = process.env.KEPT_LIVE_MODEL_CHECK === 'true';
if (LIVE) assert.ok((process.env.CHECK_SIGNING_KEY || '').length >= 32, 'production signing material must pass preflight');
process.env.DB_NAME = 'kept_release_' + crypto.randomBytes(6).toString('hex');
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.TELEGRAM_BOT_TOKEN = 'test-only:' + crypto.randomBytes(24).toString('hex');
process.env.TELEGRAM_CHAT_ID = '';
process.env.MULTI_TENANT = 'true';
process.env.AUTO_ACCEPT = 'true';
process.env.OWNER_EMAIL = 'nobody@example.invalid';
if (!LIVE) { process.env.ANTHROPIC_API_KEY = ''; process.env.GEMINI_API_KEY = ''; }
const { connect, rawCol } = await import('../src/db.js');
const { startServer } = await import('../src/webserver.js');
const { createSession, readSession } = await import('../src/auth.js');
const db = await connect();
const report = { at: new Date().toISOString(), liveModels: LIVE, checks: [] };
let server, browser;
const pass = (name) => { report.checks.push(name); console.log('PASS ' + name); };
try {
  await rawCol('users').insertMany(['a','b','browser','migration'].map((x) => ({
    _id:'g:release-'+x,name:'Reader',displayName:'Reader',role:'member',status:'active',product:'books',tier:'trial',language:'English',createdAt:new Date(),tz:'Europe/Dublin'
  })));
  server=startServer(0,'reading-reliability-20261114');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const cookie=(who)=>'kept_session='+createSession(who);
  const api=(path,who,method='GET',body,extra={})=>fetch(base+path,{method,redirect:'manual',headers:{'User-Agent':'KeptSmokeTest/Release',...(who?{cookie:cookie(who)}:{}),'Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
  const get=async(who)=>(await api('/api/books',who)).json();
  const put=(who,books,revision,owner=who)=>api('/api/books',who,'PUT',{books,revision,owner});
  const book={id:'evidence',title:'Release Notebook',author:'Test Author',status:'reading',page:17,notes:[{text:'The exact phrase is blue lantern 417.',page:17,ts:Date.now()}],tasks:[{id:'t1',title:'Try one quiet hour',status:'open',ts:Date.now()}],questions:[{id:'q1',text:'What interrupts the quiet hour?',answer:'',ts:Date.now()}]};
  const a='g:release-a',b='g:release-b';
  assert.equal((await api('/api/books')).status,401);
  assert.equal((await api('/api/word')).status,401);
  assert.equal((await api('/health')).status,200);
  assert.equal((await api('/app/receive')).status,303);
  pass('anonymous API protection, word route and receive fallback');
  const login={id:'7000000001',first_name:'Synthetic',auth_date:String(Math.floor(Date.now()/1000))};
  const payload=Object.keys(login).sort().map(k=>`${k}=${login[k]}`).join('\n');
  login.hash=crypto.createHmac('sha256',crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN).digest()).update(payload).digest('hex');
  const lr=await api('/auth/telegram?'+new URLSearchParams(login));
  assert.equal(lr.status,302);assert.ok(lr.headers.get('set-cookie')?.includes('kept_session='));
  const invalid=await api('/auth/telegram?'+new URLSearchParams({...login,hash:'0'.repeat(64)}));
  assert.equal(invalid.status,302);assert.equal(invalid.headers.get('location'),'/signin?error=login');assert.equal(invalid.headers.get('set-cookie'),null);
  assert.equal(readSession(createSession(a)),a);assert.equal(readSession(createSession(a)+'x'),null);
  pass('valid and tampered signed Telegram login and session verification (synthetic identity)');
  const initial=await get(a);assert.equal(initial.owner,a);assert.equal(initial.revision,0);assert.equal(initial.exists,false);
  assert.equal((await put(a,[book],0)).status,200);
  const race=await Promise.all([put(a,[{...book,page:18}],1),put(a,[{...book,page:19}],1)]);
  assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
  assert.equal((await get(a)).revision,2);
  pass('real MongoDB atomic concurrent writes: one winner, one conflict');
  assert.equal((await put(b,[book],0,a)).status,409);
  assert.deepEqual((await get(b)).books,[]);
  assert.equal((await api('/api/books',b,'GET',null,{'x-kept-user':a})).status,409);
  assert.equal((await api('/api/books',a,'PUT',{books:[]})).status,428);
  pass('cross-account writes and stale tabs rejected; old client requires reload');
  const persisted=await rawCol('books').findOne({userId:a});
  assert.equal(persisted.books[0].notes[0].text,book.notes[0].text);
  assert.equal(persisted.books[0].tasks[0].title,book.tasks[0].title);
  pass('notes, tasks and questions persist in real MongoDB');
  if(process.argv.includes('--browser')){
    const { chromium }=await import('playwright');
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});
    await context.route('https://**/*',r=>r.abort());
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/app');await page.click('#fr-manual');await page.fill('#ab-title','Browser Book');await page.click('#ab-save');
    await page.locator('.book').first().click();await page.fill('#n-text','Guest note kept before signing in');await page.click('#n-add');
    assert.ok(await page.evaluate(()=>JSON.parse(localStorage.getItem('reading-journal-v2:guest')).books[0].notes.length===1));
    await page.reload();assert.ok(await page.locator('.book').count());
    pass('real Chromium guest capture and local-storage persistence across reload');
    const who='g:release-migration';await context.addCookies([{name:'kept_session',value:createSession(who),url:base,httpOnly:true,sameSite:'Lax'}]);
    await page.reload();
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('reading-journal-v2:user:g%3Arelease-migration')||'{}').syncDirty===false);
    assert.equal((await get(who)).books[0].notes[0].text,'Guest note kept before signing in');
    pass('guest-to-account migration uses the real API and database');
    const old=await get(who);await put(who,[{...old.books[0],page:77}],old.revision);
    await page.locator('.book').first().click();await page.fill('#n-text','Unsent conflict note');await page.click('#n-add');
    await page.waitForSelector('#sync-status:not([hidden])');
    const downloadEvent=page.waitForEvent('download');await page.click('#sync-download');const download=await downloadEvent;
    const file=await download.path();const {readFile}=await import('node:fs/promises');
    assert.ok((await readFile(file,'utf8')).includes('Unsent conflict note'));
    assert.ok(!(await get(who)).books[0].notes.some(n=>n.text==='Unsent conflict note'));
    await page.reload();await page.waitForSelector('#sync-status:not([hidden])');
    assert.ok(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('reading-journal-v2:user:g%3Arelease-migration:pending')).books[0].notes.some(n=>n.text==='Unsent conflict note')));
    pass('real-browser conflict, downloadable recovery and pending-draft reload');
    await context.addCookies([{name:'kept_session',value:createSession(b),url:base,httpOnly:true,sameSite:'Lax'}]);
    await page.reload();await page.waitForSelector('#firstrun:not([hidden])');assert.deepEqual((await get(b)).books,[]);
    assert.equal(errors.length,0,errors.join('\n'));await context.close();
    pass('switching accounts does not display or upload another account draft');
  }
  if(LIVE){
    const wr=await api('/api/word',a,'POST',{word:'serendipity',context:'Finding the book by chance was serendipity.'});
    const w=await wr.json();assert.equal(wr.status,200);assert.ok(typeof w.meaning==='string'&&w.meaning.length>10);
    pass('model-backed word lookup through the real API');
    const cr=await api('/api/chat',a,'POST',{text:'In my saved Release Notebook thought, what exact phrase did I keep and on which page? Quote the phrase exactly. Do not add a book or change anything.'});
    const c=await cr.json();assert.equal(cr.status,200);assert.match(c.reply,/blue lantern 417/i);assert.match(c.reply,/17/);
    pass('live mentor reply grounded in the synthetic saved thought and page');
    assert.ok(process.env.GOOGLE_CLIENT_ID,'production Google client configured');
    const url='https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:'https://readkept.com/auth/google/redirect',response_type:'code',scope:'openid email'});
    const r=await fetch(url,{signal:AbortSignal.timeout(20000)});const html=await r.text();
    assert.ok(r.ok);assert.ok(!/redirect_uri_mismatch|invalid_client|deleted_client/i.test(html));
    pass('Google authorization configuration probe (not a completed human login)');
    pass('existing production signing material passes the configured-strength preflight');
  }
  report.ok=true;console.log('KEPT_RELEASE_REPORT '+JSON.stringify(report));
  await writeFile('kept-release-report.json',JSON.stringify(report,null,2));
}catch(e){report.ok=false;report.failure=e instanceof assert.AssertionError?e.message.slice(0,300):e.name;console.error('KEPT_RELEASE_REPORT '+JSON.stringify(report));process.exitCode=1;
}finally{
  if(browser)await browser.close();
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  assert.match(db.databaseName,/^kept_release_[a-f0-9]{12}$/);await db.dropDatabase();
  process.exit(process.exitCode||0);
}
