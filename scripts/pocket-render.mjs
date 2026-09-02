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
import { balanceNow } from '../src/pocket/money.js';
import { cleanAccount, cleanFlow, cleanSub } from '../src/pocket/money.js';

const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const NOW = utc(2026, 9, 15);
const T = { base: 'EUR', rates: { EUR: 1, USD: 1.08, EGP: 54 }, at: NOW };
const fail = (msg) => { console.error('FAIL  ' + msg); process.exitCode = 1; };

const accounts = [
  cleanAccount({ id: 'a1', label: 'Bank', kind: 'cash', currency: 'EUR', value: 5000 }),
  cleanAccount({ id: 'a2', label: 'Cairo CD', kind: 'deposit', currency: 'EGP', value: 495000, ratePct: 20, payout: 'quarterly', startsAt: utc(2024, 5, 28), endsAt: utc(2027, 5, 28) }),
  cleanAccount({ id: 'a3', label: 'Old CD', kind: 'deposit', currency: 'EGP', value: 100000, ratePct: 15, payout: 'maturity', startsAt: utc(2020, 1, 1), endsAt: utc(2021, 1, 1) }),
  cleanAccount({ id: 'a4', label: 'Soon CD', kind: 'deposit', currency: 'EGP', value: 50000, ratePct: 18, payout: 'monthly', startsAt: utc(2025, 1, 1), endsAt: utc(2026, 11, 1) }),
  // A flat has no rate — it has rent. This is the case he could not enter at all.
  cleanAccount({ id: 'a5', label: 'Cairo flat', kind: 'property', currency: 'EGP', value: 2700000, payout: 'monthly', payment: 27000, startsAt: utc(2023, 6, 1) }),
  cleanAccount({ id: 'a6', label: 'Visa', kind: 'card', currency: 'EUR', value: 1200, ratePct: 19 }),
  // His real car loan, with the instalment off his own statement. The app used to show 26,700 a
  // quarter here — interest only, about half the real bill — and count all 445,000 as still owed
  // while he was seven payments of ten through it.
  cleanAccount({ id: 'a8', label: 'Loan 1', kind: 'loan', currency: 'EGP', value: 445000, ratePct: 24, payout: 'quarterly', payment: 58063.45, startsAt: utc(2024, 11, 28), endsAt: utc(2027, 5, 28) }),
  cleanAccount({ id: 'a9', label: 'Loan 2', kind: 'loan', currency: 'EGP', value: 513000, ratePct: 28, payout: 'monthly', startsAt: utc(2024, 10, 26), endsAt: utc(2027, 5, 26) }),
  // A euro loan he has been overpaying. The balance has to reflect what he actually paid, not
  // what a borrower who paid exactly the schedule would owe.
  cleanAccount({
    id: 'a10', label: 'loan eur 1', kind: 'loan', currency: 'EUR', value: 9500, ratePct: 7.43,
    payout: 'monthly', payment: 192, startsAt: utc(2025, 10, 11), endsAt: utc(2030, 2, 28),
    payments: [
      { id: 'x1', at: utc(2026, 3, 15), amount: 500, note: 'bonus' },
      { id: 'x2', at: utc(2026, 7, 2), amount: 1000, note: 'extra' },
    ],
  }),
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
const subs = [
  cleanSub({ id: 's1', label: 'Netflix', amount: 12.99, currency: 'EUR', every: 'monthly', startsAt: utc(2024, 3, 5) }),
  cleanSub({ id: 's2', label: 'iCloud', amount: 90, currency: 'EUR', every: 'yearly', startsAt: utc(2025, 9, 20) }),
  cleanSub({ id: 's3', label: 'Gym', amount: 4500, currency: 'EGP', every: 'quarterly', startsAt: utc(2025, 1, 10) }),
  cleanSub({ id: 's4', label: 'Some AI thing', amount: 20, currency: 'USD', every: 'monthly', startsAt: utc(2026, 9, 1), trialEndsAt: utc(2026, 9, 20) }),
  cleanSub({ id: 's5', label: 'Old magazine', amount: 8, currency: 'EUR', every: 'monthly', startsAt: utc(2023, 1, 1), endsAt: utc(2026, 4, 1) }),
];
const goal = { monthly: 2000, currency: 'EUR' };
// The plan in his own words: "500 from salary, rent from apartment 1, deposit 10000 under 2%,
// and in year 3 I will add another apartment".
const events = {
  years: 10,
  useMeasured: true,
  list: [
    { id: 'e1', atYear: 1, kind: 'contribution', amount: 500, label: 'from salary' },
    { id: 'e2', atYear: 1, kind: 'income', amount: 450, label: 'rent from apartment 1' },
    { id: 'e3', atYear: 1, kind: 'lump', amount: 10000, ratePct: 2, label: 'deposit at 2%' },
    { id: 'e4', atYear: 3, kind: 'income', amount: 600, label: 'second rental' },
    { id: 'e5', atYear: 1, kind: 'spending', amount: 120, untilYear: 4, label: 'car insurance' },
  ],
};

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
  const S = buildState({ base: 'EUR', table: T, accounts, spanFlows, subs, goal, events, now: NOW });
  const el = render(S, 'this month');
  if (el) {
    // Mid-September: the Soon CD coupon has landed (1st), Loan 2's instalment has not (26th).
    // One of each, which is exactly the pair this feature has to keep apart.
    must(el, 'p-month', ['Repeats — not recorded yet', 'Yes, add it', 'Left over', 'September',
      'scheduled', 'Still due this month', 'After these, the month ends at'], 'this month');
    must(el, 'p-worth', ['Cairo CD', 'earned so far', 'quarterly', 'matured on', 'matures in', 'Not counted:',
      'and you spend EUR', 'of everything you own',
      // The flat and its rent, and the yield it works out to.
      'Cairo flat', '27,000 EGP', '12.0% a year'], 'this month');
    // A loan must never be described in the language of a deposit.
    const worth = el('p-worth').innerHTML;
    // lastIndexOf, not indexOf: the pay-this-first warnings name the same loans further up the
    // page, and slicing from the first mention picks up the banner instead of the row.
    const loanBlock = worth.slice(worth.lastIndexOf('Loan 1'), worth.lastIndexOf('Loan 2'));
    if (!loanBlock.includes('paid so far')) fail('a loan says "paid so far", never "earned"');
    if (loanBlock.includes('earned so far')) fail('a loan is showing money it "earned" — it is money he pays');
    if (!loanBlock.includes('still owed of the')) fail('a part-repaid loan must show what is left, not what was borrowed');
    if (!loanBlock.includes('% a year')) fail('a stated payment should reveal what the loan really costs');
    if (!el('p-worth').innerHTML.includes('Estimated —')) fail('a loan with no stated payment must say its figure is an estimate');
    if (!worth.includes('+ I paid extra')) fail('every loan needs a way to record an overpayment');
    if (!worth.includes('months early')) fail('overpaying has to say what it bought');
    if (!worth.includes('bonus')) fail('an extra payment is listed, with what it was');
  }
  {
    // The numbers behind that block.
    const l1 = S.accounts.find((a) => a.label === 'Loan 1');
    if (Math.round(l1.term.schedule.perPayment) !== 58063) fail(`the stated payment must win: got ${l1.term.schedule.perPayment}`);
    if (l1.term.schedule.made !== 7 || l1.term.schedule.total !== 10) fail('seven of ten payments made');
    if (Math.round(l1.term.implied.nominalPct * 10) / 10 !== 20.6) fail(`the real rate is 20.6%, got ${l1.term.implied.nominalPct}`);
    if (Math.round(l1.owedNow) !== 157664) fail(`157,664 EGP still owed, got ${Math.round(l1.owedNow)}`);
    if (l1.owedNow >= l1.value) fail('a loan seven payments through must owe less than it borrowed');
    // The card and the warning must agree about the same loan.
    const warned = S.payFirst.find((d) => d.label === 'Loan 1');
    if (Math.abs(warned.effectiveCostPct - l1.term.implied.nominalPct) > 0.01) {
      fail('the pay-this-first warning and the loan disagree about its rate');
    }
    // The overpaid euro loan: less owed than the schedule alone would say, and the consequence.
    const eur = S.accounts.find((a) => a.label === 'loan eur 1');
    const asScheduled = balanceNow({ ...eur, payments: [] }, NOW).amount;
    if (!(eur.owedNow < asScheduled)) fail('1,500 paid on top has to reduce what is owed');
    if (Math.round(asScheduled - eur.owedNow) < 1400) fail('and by roughly what he paid, plus the interest it saved');
    if (eur.extraCount !== 2) fail('both extra payments should be counted');
    if (!(eur.monthsEarly > 0)) fail('overpaying clears a loan earlier, and that is the point of doing it');
    if (eur.paymentsLeft >= 52) fail('fewer instalments remain than the schedule alone would leave');

    const egp = S.interest.foreign.find((f) => f.currency === 'EGP');
    if (!egp || !(egp.breakEvenFallPct > 0)) fail('foreign interest must say how far the currency can fall');

    // The flat: rent in, a yield worked out, and none of it treated as interest.
    const flat = S.accounts.find((a) => a.label === 'Cairo flat');
    if (!flat.term) fail('a flat that pays rent must produce something — this is what he could not add');
    if (Math.round(flat.term.perYear) !== 324000) fail(`27,000 a month is 324,000 a year, got ${flat.term.perYear}`);
    if (Math.abs(flat.term.yieldPct - 12) > 0.01) fail(`324,000 on 2,700,000 is a 12% yield, got ${flat.term.yieldPct}`);
    // Rent is not interest. The two live certificates pay 99,000 + 9,000 EGP = 2,000 EUR a year;
    // if the flat's 324,000 EGP of rent leaked in, this would read 8,000.
    if (Math.round(S.interest.earned) !== 2000) fail(`interest is the deposits alone (2,000), got ${Math.round(S.interest.earned)}`);
    if (!S.contracted.streams.some((r) => r.label === 'Cairo flat')) fail('rent is contracted income');
    const rent = S.flows.find((f) => f.scheduled && f.label === 'Cairo flat');
    if (!rent) fail('the rent should land in the month on its own');
    if (rent.category !== 'rent' || !rent.passive) fail('rent is rent, and it is passive — that is what the goal counts');
    const l2 = S.accounts.find((a) => a.label === 'Loan 2');
    if (!l2.term.schedule.estimated) fail('with no stated payment the figure is an estimate and must say so');
    if (Math.round(l2.term.schedule.perPayment) <= Math.round(513000 * 0.28 / 12)) {
      fail('an estimated loan payment must include principal, not interest only');
    }
    must(el, 'p-goal', ['Already contracted', 'a month is scheduled'], 'this month');
    must(el, 'p-plan', ['Year by year', 'second rental', 'Where it comes from', 'What goes in',
      'from salary', 'rent from apartment 1', 'grows at 2%', 'What you actually saved this month',
      'at your own 2%'], 'this month');
    must(el, 'p-subs', ['Every subscription, per year', 'What that costs in capital', 'Netflix',
      'free trial', 'Old magazine'], 'this month');
  }
  if (S.months.length !== 12) fail('the strip should hold twelve months');
  if (S.monthKey !== '2026-09') fail('it should open on the month he is in');
  if (!S.missing.some((r) => r.category === 'rent')) fail('the Cairo rent repeats and was not recorded — it should be listed');
  if (S.missing.some((r) => r.category === 'salary')) fail('the salary WAS recorded this month and must not be listed again');
  if (!S.terms.matured.some((t) => t.label === 'Old CD')) fail('a matured certificate should be surfaced');
  if (!S.interest.ended.includes('Old CD')) fail('a term that ended must not still count as earning');
  // 167 from the two live certificates, plus 500 of rent from the flat.
  if (Math.round(S.contracted.perMonth) !== 667) fail(`contracted income should be 667/month, got ${Math.round(S.contracted.perMonth)}`);

  // Subscriptions, normalised. 12.99 monthly = 155.88; 90 yearly = 90; 4,500 EGP quarterly =
  // 18,000 EGP = 333.33; 20 USD monthly = 240 USD = 222.22. The cancelled one counts nothing.
  const sub = S.subs;
  if (sub.count !== 4) fail(`four live subscriptions, got ${sub.count}`);
  if (Math.round(sub.perYear) !== 801) fail(`801 a year across the four, got ${Math.round(sub.perYear)}`);
  if (!sub.ended.some((r) => r.label === 'Old magazine')) fail('a cancelled subscription is kept, not deleted');
  if (!sub.trials.some((r) => r.label === 'Some AI thing')) fail('a free trial should be flagged before it starts charging');
  if (sub.capitalNeeded.length !== 2) fail('the capital cost is a range, never one number');
  if (Math.round(sub.capitalNeeded[0].capital) !== Math.round(sub.perYear / 0.035)) fail('capital at the low yield');
  // The biggest one first, so the thing worth cancelling is the thing he sees.
  const live = sub.rows.filter((r) => !r.ended);
  if (live[0].label !== 'Gym') fail(`the most expensive should lead, got ${live[0].label}`);
  if (sub.rows[sub.rows.length - 1].label !== 'Old magazine') fail('a cancelled one sinks to the bottom');
}

// ---- A month he scrolled back to ----
{
  const S = buildState({ base: 'EUR', table: T, monthKey: '2026-08', accounts, spanFlows, subs, goal, events, now: NOW });
  const el = render(S, 'a past month');
  if (el) must(el, 'p-month', ['August', 'salary'], 'a past month');
  if (S.monthKey !== '2026-08') fail('the month asked for is the month shown');
  // 3,200 EUR salary + 27,000 EGP rent = 3,700, PLUS the two deposit coupons that actually paid
  // in August: 24,750 EGP from the Cairo certificate on the 28th and 750 EGP from Soon CD on the
  // 1st — 472.22 EUR. A month that leaves those out is not a picture of the month.
  // 3,700 typed plus 472 of coupons. NOT 5,172: he types the Cairo rent by hand every month, and
  // the flat now produces its own — the near-match guard is the only thing keeping that at one.
  if (Math.round(S.month.income) !== 4172) fail(`August: 3,700 typed plus 472 of coupons = 4,172, got ${S.month.income}`);
  if (S.flows.filter((f) => f.dir === 'in' && Math.round(f.amount) === 27000).length !== 1) {
    fail('the Cairo rent appears twice — once typed, once projected');
  }
  if (!S.flows.some((f) => f.scheduled && f.label === 'Cairo CD')) fail('the coupon should appear in the list, marked scheduled');
  if (S.month.passive < 400) fail('a deposit coupon is passive income and must count towards the goal');
}
{
  // The two halves of the rule, on one month: what has passed is counted, what is ahead is not.
  const S = buildState({ base: 'EUR', table: T, accounts, spanFlows, subs, goal, events, now: NOW });
  const landed = S.flows.filter((f) => f.scheduled);
  if (!landed.length) fail('the coupon that paid on 1 September should be in the month');
  if (landed.some((f) => f.ts > NOW)) fail('nothing dated after today may be counted as having happened');
  if (!S.upcoming.rows.length) fail("Loan 2's instalment on the 26th is still ahead and should be listed");
  if (S.upcoming.rows.some((f) => f.ts <= NOW)) fail('something already paid is not "still due"');
  if (Math.round(S.upcoming.surplusAfter) >= Math.round(S.month.surplus)) {
    fail('an instalment still to come has to leave the month ending lower');
  }
  // The plan must not be rebuilt from whichever month he happens to be reading.
  const now = buildState({ base: 'EUR', table: T, accounts, spanFlows, subs, goal, events, now: NOW });
  if (S.forecast.mid.endCapital !== now.forecast.mid.endCapital) fail('reading August rewrote the ten-year plan');
}
{
  // The plan is built from named pieces, each at its own rate.
  const S = buildState({ base: 'EUR', table: T, accounts, spanFlows, subs, goal, events, now: NOW });
  const mid = S.forecast.mid;
  if (!mid.ownRate.length) fail('the 2% deposit must grow at 2%, not at the market yield');
  if (Math.round(mid.ownRate[0].ratePct) !== 2) fail('and be reported at the rate it was given');
  // 10,000 at 2% for ten years is ~12,190. At the 5% middle case it would be ~16,289 — the gap
  // is the whole reason a plan cannot compound every kind of money at one rate.
  if (Math.round(mid.ownRate[0].capital) !== 12190) fail(`10,000 at 2% for ten years is 12,190, got ${Math.round(mid.ownRate[0].capital)}`);

  // A cost that ends stops costing. Without untilYear every line runs for ever.
  const ends = mid.rows.find((r) => r.ends.length);
  if (!ends || ends.year !== 4) fail('the car insurance ends in year 4 and the plan should say so');
  if (mid.rows[4].monthlyContribution <= mid.rows[3].monthlyContribution) {
    fail('once a cost ends, more is going in');
  }

  // Switching the measured surplus off leaves only what he listed.
  const listed = buildState({ base: 'EUR', table: T, accounts, spanFlows, subs, goal,
    events: { ...events, useMeasured: false }, now: NOW });
  if (listed.planBase !== 0) fail('with measured off, the plan starts from what he listed and nothing else');
  if (listed.forecast.mid.endCapital >= S.forecast.mid.endCapital) fail('and it must come out lower');
}

// ---- A month he typed nothing into still knows what his holdings did ----
{
  const S = buildState({ base: 'EUR', table: T, monthKey: '2026-02', accounts, spanFlows, subs, goal, events, now: NOW });
  const el = render(S, 'a month he typed nothing into');
  if (el) must(el, 'p-month', ['scheduled', 'Loan 1'], 'a month he typed nothing into');
  if (!S.flows.length) fail('February had a coupon and two instalments — it is not empty');
  if (S.flows.some((f) => !f.scheduled)) fail('nothing was typed into February');
  if (!(S.principalRepaid > 0)) fail('part of a loan instalment buys back debt and must be named');
}

// ---- Nothing scheduled at all: no projections, no upcoming block ----
{
  const plain = [cleanAccount({ id: 'c1', label: 'Bank', kind: 'cash', currency: 'EUR', value: 5000 })];
  const S = buildState({ base: 'EUR', table: T, accounts: plain, spanFlows, subs: [], goal, events, now: NOW });
  const el = render(S, 'nothing scheduled');
  if (el) must(el, 'p-month', ['Left over'], 'nothing scheduled');
  if (S.flows.some((f) => f.scheduled)) fail('a cash account has no schedule to project');
  if (S.upcoming.rows.length) fail('and nothing is due');
  if (S.principalRepaid !== 0) fail('no debt, nothing repaid');
}

// ---- A payment recorded by hand REPLACES its projection ----
{
  // Same certificate, same day, entered manually with its schedule id: the month must count it
  // once. Double-counting a coupon is worse than never showing it.
  const w = { from: utc(2026, 8, 1), to: utc(2026, 9, 1) - 1 };
  const before = buildState({ base: 'EUR', table: T, monthKey: '2026-08', accounts, spanFlows, subs, goal, events, now: NOW });
  const byHand = cleanFlow({
    id: 'fx1', dir: 'in', category: 'interest', amount: 24750, currency: 'EGP',
    ts: utc(2026, 8, 28), passive: true, schedId: 'a2:2026-08-28',
  });
  const after = buildState({ base: 'EUR', table: T, monthKey: '2026-08', accounts, spanFlows: [...spanFlows, byHand], subs, goal, events, now: NOW });
  if (Math.round(after.month.income) !== Math.round(before.month.income)) {
    fail(`recording a scheduled coupon must replace the projection, not add to it: ${before.month.income} -> ${after.month.income}`);
  }
  if (after.flows.filter((f) => f.ts === utc(2026, 8, 28) && f.dir === 'in').length !== 1) {
    fail('the coupon appears twice in the month list');
  }
  if (after.flows.find((f) => f.id === 'fx1')?.scheduled) fail('once recorded it is a real flow, not a projection');
  if (w.from > w.to) fail('unreachable');
}

// ---- No exchange rates: nothing is totalled, and the page says so ----
{
  const S = buildState({ base: 'EUR', table: null, accounts, spanFlows, subs, goal, events, now: NOW });
  const el = render(S, 'no rates');
  if (el) must(el, 'p-month', ['Exchange rates are unreachable'], 'no rates');
  if (S.ratesAvailable !== false) fail('with no rate table nothing may claim to be converted');
}

// ---- Nothing entered at all: the first thing he ever sees ----
{
  const S = buildState({ base: 'EUR', table: T, accounts: [], spanFlows: [], subs: [], goal: null, events: { years: 10, list: [] }, now: NOW });
  const el = render(S, 'a brand new Pocket');
  if (el) {
    must(el, 'p-month', ['Nothing recorded in'], 'a brand new Pocket');
    must(el, 'p-worth', ['Nothing yet. Tap Add.'], 'a brand new Pocket');
    must(el, 'p-goal', ['No goal set'], 'a brand new Pocket');
    must(el, 'p-subs', ['Nothing yet'], 'a brand new Pocket');
  }
}

if (!process.exitCode) console.log('pocket-render: all five states drew, every expected element present');
