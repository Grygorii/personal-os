// Does the Pocket Mini App actually DRAW?
//
// `npm test` proves the arithmetic. It cannot prove the page survives contact with it, and this
// project has already lost a whole app to that gap: a ReferenceError in one line of an inline
// script does not fail softly — it kills the entire script and serves a blank page, with every
// unit test still green. `scripts/smoke.mjs` exists for the same reason on the Kept side.
//
// So this builds the real /api/state payload from fixtures, runs app.html's script against a
// small DOM shim, and asserts that all four panels drew and that the things that should be on
// them are on them. No database, no network, no Telegram.
//
//   node scripts/pocket-render.mjs
//
// The fixtures are deliberately his own shape: euro salary, Egyptian rent, an EGP certificate
// paying quarterly, one that matured years ago, one maturing soon, a credit card, and a month
// with a recurring entry still missing.

import { readFileSync } from 'fs';
import vm from 'vm';
import { buildState } from '../src/pocket/web.js';
import { cleanAccount, cleanFlow } from '../src/pocket/money.js';

const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const NOW = utc(2026, 9, 15);
const T = { base: 'EUR', rates: { EUR: 1, USD: 1.08, EGP: 54 }, at: NOW };
const fail = (msg) => { console.error('FAIL  ' + msg); process.exitCode = 1; };

const accounts = [
  cleanAccount({ id: 'a1', label: 'Bank', kind: 'cash', currency: 'EUR', value: 5000 }),
  cleanAccount({ id: 'a2', label: 'Cairo CD', kind: 'deposit', currency: 'EGP', value: 495000, ratePct: 20, payout: 'quarterly', startsAt: utc(2024, 5, 28), endsAt: utc(2027, 5, 28) }),
  cleanAccount({ id: 'a3', label: 'Old CD', kind: 'deposit', currency: 'EGP', value: 100000, ratePct: 15, payout: 'maturity', startsAt: utc(2020, 1, 1), endsAt: utc(2021, 1, 1) }),
  cleanAccount({ id: 'a4', label: 'Soon CD', kind: 'deposit', currency: 'EGP', value: 50000, ratePct: 18, payout: 'monthly', startsAt: utc(2025, 1, 1), endsAt: utc(2026, 11, 1) }),
  cleanAccount({ id: 'a5', label: 'Cairo flat', kind: 'property', currency: 'EGP', value: 2700000 }),
  cleanAccount({ id: 'a6', label: 'Visa', kind: 'card', currency: 'EUR', value: 1200, ratePct: 19 }),
  cleanAccount({ id: 'a7', label: 'eToro', kind: 'portfolio', currency: 'USD', value: 1080 }),
];
const spanFlows = [
  cleanFlow({ id: 'f1', dir: 'in', category: 'salary', amount: 3200, currency: 'EUR', ts: utc(2026, 8, 1), recurring: true }),
  cleanFlow({ id: 'f2', dir: 'in', category: 'rent', amount: 27000, currency: 'EGP', ts: utc(2026, 8, 3), recurring: true }),
  cleanFlow({ id: 'f3', dir: 'out', category: 'food', amount: 410, currency: 'EUR', ts: utc(2026, 8, 9) }),
  cleanFlow({ id: 'f4', dir: 'out', category: 'food', amount: 52, currency: 'EUR', ts: utc(2026, 9, 4) }),
  cleanFlow({ id: 'f5', dir: 'in', category: 'salary', amount: 3200, currency: 'EUR', ts: utc(2026, 9, 1), recurring: true }),
  cleanFlow({ id: 'f6', dir: 'out', category: 'flights', amount: 640, currency: 'EUR', ts: utc(2026, 7, 12) }),
];
const goal = { monthly: 2000, currency: 'EUR' };
const events = { years: 10, list: [{ id: 'e1', atYear: 3, kind: 'income', amount: 400, label: 'second rental' }] };

const html = readFileSync(new URL('../src/pocket/app.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g, '');

/** Just enough DOM for the drawing code. Anything it reaches for that is not here shows up as a
 *  crash, which is the point — this is a tripwire, not a browser. */
function shim() {
  const made = new Map();
  const el = (id) => {
    if (!made.has(id)) {
      made.set(id, {
        id, _html: '', hidden: false, textContent: '', value: '', disabled: false,
        scrollLeft: 0, clientWidth: 360, offsetLeft: 0, offsetWidth: 76, dataset: {}, style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, closest() { return null; }, focus() {},
      });
    }
    return made.get(id);
  };
  const document = {
    getElementById: el,
    querySelector: () => el('wrap'),
    querySelectorAll: () => [],
    body: { addEventListener() {}, classList: { add() {}, remove() {} } },
  };
  return { el, document };
}

function render(S, label) {
  const { el, document } = shim();
  const ctx = vm.createContext({
    document, window: { Telegram: undefined, confirm: () => true, alert: () => {} },
    console, fetch: async () => ({ ok: true, json: async () => S }),
    setTimeout, Date, Math, JSON, Intl, Number, String, Object, Array, encodeURIComponent, Set,
  });
  try {
    vm.runInContext(script, ctx);
    // The script's own `let S` shadows a context property, so it is assigned by its lexical name.
    ctx.__S = S;
    vm.runInContext('S = globalThis.__S; draw();', ctx);
  } catch (err) {
    fail(`${label}: the app script threw — this is the blank-page failure. ${err.message}`);
    return null;
  }
  return el;
}

function must(el, panel, needles, label) {
  const h = el(panel).innerHTML;
  if (!h) return fail(`${label}: ${panel} drew nothing`);
  for (const n of needles) if (!h.includes(n)) fail(`${label}: ${panel} is missing "${n}"`);
}

// ---- This month, everything present ----
{
  const S = buildState({ base: 'EUR', table: T, accounts, spanFlows, goal, events, now: NOW });
  const el = render(S, 'this month');
  if (el) {
    must(el, 'p-month', ['Repeats — not recorded yet', 'Yes, add it', 'Left over', 'September'], 'this month');
    must(el, 'p-worth', ['Cairo CD', 'earned so far', 'quarterly', 'matured on', 'matures in', 'Not counted:'], 'this month');
    must(el, 'p-goal', ['Already contracted', 'a month is scheduled'], 'this month');
    must(el, 'p-plan', ['Year by year', 'second rental'], 'this month');
  }
  if (S.months.length !== 12) fail('the strip should hold twelve months');
  if (S.monthKey !== '2026-09') fail('it should open on the month he is in');
  if (!S.missing.some((r) => r.category === 'rent')) fail('the Cairo rent repeats and was not recorded — it should be listed');
  if (S.missing.some((r) => r.category === 'salary')) fail('the salary WAS recorded this month and must not be listed again');
  if (!S.terms.matured.some((t) => t.label === 'Old CD')) fail('a matured certificate should be surfaced');
  if (!S.interest.ended.includes('Old CD')) fail('a term that ended must not still count as earning');
  if (Math.round(S.contracted.perMonth) !== 167) fail(`contracted income should be 167/month, got ${Math.round(S.contracted.perMonth)}`);
}

// ---- A month he scrolled back to ----
{
  const S = buildState({ base: 'EUR', table: T, monthKey: '2026-08', accounts, spanFlows, goal, events, now: NOW });
  const el = render(S, 'a past month');
  if (el) must(el, 'p-month', ['August', 'salary'], 'a past month');
  if (S.monthKey !== '2026-08') fail('the month asked for is the month shown');
  if (S.month.income !== 3700) fail(`August took in 3,200 EUR and 27,000 EGP = 3,700, got ${S.month.income}`);
  // The plan must not be rebuilt from whichever month he happens to be reading.
  const now = buildState({ base: 'EUR', table: T, accounts, spanFlows, goal, events, now: NOW });
  if (S.forecast.mid.endCapital !== now.forecast.mid.endCapital) fail('reading August rewrote the ten-year plan');
}

// ---- A month with nothing in it ----
{
  const S = buildState({ base: 'EUR', table: T, monthKey: '2026-02', accounts, spanFlows, goal, events, now: NOW });
  const el = render(S, 'an empty month');
  if (el) must(el, 'p-month', ['Nothing recorded in'], 'an empty month');
}

// ---- No exchange rates: nothing is totalled, and the page says so ----
{
  const S = buildState({ base: 'EUR', table: null, accounts, spanFlows, goal, events, now: NOW });
  const el = render(S, 'no rates');
  if (el) must(el, 'p-month', ['Exchange rates are unreachable'], 'no rates');
  if (S.ratesAvailable !== false) fail('with no rate table nothing may claim to be converted');
}

// ---- Nothing entered at all: the first thing he ever sees ----
{
  const S = buildState({ base: 'EUR', table: T, accounts: [], spanFlows: [], goal: null, events: { years: 10, list: [] }, now: NOW });
  const el = render(S, 'a brand new Pocket');
  if (el) {
    must(el, 'p-month', ['Nothing recorded in'], 'a brand new Pocket');
    must(el, 'p-worth', ['Nothing yet. Tap Add.'], 'a brand new Pocket');
    must(el, 'p-goal', ['No goal set'], 'a brand new Pocket');
  }
}

if (!process.exitCode) console.log('pocket-render: all five states drew, every expected element present');
