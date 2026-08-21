// What the live site must be true about, checked from outside, after every deploy.
//
//   node scripts/smoke.mjs                  # https://readkept.com
//   node scripts/smoke.mjs http://localhost:3000
//
// This exists because of four bugs in a row that no unit test could have caught, because
// none of them were about logic:
//
//   · OWNER_LINK printed on screen as literal text, because a placeholder wasn't substituted
//   · an unsubstituted IS_GUEST threw a ReferenceError that killed the whole app script
//   · .guestbar{display:flex} beat the hidden attribute, so "Not signed in" showed to the
//     owner, who was very much signed in
//   · /reading served the app's raw template, placeholders and all
//
// Every one of them was visible in one second to anyone who fetched the page and looked.
// Nobody looked, because looking was manual. So: assertions about the served bytes, run
// against whatever is actually deployed, exiting non-zero when the site is lying.

const BASE = (process.argv[2] || 'https://readkept.com').replace(/\/$/, '');
let failed = 0;
const ok = (cond, what, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${what}${detail && !cond ? `  — ${detail}` : ''}`);
};

// Say who we are on every request. Node's fetch sends no User-Agent at all, and a request
// with none used to be filed as a person — so every run of this file added two visitors to
// the day's count, and a dozen deploy checks became a dozen phantom readers in the admin.
const UA = 'KeptSmokeTest/1 (+https://readkept.com)';

async function grab(path, opts = {}) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
  });
  return { status: res.status, loc: res.headers.get('location'), body: await res.text(), res };
}

// A placeholder inside a comment is documentation; one anywhere else is a bug on somebody's
// screen. Strip comments before looking, or this check cries wolf forever and gets ignored.
const stripComments = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

console.log(`\nKept · smoke test against ${BASE}\n`);

// ---- 1. the pages a stranger sees ----
console.log('pages load');
const landing = await grab('/');
ok(landing.status === 200, 'GET / is 200', `got ${landing.status}`);
const app = await grab('/app');
ok(app.status === 200, 'GET /app is 200 (open to guests)', `got ${app.status}`);
const signin = await grab('/signin');
ok(signin.status === 200, 'GET /signin is 200', `got ${signin.status}`);
const privacy = await grab('/privacy');
ok(privacy.status === 200, 'GET /privacy is 200', `got ${privacy.status}`);

// ---- 2. nothing raw reaches a reader ----
console.log('\nno unsubstituted placeholders');
for (const [name, page] of [['/', landing], ['/app', app], ['/signin', signin]]) {
  const clean = stripComments(page.body);
  for (const ph of ['ME_JSON', 'OWNER_LINK', 'IS_GUEST', 'GOOGLE_CLIENT_ID', 'APP_URL', 'undefined%']) {
    ok(!clean.includes(ph), `${name} has no raw ${ph}`);
  }
}

// ---- 3. the app knows who is looking, and fails safe ----
console.log('\nthe app is told who is looking');
const me = app.body.match(/window\.__me=(\{.*?\});/);
ok(!!me, 'window.__me is injected');
if (me) {
  let parsed = null;
  try { parsed = JSON.parse(me[1]); } catch { /* reported below */ }
  ok(!!parsed, 'it is valid JSON', me[1]);
  ok(parsed?.guest === true, 'an anonymous fetch is treated as a guest', JSON.stringify(parsed));
  ok(parsed?.owner === false, 'and is never the owner', JSON.stringify(parsed));
}
// The whole point of the try/catch wrapper: a failed substitution must not take the app down.
ok(app.body.includes('try{window.__me='), 'the injection is inside a try, so a miss is survivable');
ok(app.body.includes('window.__me || {'), 'and there is a guest fallback if it is missing');

// The landing page now promises you can find any thought again. That promise has to be
// backed by something that actually exists in the app — the page spent weeks describing a
// benefit the product could not deliver, which is exactly why it read as a test instead.
console.log('\nthe promise the page makes is real');
ok(app.body.includes('id="find"'), '/app has the thought search the landing page promises');
ok(app.body.includes('function findThoughts'), 'and the search actually runs');
ok(landing.body.includes('Everything worth keeping'), 'the landing page leads with the gain');

// The other half of the motto. "Use what you read" was a claim about memory only — the app
// could hold what you read and test whether you kept it, and had nowhere to put what you were
// going to DO about it. These check the surfaces exist, because a tab that isn't in the served
// bytes is a tab nobody has.
console.log('\nwhat you do about what you read');
ok(app.body.includes('id="tab-do"'), '/app has the Do tab');
ok(app.body.includes('id="view-do"'), 'and the panel it opens');
ok(app.body.includes('function renderDo'), 'and the code that draws it');
ok(app.body.includes('id="t-add"') && app.body.includes('id="q-add"'),
  'a book can start a task and a question');
ok(app.body.includes('function placeSheet'), 'and a question can keep the link to where it was asked');
ok(app.body.includes('/api/convo'), 'and the app knows where the shared page lives');

// ---- every page is the same product ----
// He found a shared link that still had "the old app look" — and he was right twice: /signin
// and /privacy were still black-and-gold months after the product moved to cream, so tapping
// "Try it free" dropped a visitor through a trapdoor into the previous brand at the exact
// moment they were deciding whether to trust it. A page can be missed by a repalette in
// silence, so the palette is asserted rather than remembered.
console.log('\nevery page is the same product');
{
  // Two creams exist on purpose and neither is the old black: #FCFAF5 is the document cream
  // for pages that are read (landing, privacy, a shared page), #EEEDE8 is a shade down for
  // the app, where white cards sit on it and need to separate. What must never happen again
  // is a page whose LIGHT mode is the dark paper — that is the old coat, not a shade choice.
  const CREAMS = ['#FCFAF5', '#EEEDE8'];
  const pages = [['/', landing], ['/signin', signin], ['/privacy', privacy], ['/app', app]];
  for (const [name, page] of pages) {
    // The FIRST --paper in source order is the light default; the dark ones come later inside
    // prefers-color-scheme blocks. (Matching a whole :root{...} block does not work here — the
    // app's light block is longer than any sane window, so the regex fell through to the dark
    // one and reported a fault that did not exist.)
    const paper = (page.body.match(/--paper:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
    ok(!!paper && CREAMS.includes(paper.toUpperCase()),
      `${name} opens on cream, not on the old dark paper`, `got ${paper || 'no --paper'}`);
    ok(/prefers-color-scheme\s*:\s*dark/.test(page.body), `${name} answers to dark mode`);
    // The retired brand gold. --star and --mark are warm yellows by design; a hardcoded
    // D9AE4A as an accent or a link colour is the old coat showing through.
    const goldAccent = /(?:--accent|color)\s*:\s*#D9AE4A/i.test(page.body);
    ok(!goldAccent, `${name} has no leftover gold accent`);
    ok(!page.body.includes('#231a05'), `${name} has no text colour hardcoded for the old gold`);
  }
}

// Wave 1: the funnel can see inside the app. 400 app opens produced no accounts and nothing
// could say what those people did — every fix after that was guesswork.
console.log('\nwe can see where people fall');
for (const beat of ['opened', 'empty_shelf', 'book_added', 'thought_saved', 'exam_graded', 'wall_hit'])
  ok(app.body.includes(`step("${beat}")`), `/app reports "${beat}"`);
ok(app.body.includes('sessionStorage.getItem'), 'each beat counts once per visit, not once per tap');
{
  // Open to guests on purpose — the people we most need to see are the ones with no account.
  const s = await grab('/api/step', { headers: { 'Content-Type': 'application/json' } });
  ok(s.status === 405, '/api/step refuses anything but POST', `got ${s.status}`);
  // And the privacy page has to keep describing what is actually counted.
  ok(/reached each step/i.test(privacy.body), '/privacy says the steps are counted');
  ok(/no cookie/i.test(privacy.body) && /identifier/i.test(privacy.body),
    'and that no cookie or identifier is involved');
}

// Wave 2: a stranger reaches the thing that makes this product distinctive BEFORE being asked
// for anything. Photographing a page used to be behind a wall, so the ask arrived as a door at
// the exact moment the product was about to prove itself.
console.log('\na stranger can taste it first');
ok(!app.body.includes('guestBlocked("Reading a page"'), 'photographing a page is no longer walled');
ok(!app.body.includes('guestBlocked("Tidying up"'), 'nor is tidying');
ok(app.body.includes('function freeSpent'), 'and running out is handled as an offer');
{
  // The endpoint really is open to a guest, and really is metered. Has to be a POST: a GET is
  // deliberately not a free try, so checking one would only prove the method guard works.
  // Text this short returns before any model call, so this costs nothing but one of the day's
  // 250 free tries — a fair price for knowing the front door is open.
  const free = await fetch(`${BASE}/api/tidy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ text: 'x' }),
  });
  const freeBody = await free.json().catch(() => ({}));
  ok(free.status === 200, '/api/tidy runs for a guest with no account', `got ${free.status}`);
  ok(typeof freeBody.freeLeft === 'number', 'and tells them how many tries are left',
    JSON.stringify(freeBody).slice(0, 60));
  ok(/kept_free=/.test(free.headers.get('set-cookie') || ''), 'and counts it on their device');
  // Everything that stores or remembers still needs an account.
  for (const p of ['/api/chat', '/api/bookexam', '/api/share']) {
    const r = await grab(p);
    ok(r.status === 401 || r.status === 405, `${p} still requires an account`, `got ${r.status}`);
  }
  ok(/free tries/i.test(privacy.body), '/privacy declares the free-tries cookie');
  ok(/Four cookies/i.test(privacy.body), 'and counts the cookies correctly');
}

// Wave 3: the empty shelf, where "added a book" has always died. The find-a-book lookup — the
// one the landing page demonstrates as the way in — was behind the auth gate, so for every
// guest who ever typed a title the results came back empty and they were left filling four
// fields by hand. This is the check that it is genuinely open.
console.log('\na stranger can find their book');
{
  const look = await grab('/api/booksearch?q=atomic+habits');
  ok(look.status === 200, '/api/booksearch answers a guest', `got ${look.status}`);
  let results = null;
  try { results = JSON.parse(look.body).results; } catch { /* reported below */ }
  ok(Array.isArray(results) && results.length > 0,
    'and finds real books', look.body.slice(0, 80));
  ok(!!results?.[0]?.author, 'with the author filled in, so nobody has to type it');
}
ok(app.body.includes('id="firstrun"'), '/app opens an empty shelf on one question');
ok(app.body.includes('What are you reading right now?'), 'and that question is the one that matters');
ok(app.body.includes('function addBookFrom'), 'and picking a book IS adding it');
ok(app.body.includes('id="fr-manual"'), 'with a way out when the search cannot find it');
ok(app.body.includes('.stats[hidden]{display:none}'),
  'and the row of zeros can actually be hidden');

// Wave 4: the exam is the only genuinely novel thing here, and finishing a book used to lead
// nowhere at all — the status flipped and the offer sat two screens down waiting to be found.
console.log('\nfinishing a book leads to the exam');
ok(app.body.includes('function offerExam'), '/app offers the exam when a book is finished');
ok(app.body.includes('examOffered'), 'and remembers, so it asks once rather than nagging');
ok(app.body.includes('function shareResult'), 'and a result can be sent from where it was earned');
ok(/understood \$\{res\.understood|understood:res\.understood/.test(app.body),
  'and the three dimensions travel with it');

// Almost everyone opens this on a phone, so the tap-target floor is a product rule, not a
// preference. It is declared once as --tap; these check the token exists and that no component
// has quietly gone back under it.
console.log('\nthings you tap are big enough to tap');
ok(app.body.includes('--tap:44px'), '/app declares the 44px tap floor in one place');
{
  const small = [...app.body.matchAll(/min-height:\s*(\d+)px/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0 && n < 44);
  ok(small.length === 0, 'no component sets a tap target under 44px',
    small.length ? `found ${small.join('px, ')}px` : '');
}

// ---- 4. the hidden attribute is not defeated by a display rule ----
// This is the guestbar bug as a rule rather than a memory. Any selector that sets a display
// on an element the app also hides with [hidden] needs an explicit [hidden] guard.
console.log('\nhidden means hidden');
// .reader and .rdsel are the reader's two layers, and both are flex containers the app hides
// with the attribute — exactly the shape the guestbar bug had.
for (const cls of ['guestbar', 'form', 'cropsel', 'bar', 'steps', 'places', 'addrow', 'reader', 'rdsel']) {
  const hasDisplay = new RegExp(`\\.${cls}\\{[^}]*display:`).test(app.body);
  const guarded = app.body.includes(`.${cls}[hidden]{display:none}`);
  ok(!hasDisplay || guarded, `.${cls} — no display rule, or an [hidden] guard exists`);
}

// ---- 4b. the reader ships whole ----
// The reader is one block of markup and one block of script inside the same file as the rest
// of the app, so the failure to guard against is a partial deploy: the button arrives, the
// code behind it does not, and tapping Read does nothing at all. These check both halves are
// present, and that the file is still never uploaded — the promise the feature is built on.
console.log('\nthe reader');
ok(app.body.includes('id="reader"'), 'the reading layer is in the page');
ok(app.body.includes('id="rd-sel"'), 'the selection bar that turns a line into a thought');
ok(/function rdOpen\b/.test(app.body), 'rdOpen is defined, so the Read button has something to call');
ok(/DecompressionStream/.test(app.body), 'the EPUB is unpacked in the browser');
ok(/indexedDB\.open/.test(app.body), 'the book is stored on the device');
// If a request body ever carries the file, this is the line that catches it.
ok(!/api\/(upload|book(file|s\/file))/.test(app.body), 'no upload endpoint — the file stays on the phone');
ok(app.body.includes('<meta charset="utf-8">'), 'the page declares its own encoding');

// ---- 5. gating ----
console.log('\ngating');
const admin = await grab('/admin');
ok(admin.status === 302 || admin.status === 403, `/admin refuses a stranger`, `got ${admin.status}`);
ok(!admin.body.includes('Kept · admin'), '/admin leaks no markup to a stranger');
for (const p of ['/admin/reply', '/admin/read', '/admin/invite', '/admin/unshare']) {
  const r = await grab(p);
  ok(r.status === 302 || r.status === 403 || r.status === 405, `${p} refuses a stranger`, `got ${r.status}`);
}
const exp = await grab('/api/export');
ok(exp.status === 401, '/api/export refuses a guest', `got ${exp.status}`);
// The owner's own modules. These were served to anyone who asked until the route table
// learned the difference between "substitute APP_URL here" and "anyone may read this".
for (const p of ['/hub', '/home', '/deck', '/body', '/routine', '/dashboard']) {
  const r = await grab(p);
  ok(r.status === 302 || r.status === 403, `${p} is not open to strangers`, `got ${r.status}`);
}
const personal = await grab('/api/personal?key=body');
ok(personal.status === 401 || personal.status === 403,
  '/api/personal refuses a stranger', `got ${personal.status}`);
// A shared task or question is a page anyone may READ and reply to — that's the point — but
// opening one, rewriting one, or reading its replies belongs to whoever made it.
const convo = await grab('/api/convo');
ok(convo.status === 401, '/api/convo refuses a guest', `got ${convo.status}`);
const ghostConvo = await grab('/c/deadbeefdeadbeef');
ok(ghostConvo.status === 404, '/c/<unknown> is a clean 404', `got ${ghostConvo.status}`);
const reading = await grab('/reading');
ok(reading.status === 301 && reading.loc === '/app', '/reading redirects to /app',
  `got ${reading.status} ${reading.loc}`);

// ---- 6. writing in needs no account ----
console.log('\nanyone can write in');
const mail = await grab('/api/contact');
ok(mail.status === 200, 'GET /api/contact answers a guest', `got ${mail.status}`);
try {
  ok(Array.isArray(JSON.parse(mail.body).msgs), 'and returns a thread shape');
} catch { ok(false, 'and returns a thread shape', mail.body.slice(0, 80)); }

// ---- 7. the plumbing everything else depends on ----
console.log('\nplumbing');
const version = await grab('/version');
ok(version.status === 200, '/version is 200', `got ${version.status}`);
let build = null;
try { build = JSON.parse(version.body).build; } catch { /* reported */ }
ok(!!build, `/version names the build`, version.body.slice(0, 80));
ok(app.res.headers.get('cache-control') === 'no-store',
  '/app is no-store, so a change reaches people without them acting',
  app.res.headers.get('cache-control'));
const csp = app.res.headers.get('content-security-policy') || '';
ok(csp.includes('blob:'), 'CSP allows blob: — photo capture needs it');
ok(csp.includes('accounts.google.com'), 'CSP allows accounts.google.com — redirect sign-in needs it');
for (const icon of ['/icon-180.png', '/icon-192.png', '/manifest.webmanifest', '/robots.txt', '/sitemap.xml']) {
  const r = await grab(icon);
  ok(r.status === 200, `${icon} is served`, `got ${r.status}`);
}

// ---- 8. one canonical host ----
// Skipped until www has DNS, because a hostname that doesn't resolve can't be tested and a
// permanently-failing check is a check everybody learns to ignore.
console.log('\none canonical host');
const wwwHost = new URL(BASE).host.replace(/^www\./, '');
if (!/^localhost|^127\./.test(wwwHost)) {
  let reachable = true;
  let r = null;
  try {
    r = await fetch(`https://www.${wwwHost}/app`, { redirect: 'manual' });
  } catch { reachable = false; }
  if (!reachable) {
    console.log(`  skip  www.${wwwHost} has no DNS yet — nothing to check`);
  } else {
    ok(r.status === 301, `www.${wwwHost} 301s to the apex`, `got ${r.status}`);
    ok((r.headers.get('location') || '').startsWith(`https://${wwwHost}/`),
      'and points at the apex', r.headers.get('location') || '(none)');
  }
}

// ---- 9. can a stranger ACTUALLY sign in? ----
//
// The most important question about the product, and for two days nothing asked it.
//
// Switching to ux_mode:'redirect' changed what Google requires: popup mode needs only an
// authorised JavaScript ORIGIN, redirect mode needs the full redirect URI registered too.
// The code was right, the console was never updated, and every sign-in failed with
// redirect_uri_mismatch from 2 August onward — about a hundred and eleven people — while the
// page itself looked perfect and the funnel got blamed instead.
//
// Nothing here can be checked from the served HTML: the failure lives at Google. So ask
// Google, using the client_id and login_uri the live page is really sending.
console.log('\nsign-in actually works');
{
  const cid = (signin.body.match(/client_id: '([^']+)'/) || [])[1];
  const uri = (signin.body.match(/login_uri: '([^']+)'/) || [])[1];
  ok(!!cid, 'the sign-in page carries a client_id');
  ok(!!uri, 'and a login_uri', uri || '(none)');
  if (cid && uri) {
    ok(uri.startsWith(`https://${new URL(BASE).host}/`) || BASE.includes('localhost'),
      'the login_uri points at this host', uri);
    try {
      const probe = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(cid)}`
        + `&redirect_uri=${encodeURIComponent(uri)}&response_type=code&scope=openid%20email`;
      const page = await (await fetch(probe, { redirect: 'follow' })).text();
      const mismatch = /redirect_uri_mismatch/i.test(page);
      ok(!mismatch, 'Google accepts the redirect URI (no redirect_uri_mismatch)',
        mismatch ? `Google refuses ${uri} — add it under Authorized redirect URIs for this OAuth client` : '');
    } catch (e) {
      console.log(`  skip  could not reach Google to check the OAuth config (${e.message})`);
    }
  }
}

console.log(`\n${failed ? `${failed} FAILED` : 'all good'} — build ${build || '?'}\n`);
process.exit(failed ? 1 : 0);
