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

async function grab(path, opts = {}) {
  const res = await fetch(BASE + path, { redirect: 'manual', headers: opts.headers || {} });
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

// ---- 4. the hidden attribute is not defeated by a display rule ----
// This is the guestbar bug as a rule rather than a memory. Any selector that sets a display
// on an element the app also hides with [hidden] needs an explicit [hidden] guard.
console.log('\nhidden means hidden');
for (const cls of ['guestbar', 'form', 'cropsel']) {
  const hasDisplay = new RegExp(`\\.${cls}\\{[^}]*display:`).test(app.body);
  const guarded = app.body.includes(`.${cls}[hidden]{display:none}`);
  ok(!hasDisplay || guarded, `.${cls} — no display rule, or an [hidden] guard exists`);
}

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

console.log(`\n${failed ? `${failed} FAILED` : 'all good'} — build ${build || '?'}\n`);
process.exit(failed ? 1 : 0);
