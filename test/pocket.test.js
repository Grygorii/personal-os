// Pocket's arithmetic. Pure — no database, no network, no model.
//
// This file answers "how much do I actually have" across three currencies. The cases below are
// the ones that would misstate a household's net worth, not the ones that are easy to write.
// The worst of them is silent: a missing rate treated as 1:1 values 1,200,000 EGP as 1,200,000
// EUR and reports a family as fifty times richer than it is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanAccount, cleanFlow, netWorth, monthOf, goalProgress, yearsToGoal, PASSIVE_KINDS,
} from '../src/pocket/money.js';
import { toBase, describeAmount, realReturn, cleanCurrency } from '../src/fx.js';

// 1 EUR = 1.08 USD = 54 EGP.
const T = { base: 'EUR', rates: { EUR: 1, USD: 1.08, EGP: 54 }, at: Date.now() };

test('toBase: converts, and refuses to guess', () => {
  assert.equal(toBase(108, 'USD', T), 100);
  assert.equal(toBase(54000, 'EGP', T), 1000);
  assert.equal(toBase(500, 'EUR', T), 500, 'the base converts to itself');
  // The failure that would misstate everything: no rate must never mean 1:1.
  assert.equal(toBase(1200000, 'XYZ', T), null);
  assert.equal(toBase(100, '', T), null);
  assert.equal(toBase('abc', 'USD', T), null);
  assert.equal(toBase(100, 'USD', null), null);
});

test('cleanAccount and cleanFlow: a currency is never optional or invented', () => {
  assert.equal(cleanAccount({ currency: 'egp', value: 100 }).currency, 'EGP');
  assert.equal(cleanAccount({ currency: 'not a code' }).currency, 'EUR', 'junk falls back to the base, not to nothing');
  assert.equal(cleanAccount({ value: -5 }).value, 0, 'a negative holding is not a holding');
  assert.equal(cleanCurrency('eur'), 'EUR');
  assert.equal(cleanCurrency('EURO'), '', 'three letters or nothing');

  // Direction lives in `dir`, never in the sign, so an amount is always a magnitude.
  assert.equal(cleanFlow({ dir: 'out', amount: -40 }).amount, 40);
  assert.equal(cleanFlow({ dir: 'nonsense' }).dir, 'in');
});

test('cleanFlow: rent and interest count as passive without being told', () => {
  assert.equal(cleanFlow({ dir: 'in', category: 'Rent', amount: 100 }).passive, true);
  assert.equal(cleanFlow({ dir: 'in', category: 'salary', amount: 100 }).passive, false);
  // But an explicit flag always wins — a category name is a label, passive is a decision.
  assert.equal(cleanFlow({ dir: 'in', category: 'rent', passive: false, amount: 1 }).passive, false);
  assert.deepEqual(PASSIVE_KINDS, ['rent', 'interest', 'dividend']);
});

test('netWorth: three currencies into one, with what could not be converted named', () => {
  const accounts = [
    cleanAccount({ label: 'Bank', kind: 'cash', currency: 'EUR', value: 5000 }),
    cleanAccount({ label: 'eToro', kind: 'portfolio', currency: 'USD', value: 1080 }),
    cleanAccount({ label: 'Cairo flat', kind: 'property', currency: 'EGP', value: 2700000 }),
    cleanAccount({ label: 'EGP deposit', kind: 'deposit', currency: 'EGP', value: 540000, ratePct: 20 }),
  ];
  const n = netWorth(accounts, T);
  assert.equal(n.total, 5000 + 1000 + 50000 + 10000);
  assert.deepEqual(n.unconverted, []);

  // The number that matters most for this household: how much sits in a currency he does not
  // spend. 60,000 of 66,000 is EGP.
  const egp = n.exposure.find((e) => e.currency === 'EGP');
  assert.ok(Math.abs(egp.pct - 90.9) < 0.2, 'over ninety percent of net worth is in EGP');
  assert.equal(n.exposure[0].currency, 'EGP', 'largest exposure first');
});

test('netWorth: an unconvertible holding is excluded AND named, never silently included', () => {
  const accounts = [
    cleanAccount({ label: 'Bank', currency: 'EUR', value: 5000 }),
    cleanAccount({ label: 'Cairo flat', kind: 'property', currency: 'XYZ', value: 2700000 }),
  ];
  const n = netWorth(accounts, T);
  assert.equal(n.total, 5000, 'the total is only what could be converted');
  assert.deepEqual(n.unconverted, ['Cairo flat (XYZ)']);
  assert.notEqual(n.total, 2705000, 'the raw figure must never be added as if it were euro');
});

test('monthOf: income, spending, surplus and the savings rate', () => {
  const now = Date.now();
  const flows = [
    cleanFlow({ dir: 'in', category: 'salary', amount: 3240, currency: 'EUR', ts: now }),
    cleanFlow({ dir: 'in', category: 'rent', amount: 27000, currency: 'EGP', ts: now }),   // 500 EUR
    cleanFlow({ dir: 'out', category: 'rent', amount: 1400, currency: 'EUR', ts: now }),
    cleanFlow({ dir: 'out', category: 'food', amount: 540, currency: 'EUR', ts: now }),
  ];
  const m = monthOf(flows, T);
  assert.equal(m.income, 3740);
  assert.equal(m.spending, 1940);
  assert.equal(m.surplus, 1800);
  assert.equal(m.passive, 500, 'the Cairo rent, and not the salary');
  assert.ok(Math.abs(m.savingsRatePct - 48.1) < 0.2);
  assert.equal(m.spendingByCategory[0].category, 'rent', 'largest outgoing first');
});

test('monthOf: the window is bounded by the caller, not guessed', () => {
  const now = Date.now();
  const flows = [
    cleanFlow({ dir: 'in', category: 'salary', amount: 100, currency: 'EUR', ts: now }),
    cleanFlow({ dir: 'in', category: 'salary', amount: 999, currency: 'EUR', ts: now - 90 * 86400000 }),
  ];
  assert.equal(monthOf(flows, T, 'EUR', { from: now - 86400000, to: now + 1 }).income, 100);
});

test('goalProgress: the gap, and nothing that looks like a promise', () => {
  const g = goalProgress(500, { monthly: 2000, currency: 'EUR' });
  assert.equal(g.pct, 25);
  assert.equal(g.gap, 1500);
  assert.equal(g.currency, 'EUR');
  assert.equal(goalProgress(500, { monthly: 0 }), null, 'no target means no progress bar');
  // There is deliberately no date on this object.
  assert.equal(g.eta, undefined);
});

test('yearsToGoal: a range across stated yields, never one confident number', () => {
  // 2,000/month is 24,000/year. At 3.5% that needs ~686k; at 7%, ~343k.
  const y = yearsToGoal({ invested: 1000, monthlyContribution: 1000, goalMonthly: 2000 });
  assert.equal(y.scenarios.length, 3);
  assert.ok(Math.abs(y.scenarios[0].capitalNeeded - 24000 / 0.035) < 1);
  assert.ok(y.fastest > 10, 'this is a two-decade goal, not a two-year one');
  assert.ok(y.slowest > y.fastest, 'a range, because the inputs do not support a point');
  assert.match(y.assumes, /no tax/);
  assert.match(y.assumes, /no inflation/);
});

test('yearsToGoal: already there is zero, and no contributions is unreachable — not a big number', () => {
  assert.equal(yearsToGoal({ invested: 1e9, monthlyContribution: 0, goalMonthly: 2000 }).fastest, 0);
  const stuck = yearsToGoal({ invested: 100, monthlyContribution: 0, goalMonthly: 2000 });
  assert.equal(stuck.fastest, null, 'saving nothing never arrives, and says so');
  assert.equal(yearsToGoal({ goalMonthly: 0 }), null);
});

test('realReturn: 20% in a currency that fell 25% is a loss in euro', () => {
  // 54 EGP per EUR at the start, 72 now — the pound fell.
  const r = realReturn({ nominalPct: 20, rateThen: 54, rateNow: 72 });
  assert.ok(r.realPct < 0, 'the headline rate did not cover the devaluation');
  assert.ok(Math.abs(r.realPct - (-10)) < 0.5);
  assert.ok(r.currencyMovePct < 0);

  // A stable currency leaves the nominal rate intact.
  const flat = realReturn({ nominalPct: 20, rateThen: 54, rateNow: 54 });
  assert.ok(Math.abs(flat.realPct - 20) < 1e-9);
  assert.equal(realReturn({ nominalPct: 20, rateThen: 0, rateNow: 54 }), null);
});

test('describeAmount: the original currency never disappears behind the conversion', () => {
  const s = describeAmount(540000, 'EGP', T);
  assert.match(s, /540,000 EGP/, 'seeing the local figure is what keeps a devaluation visible');
  assert.match(s, /10,000 EUR/);
  assert.match(describeAmount(100, 'XYZ', T), /no rate — not converted/);
  assert.equal(describeAmount(100, 'EUR', T), '100 EUR', 'no pointless self-conversion');
});

// ---- Reading what he typed ----
// This is the surface he touches a dozen times a week, and it had the worst bug in the app:
// "in 3200 salary" recorded 3,200 SAL, a currency with no rate, so the amount silently
// vanished from every total. A three-letter word is only a currency if it is actually one.

import { parseEntry } from '../src/pocket/money.js';
import { isKnownCurrency } from '../src/fx.js';

test('parseEntry: a word that starts with three letters is not a currency', () => {
  const salary = parseEntry('in 3200 salary', 'EUR');
  assert.equal(salary.currency, 'EUR', 'not SAL');
  assert.equal(salary.category, 'salary');
  assert.equal(salary.amount, 3200);

  for (const [line, cat] of [['out 40 food', 'food'], ['out 60 gas', 'gas'], ['out 15 cat litter', 'cat']]) {
    const p = parseEntry(line, 'EUR');
    assert.equal(p.currency, 'EUR', line);
    assert.equal(p.category, cat, line);
  }
});

test('parseEntry: a real currency IS taken as one', () => {
  const rent = parseEntry('in 27000 EGP rent', 'EUR');
  assert.equal(rent.currency, 'EGP');
  assert.equal(rent.category, 'rent');
  assert.equal(rent.amount, 27000);
  assert.equal(parseEntry('out 1400 EUR rent', 'EUR').currency, 'EUR');
  assert.equal(parseEntry('in 500 usd dividend', 'EUR').currency, 'USD', 'lower case too');
  assert.equal(isKnownCurrency('EGP'), true);
  assert.equal(isKnownCurrency('SAL'), false);
});

test('parseEntry: the ways a European writes a number', () => {
  assert.equal(parseEntry('out 12,50 coffee').amount, 12.5);
  assert.equal(parseEntry('out 1 200,50 flights').amount, 1200.5);
  assert.equal(parseEntry('out 1,200.50 flights').amount, 1200.5);
  assert.equal(parseEntry('out 2700000 EGP flat').amount, 2700000);
  // Direction lives in the word, so a typed minus never flips a spend into income.
  assert.equal(parseEntry('out -40 food').amount, 40);
});

test('parseEntry: accounts, and a kind it does not know', () => {
  const dep = parseEntry('add deposit 540000 EGP Cairo savings', 'EUR');
  assert.deepEqual(dep, {
    type: 'account', kind: 'deposit', value: 540000, currency: 'EGP',
    ratePct: null, startsAt: null, endsAt: null, payout: null, label: 'Cairo savings',
  });
  assert.equal(parseEntry('add portfolio 1000 USD eToro').label, 'eToro');
  // An unknown kind is reported so the reply can list the real ones, not silently filed as cash.
  assert.deepEqual(parseEntry('add gold 5 oz'), { type: 'account', badKind: 'gold' });
  // A label falls back to the kind rather than being empty.
  assert.equal(parseEntry('add cash 200').label, 'cash');
});

test('parseEntry: anything that is not an entry is null, not a guess', () => {
  for (const junk of ['', null, 'help', 'how much did I spend', 'in', 'out food', 'in abc salary']) {
    assert.equal(parseEntry(junk), null, JSON.stringify(junk));
  }
});

// ---- Credits and deposits, both with a rate ----
// A loan is money OWED. Without a liability kind it either vanishes from net worth or gets
// added to it, and either way the household reads its own position wrong.

import { interestPicture, debtVsInvesting, isLiability, ACCOUNT_KINDS } from '../src/pocket/money.js';

test('netWorth: a credit is subtracted, not added and not dropped', () => {
  const accounts = [
    cleanAccount({ label: 'Bank', kind: 'cash', currency: 'EUR', value: 5000 }),
    cleanAccount({ label: 'Cairo deposit', kind: 'deposit', currency: 'EGP', value: 540000, ratePct: 20 }),
    cleanAccount({ label: 'Car credit', kind: 'loan', currency: 'EGP', value: 216000, ratePct: 24 }),
  ];
  const n = netWorth(accounts, T);
  assert.equal(n.assets, 15000, '5,000 EUR + 10,000 EUR of EGP deposit');
  assert.equal(n.debts, 4000, '216,000 EGP');
  assert.equal(n.total, 11000, 'assets minus debts');
  assert.notEqual(n.total, 19000, 'a debt must never be added as though it were an asset');
  assert.equal(isLiability('loan'), true);
  assert.equal(isLiability('deposit'), false);
  assert.ok(ACCOUNT_KINDS.includes('loan'));
});

test('netWorth: currency exposure nets the debt against holdings in the same currency', () => {
  const accounts = [
    cleanAccount({ label: 'Bank', kind: 'cash', currency: 'EUR', value: 5000 }),
    cleanAccount({ label: 'Deposit', kind: 'deposit', currency: 'EGP', value: 540000 }),
    cleanAccount({ label: 'Credit', kind: 'loan', currency: 'EGP', value: 270000 }),
  ];
  const n = netWorth(accounts, T);
  // 10,000 of EGP assets less 5,000 of EGP debt is 5,000 net, against 5,000 EUR.
  const egp = n.exposure.find((e) => e.currency === 'EGP');
  assert.ok(Math.abs(egp.pct - 50) < 0.01, 'borrowing in a currency reduces exposure to it');
});

test('interestPicture: what is earned, what is paid, and the net', () => {
  const accounts = [
    cleanAccount({ label: 'Cairo deposit', kind: 'deposit', currency: 'EGP', value: 540000, ratePct: 20 }),
    cleanAccount({ label: 'Car credit', kind: 'loan', currency: 'EGP', value: 216000, ratePct: 25 }),
    cleanAccount({ label: 'Flat', kind: 'property', currency: 'EGP', value: 2700000 }),   // no rate
  ];
  const p = interestPicture(accounts, T);
  assert.equal(p.rows.length, 2, 'only things with a rate');
  assert.equal(p.earned, 2000, '20% of 10,000 EUR');
  assert.equal(p.paid, 1000, '25% of 4,000 EUR');
  assert.equal(p.net, 1000);
});

test('debtVsInvesting: a credit costing more than investing pays comes first', () => {
  const accounts = [
    cleanAccount({ label: 'Car credit', kind: 'loan', currency: 'EGP', value: 216000, ratePct: 24 }),
    cleanAccount({ label: 'Cheap loan', kind: 'loan', currency: 'EUR', value: 5000, ratePct: 2 }),
    cleanAccount({ label: 'Deposit', kind: 'deposit', currency: 'EGP', value: 540000, ratePct: 20 }),
  ];
  const d = debtVsInvesting(accounts, { expectedYieldPct: 7 });
  assert.equal(d.length, 2, 'only debts');
  assert.equal(d[0].label, 'Car credit', 'worst spread first');
  assert.equal(d[0].payFirst, true);
  assert.equal(d[0].edge, 17, '24% cost against 7% expected');
  // A loan cheaper than the expected return is not urgent, and must not be flagged as if it were.
  assert.equal(d[1].payFirst, false);
});

test('debtVsInvesting: a falling currency makes a foreign debt genuinely cheaper', () => {
  const accounts = [cleanAccount({ label: 'Cairo credit', kind: 'loan', currency: 'EGP', value: 216000, ratePct: 24 })];
  // The pound fell from 54 to 72 per euro: the debt shrank in euro terms.
  const d = debtVsInvesting(accounts, { expectedYieldPct: 7, rateThen: 54, rateNow: 72 });
  assert.ok(d[0].effectiveCostPct < 24, 'the headline rate overstates what it costs a euro household');
  assert.ok(d[0].effectiveCostPct < 0, 'a 24% rate against a 25% devaluation is cheap money');
  assert.equal(d[0].payFirst, false, 'and so it is not the thing to clear first');
});

test('parseEntry: a rate can sit anywhere, and is optional', () => {
  assert.equal(parseEntry('add deposit 540000 EGP 20% Cairo savings').ratePct, 20);
  assert.equal(parseEntry('add loan 200000 EGP at 24% car credit').ratePct, 24);
  assert.equal(parseEntry('add deposit 5000 EUR 2,5% bank').ratePct, 2.5);
  assert.equal(parseEntry('add property 2700000 EGP apartment').ratePct, null);
  // The rate and the connecting word never end up in the label.
  assert.equal(parseEntry('add loan 200000 EGP at 24% car credit').label, 'car credit');
});

// ---- The data layer these apps are allowed to use ----
//
// This is here because of a real deploy failure, and because a unit test could have caught it
// and did not exist. Pocket and the Steward were written against col(), which returns a
// per-user view whose every method calls uid() — and uid() throws when there is no user
// context, which single-user apps never establish. It connected, then died on the first
// createIndex; without that call it would have died later on the first save instead.
//
// Both are single-tenant with a database each, so rawCol() is correct AND has to stay correct.
import { readFileSync } from 'node:fs';

test('the single-user apps import rawCol, never the per-user col', () => {
  for (const file of [
    'src/pocket/store.js', 'src/pocket/index.js',
    'src/steward/store.js', 'src/steward/index.js',
  ]) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const importLine = src.split('\n').find((l) => l.includes("from '../db.js'"));
    assert.ok(importLine, `${file} should import from db.js`);
    assert.match(importLine, /rawCol/, `${file} must use rawCol — col() throws without a user context`);
    // `rawCol as col` legitimately contains the word "col", so remove the alias before
    // checking that the scoped export is not ALSO being imported on its own.
    const withoutAlias = importLine.replace(/rawCol\s+as\s+col/g, 'rawCol');
    assert.doesNotMatch(withoutAlias, /[{,]\s*col\s*[,}]/, `${file} must not import the scoped col`);
  }
});

test('the scoped col genuinely lacks what these apps need', async () => {
  // Not a style rule — the wrapper really does not expose createIndex, which is exactly how
  // this surfaced in production.
  const db = await import('../src/db.js');
  assert.equal(typeof db.rawCol, 'function');
  assert.equal(typeof db.col, 'function');
  // Both throw before a connection, so the shape is asserted from the module's own contract:
  // GLOBAL_COLLECTIONS pass through raw, everything else is wrapped.
  assert.throws(() => db.col('accounts'), /DB not connected/);
  assert.throws(() => db.rawCol('accounts'), /DB not connected/);
});

// ---- Ten years out ----
// Same arithmetic as the challenge document he was shown; the difference is entirely in the
// presentation. These pin the parts that keep it honest.

import { forecast, forecastRange, cleanEvent } from '../src/pocket/money.js';

test('forecast: flat years when nothing is said to change', () => {
  const f = forecast({ startCapital: 1000, monthlySurplus: 1000, years: 10, yieldPct: 5 });
  assert.equal(f.rows.length, 10);
  // Year one: 1,000 grown, plus twelve months of contributions.
  assert.equal(Math.round(f.rows[0].capital), Math.round(1000 * 1.05 + 12000));
  // Contributions are added AFTER growth, so December's money is not credited a full year.
  assert.ok(f.rows[0].capital < 13000 * 1.05, 'no full-year return on money that arrived late');
  for (const r of f.rows) assert.equal(r.monthlyContribution, 1000, 'nothing changes on its own');
  assert.ok(f.endCapital > f.rows[0].capital);
});

test('forecast: an event takes effect from its year, not before', () => {
  const f = forecast({
    startCapital: 0, monthlySurplus: 1000, years: 5, yieldPct: 5,
    events: [{ atYear: 3, kind: 'income', amount: 300, label: 'second rental' }],
  });
  assert.equal(f.rows[0].monthlyContribution, 1000);
  assert.equal(f.rows[1].monthlyContribution, 1000, 'year two is untouched');
  assert.equal(f.rows[2].monthlyContribution, 1300, 'and from year three it applies');
  assert.deepEqual(f.rows[2].events, ['second rental']);
  // Extra income counts toward passive from that year, on top of what the capital yields.
  assert.ok(f.rows[2].passiveMonthly > f.rows[1].passiveMonthly + 250);
});

test('forecast: a lump sum lands once, and spending reduces what is saved', () => {
  const lump = forecast({ startCapital: 0, monthlySurplus: 0, years: 3, yieldPct: 10,
    events: [{ atYear: 2, kind: 'lump', amount: 10000 }] });
  assert.equal(lump.rows[0].capital, 0);
  assert.equal(Math.round(lump.rows[1].capital), 11000, 'added at the start of year two, then grown');

  const spend = forecast({ startCapital: 0, monthlySurplus: 1000, years: 3, yieldPct: 0,
    events: [{ atYear: 2, kind: 'spending', amount: 400, label: 'childcare' }] });
  assert.equal(spend.rows[1].monthlyContribution, 600);
});

test('forecast: a contribution driven negative never becomes a withdrawal', () => {
  // Saving less than nothing is a real situation; silently draining capital to model it is not
  // what was asked for, and would produce a confident number nobody entered.
  const f = forecast({ startCapital: 5000, monthlySurplus: 200, years: 2, yieldPct: 0,
    events: [{ atYear: 1, kind: 'spending', amount: 900 }] });
  assert.equal(f.rows[0].monthlyContribution, -700, 'the shortfall is reported honestly');
  assert.equal(f.rows[0].contributedThisYear, 0, 'but nothing is added, and nothing is taken');
  assert.equal(f.rows[0].capital, 5000);
});

test('forecast: reports the year a goal is met, or that it is not', () => {
  const near = forecast({ startCapital: 500000, monthlySurplus: 0, years: 5, yieldPct: 5, goalMonthly: 2000 });
  assert.equal(near.goalReachedInYear, 1, '500k at 5% already pays over 2,000 a month');
  const far = forecast({ startCapital: 1000, monthlySurplus: 100, years: 5, yieldPct: 5, goalMonthly: 2000 });
  assert.equal(far.goalReachedInYear, null, 'and it says so rather than picking a year');
});

test('forecastRange: three yields, and the spread between them is the point', () => {
  const g = forecastRange({ startCapital: 1000, monthlySurplus: 1000, years: 10 });
  assert.equal(g.runs.length, 3);
  assert.equal(g.low.yieldPct, 3.5);
  assert.equal(g.high.yieldPct, 7);
  assert.ok(g.high.endCapital > g.low.endCapital);
  assert.ok(g.spreadAtEnd > 20000, 'over ten years the yield assumption is most of the answer');
  assert.match(g.assumes, /no tax/);
  assert.match(g.assumes, /no bad year/);
});

test('cleanEvent: years and kinds are bounded, never trusted', () => {
  assert.equal(cleanEvent({ atYear: 0 }).atYear, 1);
  assert.equal(cleanEvent({ atYear: 999 }).atYear, 60);
  assert.equal(cleanEvent({ atYear: 'x' }).atYear, 1);
  assert.equal(cleanEvent({ kind: 'nonsense' }).kind, 'contribution');
  assert.equal(cleanEvent({ kind: 'lump', amount: '5000' }).amount, 5000);
});

// ---- Dates, terms, and when the money actually moves ----
//
// He typed "add deposit 495000 EGP 20% start 28.05.2024 end 28.05.2027" and the dates landed in
// the LABEL. Worse than ugly: with no term, nothing could say what the certificate had already
// paid him, which is the only number he actually wanted from it.

import {
  parseDate, depositProgress, addMonths, yearsBetween, payoutSchedule, PAYOUT_KINDS,
  monthKey, monthWindowOf, recentMonths, monthsSummary, patchFrom,
} from '../src/pocket/money.js';

const utc = (y, m, d) => Date.UTC(y, m - 1, d);

test('parseDate: 28.05.2024 is 28 May, and junk is null rather than a guess', () => {
  assert.equal(parseDate('28.05.2024'), utc(2024, 5, 28), 'day first, the way he writes it');
  assert.equal(parseDate('28/05/2024'), utc(2024, 5, 28));
  assert.equal(parseDate('2024-05-28'), utc(2024, 5, 28), 'ISO is unambiguous and read as itself');
  assert.equal(parseDate('1.1.2025'), utc(2025, 1, 1), 'single digits too');
  // A misread date shifts every interest figure that hangs off it, so nothing is guessed.
  for (const junk of ['', null, 'May', '28.05', '2024', '32.01.2024', '01.13.2024', 'tomorrow']) {
    assert.equal(parseDate(junk), null, JSON.stringify(junk));
  }
});

test('parseEntry: the dates go in the date fields and OUT of the label', () => {
  const p = parseEntry('add deposit 495000 EGP 20% start 28.05.2024 end 28.05.2027', 'EUR');
  assert.equal(p.value, 495000);
  assert.equal(p.currency, 'EGP');
  assert.equal(p.ratePct, 20);
  assert.equal(p.startsAt, utc(2024, 5, 28));
  assert.equal(p.endsAt, utc(2027, 5, 28));
  // The bug this fixes: both keywords AND both dates used to survive into the name.
  assert.equal(p.label, 'deposit', 'no dates left in the name');

  // A keyword with nothing date-shaped after it is just a word, not a swallowed field.
  const q = parseEntry('add cash 500 EUR start of the month money', 'EUR');
  assert.equal(q.startsAt, null);
  assert.match(q.label, /start of the month/);
});

test('parseEntry: how often it pays, in his words, and only on accounts', () => {
  assert.equal(parseEntry('add deposit 495000 EGP 20% quarterly', 'EUR').payout, 'quarterly');
  assert.equal(parseEntry('add loan 200000 EGP 24% monthly car', 'EUR').payout, 'monthly');
  assert.equal(parseEntry('add loan 200000 EGP 24% monthly car', 'EUR').label, 'car');
  assert.equal(parseEntry('add deposit 100 EUR 5% kvartally', 'EUR').payout, 'quarterly', 'his word for it');
  assert.equal(parseEntry('add deposit 100 EUR 5%', 'EUR').payout, null, 'not said stays not said');

  // A SPEND may legitimately be called "monthly gym". Swallowing that word as a frequency would
  // silently rename the category, so the flow side never looks for one.
  const gym = parseEntry('out 40 monthly gym', 'EUR');
  assert.equal(gym.category, 'monthly');
  assert.equal(gym.note, 'monthly gym');
});

test('cleanAccount: a payout frequency it has never heard of is not one', () => {
  assert.equal(cleanAccount({ payout: 'quarterly' }).payout, 'quarterly');
  assert.equal(cleanAccount({ payout: 'weekly' }).payout, null);
  assert.equal(cleanAccount({}).payout, null);
  assert.deepEqual(PAYOUT_KINDS, ['monthly', 'quarterly', 'yearly', 'maturity']);
});

test('depositProgress: what 20% for three years has actually paid so far', () => {
  const a = cleanAccount({
    kind: 'deposit', currency: 'EGP', value: 495000, ratePct: 20,
    startsAt: utc(2024, 5, 28), endsAt: utc(2027, 5, 28),
  });
  const t = depositProgress(a, utc(2026, 9, 1));
  assert.equal(t.hasTerm, true);
  assert.equal(t.perYear, 99000);
  // Simple interest on the principal — that is how these certificates pay. Compounding would
  // overstate it, and overstating a return is the one direction this app must not be wrong in.
  assert.equal(Math.round(t.totalAtMaturity), 297000);
  assert.equal(Math.round(t.valueAtMaturity), 495000 + 297000);
  // Two years, three months and four days of a three-year term, measured on the calendar and
  // not in days ÷ 365 — see yearsBetween.
  assert.equal(Math.round(t.earned), 223815);
  assert.equal(Math.round(t.earned + t.remaining), 297000, 'earned and still-to-come are the whole term');
  assert.ok(t.pctThrough > 74 && t.pctThrough < 76);
  assert.equal(Math.round(t.remainingDays), 269);
  assert.equal(t.matured, false);
});

test('depositProgress: a matured deposit stops earning, and never runs past its end', () => {
  const a = cleanAccount({ kind: 'deposit', currency: 'EGP', value: 100000, ratePct: 10, startsAt: utc(2020, 1, 1), endsAt: utc(2021, 1, 1) });
  const t = depositProgress(a, utc(2026, 9, 1));
  assert.equal(t.matured, true);
  assert.equal(t.pctThrough, 100);
  assert.equal(Math.round(t.earned), 10000, 'exactly one year, and five extra years add nothing it never paid');
  assert.equal(t.remaining, 0);
});

test('depositProgress: no dates says only what can honestly be said, and no rate says nothing', () => {
  const noDates = depositProgress(cleanAccount({ kind: 'deposit', currency: 'EUR', value: 1000, ratePct: 4 }));
  assert.equal(noDates.hasTerm, false);
  assert.equal(noDates.perYear, 40);
  assert.equal(noDates.earned, undefined, 'without a start there is no "so far"');
  assert.equal(depositProgress(cleanAccount({ kind: 'cash', currency: 'EUR', value: 1000 })), null);
});

test('addMonths: calendar months, so 31 January plus one is the end of February', () => {
  assert.equal(addMonths(utc(2024, 1, 31), 1), utc(2024, 2, 29), 'a leap year');
  assert.equal(addMonths(utc(2025, 1, 31), 1), utc(2025, 2, 28));
  assert.equal(addMonths(utc(2024, 5, 28), 12), utc(2025, 5, 28));
  assert.equal(addMonths(utc(2024, 12, 15), 1), utc(2025, 1, 15), 'across a year boundary');
  // Days ÷ 30.44 put a one-year term at 11.99 months once. This is why it is calendar maths.
  assert.equal(addMonths(utc(2024, 5, 28), 36), utc(2027, 5, 28));
});

test('yearsBetween: a one-year term is one year, leap day or not', () => {
  // The bug this exists for: days ÷ 365 pays 10,027 on a round 10,000 one-year deposit opened
  // in a leap year. A number he would not believe, from arithmetic wrong on every leap term.
  assert.equal(yearsBetween(utc(2020, 1, 1), utc(2021, 1, 1)), 1, 'across 29 February');
  assert.equal(yearsBetween(utc(2021, 1, 1), utc(2022, 1, 1)), 1);
  assert.equal(yearsBetween(utc(2024, 5, 28), utc(2027, 5, 28)), 3);
  assert.equal(yearsBetween(utc(2024, 5, 28), utc(2024, 11, 28)), 0.5);
  assert.equal(yearsBetween(utc(2026, 9, 1), utc(2024, 5, 28)), 0, 'backwards is nothing, never negative');
});

test('payoutSchedule: a rate becomes an amount on a date', () => {
  const base = { start: utc(2024, 5, 28), end: utc(2027, 5, 28), perYear: 99000, totalAtMaturity: 297000 };
  const now = utc(2026, 9, 1);

  const q = payoutSchedule({ ...base, payout: 'quarterly' }, now);
  assert.equal(q.perPayment, 24750);
  assert.equal(q.every, 3);
  assert.equal(q.total, 12, 'three years, four times a year');
  assert.equal(q.made, 9);
  assert.equal(q.next, utc(2026, 11, 28));

  const m = payoutSchedule({ ...base, payout: 'monthly' }, now);
  assert.equal(m.perPayment, 8250);
  assert.equal(m.total, 36);
  assert.equal(m.made, 27);
  assert.equal(m.next, utc(2026, 9, 28));

  // "At maturity" is not a frequency: nothing lands until the last day.
  const mat = payoutSchedule({ ...base, payout: 'maturity' }, now);
  assert.equal(mat.perPayment, 297000);
  assert.equal(mat.total, 1);
  assert.equal(mat.made, 0);
  assert.equal(mat.next, base.end);

  // Nothing said, nothing invented — assuming monthly would promise twelve arrivals a year.
  assert.equal(payoutSchedule({ ...base, payout: null }, now), null);
});

test('depositProgress: the schedule rides along with the term', () => {
  const a = cleanAccount({
    kind: 'deposit', currency: 'EGP', value: 495000, ratePct: 20, payout: 'quarterly',
    startsAt: utc(2024, 5, 28), endsAt: utc(2027, 5, 28),
  });
  const t = depositProgress(a, utc(2026, 9, 1));
  assert.equal(t.payout, 'quarterly');
  assert.equal(t.schedule.perPayment, 24750);
  assert.equal(t.schedule.next, utc(2026, 11, 28));
  // Nine payments of 24,750 is 222,750 — close to the 224,174 accrued, because interest keeps
  // running between coupons. The two are different questions and both are shown.
  assert.equal(t.schedule.made * t.schedule.perPayment, 222750);
});

// ---- A year of months, not just this one ----

test('monthWindowOf: a key selects its month, and a bad key never selects everything', () => {
  const w = monthWindowOf('2026-08');
  assert.equal(w.key, '2026-08');
  assert.equal(w.from, utc(2026, 8, 1));
  assert.equal(w.to, utc(2026, 9, 1) - 1);
  assert.equal(monthKey(utc(2026, 8, 15)), '2026-08');

  // The failure that matters: junk must fall back to the current month, never to epoch zero,
  // which would total every flow ever recorded and call it "this month".
  const now = utc(2026, 9, 10);
  for (const junk of ['', null, 'august', '2026-13', '2026']) {
    assert.equal(monthWindowOf(junk, now).key, '2026-09', JSON.stringify(junk));
  }
});

test('recentMonths: twelve of them, oldest first, ending with the one he is in', () => {
  const r = recentMonths(12, utc(2026, 9, 10));
  assert.equal(r.length, 12);
  assert.equal(r[0].key, '2025-10');
  assert.equal(r[11].key, '2026-09');
});

test('monthsSummary: every month is returned, including the empty ones', () => {
  const flows = [
    cleanFlow({ dir: 'in', amount: 3000, currency: 'EUR', category: 'salary', ts: utc(2026, 8, 5) }),
    cleanFlow({ dir: 'out', amount: 1200, currency: 'EUR', category: 'rent', ts: utc(2026, 8, 6) }),
    cleanFlow({ dir: 'out', amount: 54000, currency: 'EGP', category: 'trip', ts: utc(2026, 9, 2) }),
  ];
  const s = monthsSummary(flows, T, 'EUR', { count: 3, now: utc(2026, 9, 10) });
  assert.deepEqual(s.map((m) => m.key), ['2026-07', '2026-08', '2026-09']);

  const july = s[0], august = s[1], september = s[2];
  // A month dropped from the strip reads as a month that did not happen. It is kept, at zero.
  assert.equal(july.entries, 0);
  assert.equal(july.surplus, 0);
  assert.equal(august.income, 3000);
  assert.equal(august.spending, 1200);
  assert.equal(august.surplus, 1800);
  assert.equal(september.spending, 1000, 'the Egyptian spend is converted, not passed through');
});

// ---- Correcting something already recorded ----

test('patchFrom: only fields it knows, and an absent one is not a deletion', () => {
  const p = patchFrom('flow', { category: 'groceries', amount: '42,50', dir: 'out', nonsense: 'x', id: 'other' });
  assert.deepEqual(p, { category: 'groceries', amount: 42.5, dir: 'out' });
  // The id is never patchable — an edit that could rewrite an id is an overwrite of another row.
  assert.equal('id' in p, false);
  assert.deepEqual(patchFrom('flow', {}), {}, 'nothing said, nothing changed');

  // false has to survive: the string "no" is truthy, and a passive flag set from it would count
  // a salary towards the passive-income goal.
  assert.equal(patchFrom('flow', { passive: false }).passive, false);
  assert.equal(patchFrom('flow', { recurring: true }).recurring, true);
  assert.equal(patchFrom('flow', { date: '28.05.2024' }).ts, utc(2024, 5, 28));
  assert.equal('ts' in patchFrom('flow', { date: 'rubbish' }), false, 'a date it cannot read changes nothing');
});

test('patchFrom: an account, including clearing a rate back to nothing', () => {
  const p = patchFrom('account', { label: 'Cairo CD', value: '495 000', currency: 'EGP', kind: 'deposit', payout: 'quarterly', startsAt: '28.05.2024', endsAt: '' });
  assert.deepEqual(p, {
    label: 'Cairo CD', value: 495000, currency: 'EGP', kind: 'deposit',
    payout: 'quarterly', startsAt: utc(2024, 5, 28), endsAt: null,
  });
  assert.equal(patchFrom('account', { ratePct: '' }).ratePct, null, 'a rate can be cleared, not only set');
  assert.equal(patchFrom('account', { ratePct: '4,5' }).ratePct, 4.5);
  assert.equal(patchFrom('account', { kind: 'gold' }).kind, undefined, 'an unknown kind is ignored, not filed as cash');
  assert.equal(patchFrom('account', { payout: 'weekly' }).payout, null);
});

test('an edit merges over what is stored — it never applies the whitelist to a fragment', () => {
  // This is what store.updateFlow does. The order matters: merge first, THEN sanitise. Cleaning
  // the patch alone and $set-ing it would drop every field the patch did not mention, which is
  // exactly how `saveBooks` once deleted a quiz.
  const stored = cleanFlow({ dir: 'out', amount: 40, currency: 'EGP', category: 'food', ts: utc(2026, 8, 3), note: 'market', id: 'abc' });
  const merged = cleanFlow({ ...stored, ...patchFrom('flow', { amount: '45' }), id: stored.id });
  assert.equal(merged.amount, 45);
  assert.equal(merged.currency, 'EGP', 'the currency survived an edit that never mentioned it');
  assert.equal(merged.category, 'food');
  assert.equal(merged.note, 'market');
  assert.equal(merged.ts, utc(2026, 8, 3), 'the date it happened is not moved to today');
  assert.equal(merged.id, 'abc', 'the id is taken from what is stored, never from the patch');
});
