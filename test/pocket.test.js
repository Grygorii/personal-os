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
    ratePct: null, startsAt: null, endsAt: null, payout: null, payment: null, label: 'Cairo savings',
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
  monthKey, monthWindowOf, recentMonths, monthsSummary, patchFrom, missingRecurring,
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

// ---- A loan is repaid; a deposit is not ----
//
// The app showed his car loan as costing 26,700 EGP a quarter — 445,000 × 24% ÷ 4, interest and
// nothing else. He actually pays 58,063.45, because every instalment also repays principal. It
// then went on subtracting the full 445,000 from his net worth while he was seven payments of
// ten through clearing it, so paying it down looked like nothing happening at all.

import { impliedRate, balanceNow, breakEvenFall, contractedIncome } from '../src/pocket/money.js';

const LOAN1 = () => cleanAccount({
  label: 'Loan 1', kind: 'loan', currency: 'EGP', value: 445000, ratePct: 24,
  payout: 'quarterly', payment: 58063.45, startsAt: utc(2024, 11, 28), endsAt: utc(2027, 5, 28),
});
const SEPT = utc(2026, 9, 15);

test('the payment he typed off his statement beats every calculation here', () => {
  const t = depositProgress(LOAN1(), SEPT);
  assert.equal(t.schedule.perPayment, 58063.45);
  assert.equal(t.schedule.stated, true);
  assert.equal(t.schedule.estimated, false);
  assert.equal(t.schedule.made, 7);
  assert.equal(t.schedule.total, 10);
  assert.equal(Math.round(t.schedule.totalOverTerm), 580635);
  assert.equal(Math.round(t.schedule.leftToPay), 174190);
  assert.equal(t.liability, true);
});

test('a loan with no stated payment repays principal too — never interest only', () => {
  const a = cleanAccount({ ...LOAN1(), payment: null });
  const t = depositProgress(a, SEPT);
  // The wrong answer was 26,700: 445,000 × 24% ÷ 4, which is about half his real bill.
  assert.notEqual(Math.round(t.schedule.perPayment), 26700);
  assert.equal(Math.round(t.schedule.perPayment), 60461, 'the amortising payment');
  assert.equal(t.schedule.estimated, true, 'and it says it is an estimate, because it is one');

  // A DEPOSIT is the opposite case and must not change: the coupon really is interest only,
  // and the principal comes back at the end.
  const dep = cleanAccount({ kind: 'deposit', currency: 'EGP', value: 495000, ratePct: 20, payout: 'quarterly', startsAt: utc(2024, 5, 28), endsAt: utc(2027, 5, 28) });
  assert.equal(depositProgress(dep, SEPT).schedule.perPayment, 24750);
  assert.equal(depositProgress(dep, SEPT).schedule.estimated, false);
});

test('impliedRate: what the payments actually cost, whatever the paperwork says', () => {
  const r = impliedRate({ principal: 445000, payment: 58063.45, payments: 10, periodsPerYear: 4 });
  assert.ok(Math.abs(r.nominalPct - 20.62) < 0.05, `20.6% a year, not 24% — got ${r.nominalPct}`);
  assert.ok(r.effectivePct > r.nominalPct, 'compounding makes the effective rate the larger one');
  assert.equal(Math.round(r.totalPaid), 580635);
  assert.equal(Math.round(r.totalInterest), 135635);

  // Nothing to solve for, so nothing is claimed.
  assert.equal(impliedRate({ principal: 1000, payment: 100, payments: 10, periodsPerYear: 12 }), null, 'repaying exactly what was borrowed is a 0% loan, not a rate');
  assert.equal(impliedRate({ principal: 0, payment: 100, payments: 10, periodsPerYear: 12 }), null);
  assert.equal(impliedRate({ principal: 1000, payment: 0, payments: 10, periodsPerYear: 12 }), null);
});

test('balanceNow: a debt seven payments through is not a debt still owed in full', () => {
  const b = balanceNow(LOAN1(), SEPT);
  // The payoff: the three remaining instalments, discounted at the rate his own payments imply.
  assert.equal(Math.round(b.amount), 157664);
  assert.equal(b.entered, 445000);
  assert.equal(Math.round(b.repaid), 287336);
  assert.equal(b.paymentsLeft, 3);
  // It has to fall, every period, from the principal to nothing. A payoff schedule that does
  // not start at what was borrowed is discounting at a rate the loan does not have.
  let last = Infinity;
  for (const when of [utc(2024, 12, 1), utc(2025, 6, 1), utc(2025, 12, 1), utc(2026, 6, 1), utc(2027, 6, 1)]) {
    const x = balanceNow(LOAN1(), when).amount;
    assert.ok(x <= last, `the debt must never grow: ${x} after ${last}`);
    last = x;
  }
  assert.ok(b.amount < b.entered, 'seven instalments have to have moved something');
  // Never more than was borrowed. Inventing debt is the one direction this must not be wrong in.
  assert.ok(b.amount <= b.entered);

  // Before the first payment, the whole thing is still owed.
  assert.equal(Math.round(balanceNow(LOAN1(), utc(2024, 12, 1)).amount), 445000);
  // After the last, nothing is.
  const done = balanceNow(LOAN1(), utc(2028, 1, 1));
  assert.equal(done.amount, 0);
  assert.equal(done.settled, true);

  // Everything that is not an amortising liability keeps exactly the figure he typed.
  for (const a of [
    cleanAccount({ kind: 'cash', currency: 'EUR', value: 5000 }),
    cleanAccount({ kind: 'property', currency: 'EGP', value: 2700000 }),
    cleanAccount({ kind: 'deposit', currency: 'EGP', value: 495000, ratePct: 20, payout: 'quarterly', startsAt: utc(2024, 5, 28), endsAt: utc(2027, 5, 28) }),
    cleanAccount({ kind: 'card', currency: 'EUR', value: 1200, ratePct: 19 }),
  ]) {
    assert.equal(balanceNow(a, SEPT).amount, a.value, `${a.kind} keeps what he typed`);
  }
});

test('netWorth counts what is owed today, not what was borrowed', () => {
  const accounts = [
    cleanAccount({ label: 'Bank', kind: 'cash', currency: 'EUR', value: 10000 }),
    LOAN1(),
  ];
  const n = netWorth(accounts, T, 'EUR', SEPT);
  // 157,664 EGP at 54 to the euro is 2,920, not the 8,241 the full principal would have been.
  assert.equal(Math.round(n.debts), 2920);
  assert.equal(Math.round(n.total), 10000 - 2920);
  assert.notEqual(Math.round(n.debts), Math.round(445000 / 54), 'the opening balance is not the debt');
  // And the currency exposure has to follow the same number, or the two disagree on screen.
  const egp = n.byCurrency.find((c) => c.currency === 'EGP');
  assert.equal(Math.round(egp.raw), -157664);
});

test('interest is charged on what is still owed, at the rate the loan really carries', () => {
  const ip = interestPicture([LOAN1()], T, 'EUR', SEPT);
  // Two corrections in one number. On what is still OWED (157,664 EGP), not the 445,000
  // borrowed — and at the 20.6% his payments imply, not the 24% on the paperwork. Anything
  // else and this card charges the loan at one rate directly under a warning quoting another.
  assert.equal(Math.round(ip.paid), 602);
  assert.notEqual(Math.round(ip.paid), 1978, 'not a full year on the opening balance');
  assert.notEqual(Math.round(ip.paid), 701, 'and not at the headline rate either');
  assert.ok(Math.abs(ip.rows[0].effectiveRatePct - 20.62) < 0.05);

  // A deposit has no instalments to imply anything, so it keeps the rate it was given.
  const dep = cleanAccount({ kind: 'deposit', currency: 'EGP', value: 540000, ratePct: 20 });
  assert.equal(interestPicture([dep], T, 'EUR', SEPT).rows[0].effectiveRatePct, 20);
});

test('interestPicture: what a high foreign rate has to survive to be worth anything', () => {
  // His actual shape: everything earned in Egyptian pounds, every bill paid in euro.
  const accounts = [
    cleanAccount({ label: 'D1', kind: 'deposit', currency: 'EGP', value: 495000, ratePct: 20 }),
    cleanAccount({ label: 'D2', kind: 'deposit', currency: 'EGP', value: 120000, ratePct: 22.5 }),
    cleanAccount({ label: 'Bank', kind: 'cash', currency: 'EUR', value: 5000, ratePct: 2 }),
  ];
  const ip = interestPicture(accounts, T, 'EUR', SEPT);
  const egp = ip.foreign.find((f) => f.currency === 'EGP');

  // Weighted by money, not by count: 20% on 495,000 and 22.5% on 120,000 is 20.49% overall.
  assert.ok(Math.abs(egp.weightedRatePct - 20.49) < 0.02);
  // And the bar the pound has to clear. 20.49% nominal is wiped out by a 17.0% fall — the same
  // arithmetic as realReturn, solved for zero, needing no forecast and no rate history.
  assert.ok(Math.abs(egp.breakEvenFallPct - 17.0) < 0.1);
  assert.equal(ip.foreign.length, 1, 'the euro savings are not foreign to a euro household');

  assert.equal(breakEvenFall(20), 100 * (0.2 / 1.2));
  assert.ok(Math.abs(breakEvenFall(20) - 16.67) < 0.01);
  assert.equal(breakEvenFall(0), null);
  assert.equal(breakEvenFall(-5), null);

  // It has to agree with realReturn, or the app tells him two different stories about one
  // deposit: a fall of exactly the break-even leaves nothing.
  const at = realReturn({ nominalPct: 20, rateThen: 54, rateNow: 54 * 1.2 });
  assert.ok(Math.abs(at.realPct) < 1e-9, 'break-even means break-even');
});

test('debtVsInvesting compares the rate the payments imply, not the one on the paperwork', () => {
  const [d] = debtVsInvesting([LOAN1()], { expectedYieldPct: 7, now: SEPT });
  assert.equal(d.ratePct, 24, 'what the paperwork says is kept');
  assert.ok(Math.abs(d.impliedPct - 20.62) < 0.05, 'and what it really costs is worked out');
  assert.ok(Math.abs(d.effectiveCostPct - 20.62) < 0.05, 'the comparison uses the real one');
  assert.equal(d.payFirst, true, '20.6% guaranteed still beats 7% hoped for');
});

test('parseEntry: the instalment can be typed on the line', () => {
  const p = parseEntry('add loan 445000 EGP 24% quarterly pays 58063.45 start 28.11.2024 end 28.05.2027', 'EUR');
  assert.equal(p.payment, 58063.45);
  assert.equal(p.payout, 'quarterly');
  assert.equal(p.value, 445000);
  assert.equal(p.label, 'loan', 'nothing about the payment leaks into the name');
  assert.equal(parseEntry('add loan 1000 EUR 5%', 'EUR').payment, null);
  assert.equal(patchFrom('account', { payment: '58 063,45' }).payment, 58063.45);
  assert.equal(patchFrom('account', { payment: '' }).payment, null, 'and it can be cleared again');
  // "pays" with nothing usable after it is just a word.
  assert.match(parseEntry('add loan 1000 EUR pays the bank', 'EUR').label, /pays the bank/);
});

// ---- Subscriptions ----
//
// The only spending nobody decides to make twice. What matters about Netflix is not the €12.99
// that left last Tuesday, it is that €155.88 a year is committed until someone actively stops it
// — and that a bill which never ends has to be funded by capital that never ends.

import { cleanSub, subPerYear, nextCharge, subsSummary, BILLING_PERIODS } from '../src/pocket/money.js';

test('subPerYear: a yearly bill and a monthly one cannot be compared until both are annual', () => {
  assert.equal(subPerYear(cleanSub({ amount: 12.99, every: 'monthly' })), 155.88);
  assert.equal(subPerYear(cleanSub({ amount: 90, every: 'yearly' })), 90);
  assert.equal(subPerYear(cleanSub({ amount: 45, every: 'quarterly' })), 180);
  // 52, not 4 × 12. A week treated as a quarter of a month understates a weekly bill by 8% —
  // small enough to look right, and wrong every single time.
  assert.equal(subPerYear(cleanSub({ amount: 8, every: 'weekly' })), 416);
  assert.notEqual(subPerYear(cleanSub({ amount: 8, every: 'weekly' })), 8 * 4 * 12);
  assert.equal(subPerYear(cleanSub({ amount: 0, every: 'monthly' })), 0);
  assert.deepEqual(BILLING_PERIODS, ['weekly', 'monthly', 'quarterly', 'yearly']);
  assert.equal(cleanSub({ every: 'fortnightly' }).every, 'monthly', 'a period it does not know is not one');
});

test('nextCharge: the next time it actually takes money', () => {
  const s = cleanSub({ amount: 12.99, every: 'monthly', startsAt: utc(2024, 3, 5) });
  assert.equal(nextCharge(s, utc(2026, 9, 15)), utc(2026, 10, 5));
  assert.equal(nextCharge(s, utc(2026, 9, 4)), utc(2026, 9, 5), 'the day before is still this month');

  const y = cleanSub({ amount: 90, every: 'yearly', startsAt: utc(2025, 9, 20) });
  assert.equal(nextCharge(y, utc(2026, 9, 15)), utc(2026, 9, 20));

  const w = cleanSub({ amount: 8, every: 'weekly', startsAt: utc(2026, 9, 1) });
  assert.equal(nextCharge(w, utc(2026, 9, 15)), utc(2026, 9, 22));

  // A free trial is not a charge. Counting one as due puts money in the next-fortnight list
  // that nobody is going to take.
  const trial = cleanSub({ amount: 20, every: 'monthly', startsAt: utc(2026, 9, 1), trialEndsAt: utc(2026, 9, 20) });
  assert.equal(nextCharge(trial, utc(2026, 9, 15)), utc(2026, 9, 20), 'the first charge is the day it stops being free');

  // Cancelled: nothing more is ever taken.
  const gone = cleanSub({ amount: 8, every: 'monthly', startsAt: utc(2023, 1, 1), endsAt: utc(2026, 4, 1) });
  assert.equal(nextCharge(gone, utc(2026, 9, 15)), null);
  assert.equal(nextCharge(cleanSub({ amount: 0 }), utc(2026, 9, 15)), null);
});

test('subsSummary: the whole bill, normalised, and what it costs in capital', () => {
  const now = utc(2026, 9, 15);
  const subs = [
    cleanSub({ id: 's1', label: 'Netflix', amount: 12.99, currency: 'EUR', every: 'monthly', startsAt: utc(2024, 3, 5) }),
    cleanSub({ id: 's2', label: 'iCloud', amount: 90, currency: 'EUR', every: 'yearly', startsAt: utc(2025, 9, 20) }),
    cleanSub({ id: 's3', label: 'Gym', amount: 4500, currency: 'EGP', every: 'quarterly', startsAt: utc(2025, 1, 10) }),
    cleanSub({ id: 's5', label: 'Old magazine', amount: 8, currency: 'EUR', every: 'monthly', startsAt: utc(2023, 1, 1), endsAt: utc(2026, 4, 1) }),
  ];
  const s = subsSummary(subs, T, 'EUR', now);

  // 155.88 + 90 + (18,000 EGP ÷ 54 = 333.33). The cancelled one adds nothing.
  assert.equal(Math.round(s.perYear), 579);
  assert.equal(Math.round(s.perMonth), 48);
  assert.equal(s.count, 3, 'a cancelled subscription is not a bill');
  assert.equal(s.ended.length, 1);
  assert.equal(s.ended[0].label, 'Old magazine', 'but it is kept — cancelling should show as an act, not a row vanishing');

  // The most expensive first, because the thing worth cancelling is the thing he should see.
  assert.equal(s.rows[0].label, 'Gym');
  assert.equal(s.rows[s.rows.length - 1].label, 'Old magazine', 'and the dead one sinks');

  // A bill that never ends needs capital that never ends — as a range, never one number.
  assert.equal(s.capitalNeeded.length, 2);
  assert.equal(Math.round(s.capitalNeeded[0].capital), Math.round(s.perYear / 0.035));
  assert.equal(Math.round(s.capitalNeeded[1].capital), Math.round(s.perYear / 0.07));
  assert.ok(s.capitalNeeded[0].capital > 16000, '€48 a month is a five-figure capital commitment');
});

test('subsSummary: a subscription with no rate is excluded AND named, like everything else here', () => {
  const s = subsSummary([
    cleanSub({ label: 'Netflix', amount: 10, currency: 'EUR', every: 'monthly' }),
    cleanSub({ label: 'Mystery', amount: 999, currency: 'XYZ', every: 'monthly' }),
  ], T, 'EUR', utc(2026, 9, 15));
  assert.equal(s.perYear, 120, 'the unconvertible one is not silently added at 1:1');
  assert.deepEqual(s.unconverted, ['Mystery (XYZ)']);
});

test('parseEntry: a subscription is its own shape, and does not collide with a spend', () => {
  assert.deepEqual(parseEntry('sub 12.99 EUR monthly netflix', 'EUR'), {
    type: 'sub', amount: 12.99, currency: 'EUR', every: 'monthly', startsAt: null, endsAt: null, label: 'netflix',
  });
  assert.equal(parseEntry('sub 90 yearly icloud', 'EUR').every, 'yearly');
  assert.equal(parseEntry('sub 8 weekly coffee', 'EUR').every, 'weekly');
  assert.equal(parseEntry('sub 45 EGP kvartally gym', 'EUR').every, 'quarterly', 'his word for it');
  assert.equal(parseEntry('sub 12.99 netflix', 'EUR').every, 'monthly', 'monthly is the sane default');
  assert.equal(parseEntry('sub 45 EUR quarterly gym from 01.03.2025', 'EUR').startsAt, utc(2025, 3, 1));
  assert.equal(parseEntry('sub 12.99 EUR monthly netflix', 'EUR').label, 'netflix', 'the period does not stay in the name');

  // "out 40 monthly gym" is still a spend called "monthly gym" and must not become a
  // subscription — the two shapes have to stay apart or every gym bill becomes a commitment.
  const spend = parseEntry('out 40 monthly gym', 'EUR');
  assert.equal(spend.type, 'flow');
  assert.equal(spend.category, 'monthly');
});

test('patchFrom: editing a subscription, including cancelling one', () => {
  const p = patchFrom('sub', { label: 'Netflix', amount: '15,99', every: 'monthly', endsAt: '01.03.2027', junk: 'x' });
  assert.deepEqual(p, { label: 'Netflix', amount: 15.99, every: 'monthly', endsAt: utc(2027, 3, 1) });
  assert.equal(patchFrom('sub', { every: 'fortnightly' }).every, undefined, 'an unknown period is ignored, not stored');
  assert.equal(patchFrom('sub', { endsAt: '' }).endsAt, null, 'a cancellation can be undone');
  assert.equal('ratePct' in patchFrom('sub', { ratePct: 20 }), false, 'a subscription has no interest rate');
});

test('a subscription charge is tagged, and is not also flagged recurring', () => {
  // Both would put the same bill in two different "you have not entered this yet" lists.
  const charge = cleanFlow({ dir: 'out', category: 'subscriptions', amount: 12.99, currency: 'EUR', subId: 's1', ts: utc(2026, 9, 5) });
  assert.equal(charge.subId, 's1');
  assert.equal(charge.recurring, false);
  assert.equal(cleanFlow({ dir: 'out', amount: 1 }).subId, null);

  const w = { from: utc(2026, 9, 1), to: utc(2026, 10, 1) - 1 };
  const older = cleanFlow({ dir: 'out', category: 'subscriptions', amount: 12.99, currency: 'EUR', subId: 's1', ts: utc(2026, 8, 5) });
  assert.deepEqual(missingRecurring([older, charge], w), [], 'the Subs tab reminds him, not the Month tab');
});

// ---- Deposit coupons and loan instalments, inside the month ----
//
// A month that omitted 1,075 EUR of loan payments and a 419 EUR coupon was not a picture of the
// month. These are contractual and dated, which is what separates them from "salary probably
// arrives" — so they are projected in. Two rules keep that honest: only a date that has PASSED
// counts, and a recorded flow carrying the schedule id replaces the projection rather than
// adding to it.

import { scheduledFlows, paymentDates, matchRecorded } from '../src/pocket/money.js';

const DEP = () => cleanAccount({
  id: 'd1', label: 'Deposit 1', kind: 'deposit', currency: 'EGP', value: 495000, ratePct: 20,
  payout: 'quarterly', startsAt: utc(2024, 5, 28), endsAt: utc(2027, 5, 28),
});
const NOV = { from: utc(2026, 11, 1), to: utc(2026, 12, 1) - 1 };

test('paymentDates: only the dates inside the window, on the calendar', () => {
  assert.deepEqual(paymentDates(DEP(), NOV), [utc(2026, 11, 28)]);
  assert.deepEqual(paymentDates(DEP(), { from: utc(2026, 10, 1), to: utc(2026, 10, 31) }), [], 'a quarterly deposit does not pay every month');
  // Never past the end of the term.
  assert.deepEqual(paymentDates(DEP(), { from: utc(2027, 8, 1), to: utc(2027, 9, 1) }), []);
  assert.deepEqual(paymentDates(cleanAccount({ kind: 'cash', currency: 'EUR', value: 100 }), NOV), [], 'cash has no schedule');
});

test('scheduledFlows: the coupon comes in, the instalment goes out', () => {
  const accounts = [DEP(), LOAN1()];
  const rows = scheduledFlows(accounts, NOV, { now: utc(2026, 11, 30) });
  assert.equal(rows.length, 2);

  const coupon = rows.find((r) => r.accountId === 'd1');
  assert.equal(coupon.dir, 'in');
  assert.equal(coupon.amount, 24750);
  assert.equal(coupon.currency, 'EGP');
  assert.equal(coupon.passive, true, 'interest is passive income — it is what the goal measures');
  assert.equal(coupon.ts, utc(2026, 11, 28));
  assert.equal(coupon.schedId, 'd1:2026-11-28', 'a stable id, so it can be matched and replaced');

  const instalment = rows.find((r) => r.dir === 'out');
  assert.equal(Math.round(instalment.amount), 58063);
  assert.equal(instalment.passive, false);
  // A loan instalment is not all spending: part of it buys back his own debt.
  assert.ok(instalment.principalPart > instalment.interestPart, 'late in a loan, most of a payment is principal');
  assert.ok(Math.abs(instalment.interestPart + instalment.principalPart - instalment.amount) < 0.01);
});

test('scheduledFlows: what has passed happened; what is ahead has not', () => {
  const rows = scheduledFlows([DEP()], NOV, { now: utc(2026, 11, 10) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].due, false, 'the 28th has not arrived on the 10th');
  assert.equal(scheduledFlows([DEP()], NOV, { now: utc(2026, 11, 30) })[0].due, true);
});

test('scheduledFlows: a recorded payment replaces its projection, never doubles it', () => {
  const window = NOV, now = utc(2026, 11, 30);
  const plain = scheduledFlows([DEP()], window, { now });
  assert.equal(plain.length, 1);

  // The same coupon, entered by hand, carrying the schedule id.
  const recorded = new Set(['d1:2026-11-28']);
  assert.deepEqual(scheduledFlows([DEP()], window, { now, recorded }), [], 'the projection steps aside');

  // And the month totals agree either way. Counting a coupon twice is worse than never showing
  // it, because a wrong total is trusted and a missing one is noticed.
  const asFlow = cleanFlow({ dir: 'in', category: 'interest', amount: 24750, currency: 'EGP', ts: utc(2026, 11, 28), passive: true, schedId: 'd1:2026-11-28' });
  const viaProjection = monthOf(plain.filter((r) => r.due), T, 'EUR', window);
  const viaRecord = monthOf([asFlow], T, 'EUR', window);
  assert.equal(Math.round(viaProjection.income), Math.round(viaRecord.income));
  assert.equal(Math.round(viaProjection.passive), Math.round(viaRecord.passive));
  assert.equal(asFlow.schedId, 'd1:2026-11-28');
  assert.equal(cleanFlow({ dir: 'in', amount: 1 }).schedId, null);
});

test('scheduledFlows: nothing is invented for a holding with no schedule', () => {
  const accounts = [
    cleanAccount({ kind: 'cash', currency: 'EUR', value: 5000 }),
    cleanAccount({ kind: 'property', currency: 'EGP', value: 2700000 }),
    // A rate but no dates: there is no payment date to project.
    cleanAccount({ kind: 'deposit', currency: 'EGP', value: 100000, ratePct: 15 }),
    // A term that finished: nothing is paid after it ends.
    cleanAccount({ kind: 'deposit', currency: 'EGP', value: 100000, ratePct: 15, payout: 'monthly', startsAt: utc(2020, 1, 1), endsAt: utc(2021, 1, 1) }),
  ];
  assert.deepEqual(scheduledFlows(accounts, NOV, { now: utc(2026, 11, 30) }), []);
});

// ---- A plan you build, not one you are handed ----
//
// "I want to add some amount and say I will add another amount, could be something with a %, but
//  sometimes I will just add some money. 500 from salary, rent from apartment 1, deposit 10000
//  under 2%. In year 3 I will add another apartment."
//
// The old tab projected from a measured surplus he could not see, at one yield for every kind of
// money. A projection you cannot take apart is not a plan, it is a claim.

test('cleanEvent: a piece can carry its own rate and its own end', () => {
  const e = cleanEvent({ atYear: 1, kind: 'lump', amount: 10000, ratePct: 2, label: 'deposit' });
  assert.equal(e.ratePct, 2);
  assert.equal(e.untilYear, null, 'forever unless he says otherwise');
  assert.equal(cleanEvent({ ratePct: '' }).ratePct, null, 'empty means "whatever the market does"');
  assert.equal(cleanEvent({ ratePct: null }).ratePct, null);
  assert.equal(cleanEvent({ ratePct: 0 }).ratePct, 0, 'but nought percent is a real answer and is kept');
  // An end before the start is not an end.
  assert.equal(cleanEvent({ atYear: 5, untilYear: 2 }).untilYear, 5);
  assert.equal(cleanEvent({ atYear: 1, untilYear: 4 }).untilYear, 4);
});

test('forecast: money with its own rate grows at its own rate', () => {
  const opts = {
    startCapital: 0, monthlySurplus: 0, years: 10, yieldPct: 5,
    events: [{ atYear: 1, kind: 'lump', amount: 10000, ratePct: 2, label: 'deposit at 2%' }],
  };
  const f = forecast(opts);
  // 10,000 × 1.02^10 = 12,190. At the 5% the rest of the plan uses it would be 16,289 — and
  // that gap over one line is why a plan cannot compound every kind of money at one figure.
  assert.equal(Math.round(f.ownRate[0].capital), 12190);
  assert.equal(f.ownRate[0].ratePct, 2);
  assert.equal(Math.round(f.endCapital), 12190);

  const market = forecast({ ...opts, events: [{ atYear: 1, kind: 'lump', amount: 10000, label: 'lump' }] });
  assert.equal(Math.round(market.endCapital), Math.round(10000 * 1.05 ** 10));
  assert.equal(market.ownRate.length, 0, 'no stated rate, no separate bucket');
  assert.ok(market.endCapital > f.endCapital, '5% beats 2%, and the plan has to show which is which');

  // The passive income each produces follows its own rate too, or a plan half in deposits
  // reports itself as though all of it were in the market.
  assert.ok(Math.abs(f.endPassive - (f.endCapital * 0.02) / 12) < 0.01);
});

test('forecast: his actual sentence, priced', () => {
  const f = forecast({
    startCapital: 0, monthlySurplus: 0, years: 10, yieldPct: 5, goalMonthly: 2000,
    events: [
      { atYear: 1, kind: 'contribution', amount: 500, label: 'from salary' },
      { atYear: 1, kind: 'income', amount: 450, label: 'rent from apartment 1' },
      { atYear: 1, kind: 'lump', amount: 10000, ratePct: 2, label: 'deposit at 2%' },
      { atYear: 3, kind: 'income', amount: 600, label: 'second apartment' },
    ],
  });
  // Year 1: 950 a month in, plus the 10,000 deposit.
  assert.equal(f.rows[0].monthlyContribution, 950);
  assert.equal(Math.round(f.rows[0].contributedThisYear), 11400);
  // Year 3: the second apartment lands and 1,550 a month goes in.
  assert.equal(f.rows[2].monthlyContribution, 1550);
  assert.deepEqual(f.rows[2].events, ['second apartment']);
  // Rent counts towards the goal the moment it arrives — that is what makes it income and not
  // just a contribution.
  assert.ok(f.rows[0].passiveMonthly > 450);
  assert.ok(f.rows[2].passiveMonthly > 1050);
  assert.equal(Math.round(f.endCapital), 224332);
});

test('forecast: a line that ends, ends', () => {
  const f = forecast({
    monthlySurplus: 1000, years: 6, yieldPct: 5,
    events: [{ atYear: 1, kind: 'spending', amount: 200, untilYear: 3, label: 'car insurance' }],
  });
  assert.equal(f.rows[0].monthlyContribution, 800, 'the cost bites from year 1');
  assert.equal(f.rows[2].monthlyContribution, 800, 'and through year 3');
  assert.equal(f.rows[3].monthlyContribution, 1000, 'then stops');
  assert.deepEqual(f.rows[2].ends, ['car insurance']);
  // Without an end year it would run for ever, which is the old behaviour and still the default.
  const forever = forecast({
    monthlySurplus: 1000, years: 6, yieldPct: 5,
    events: [{ atYear: 1, kind: 'spending', amount: 200, label: 'car insurance' }],
  });
  assert.equal(forever.rows[5].monthlyContribution, 800);
});

test('forecast: an income that ends stops counting towards the goal', () => {
  const f = forecast({
    monthlySurplus: 0, years: 5, yieldPct: 5,
    events: [{ atYear: 1, kind: 'income', amount: 900, untilYear: 2, label: 'lodger' }],
  });
  const y2 = f.rows[1].passiveMonthly, y3 = f.rows[2].passiveMonthly;
  assert.ok(y2 > 900, 'while the lodger is there it is income');
  assert.ok(y3 < y2, 'when they leave it is not');
  assert.ok(y3 < 900);
});

// ---- A flat, and the rent it pays ----
//
// "I want to add apartment in worth with rent I am getting but cannot do it."
//
// He could not, because an account only produced anything if it had a RATE. A deposit is
// described by a percentage; a flat is not — he knows the rent is 27,000 EGP a month and not
// what fraction of the building's value that happens to be. So the income had nowhere to go and
// the flat sat in his net worth doing nothing.

const FLAT = () => cleanAccount({
  id: 'p1', label: 'Cairo apartment', kind: 'property', currency: 'EGP',
  value: 2700000, payout: 'monthly', payment: 27000, startsAt: utc(2023, 6, 1),
});

test('an asset can pay an amount instead of a rate', () => {
  const t = depositProgress(FLAT(), utc(2026, 9, 20));
  assert.ok(t, 'this returned null before, which is why the rent could not be entered');
  assert.equal(t.perYear, 324000, '27,000 a month is 324,000 a year');
  assert.equal(t.schedule.perPayment, 27000);
  assert.equal(t.schedule.payout, 'monthly');
  // And the number he never had: what the flat actually returns.
  assert.equal(t.yieldPct, 12, '324,000 on 2,700,000 is 12% — the same question a deposit rate answers');

  // A rate still wins where there is one; the yield is only derived when there is not.
  assert.equal(depositProgress(cleanAccount({ kind: 'deposit', currency: 'EGP', value: 100000, ratePct: 15 })).yieldPct, null);
  // And an asset with neither still produces nothing, rather than a zero pretending to be one.
  assert.equal(depositProgress(cleanAccount({ kind: 'property', currency: 'EGP', value: 2700000 })), null);
  assert.equal(depositProgress(cleanAccount({ kind: 'property', currency: 'EGP', value: 2700000, payment: 27000 })), null, 'an amount with no frequency is not an income');
});

test('a tenancy with no start date still pays, anchored to the day it was added', () => {
  const added = utc(2025, 1, 2);
  const a = cleanAccount({ id: 'p2', kind: 'property', currency: 'EGP', value: 1000000, payout: 'monthly', payment: 8000, at: added });
  const t = depositProgress(a, utc(2026, 9, 20));
  assert.ok(t.schedule, 'a tenancy he has had for years has no interesting beginning');
  assert.equal(t.schedule.start, added);
  assert.equal(new Date(t.schedule.next).getUTCDate(), 2, 'and it pays on the same day each month');
});

test('rent lands in the month as rent, and counts towards the goal', () => {
  const w = { from: utc(2026, 9, 1), to: utc(2026, 10, 1) - 1 };
  const [rent] = scheduledFlows([FLAT()], w, { now: utc(2026, 9, 20) });
  assert.equal(rent.dir, 'in');
  assert.equal(rent.amount, 27000);
  assert.equal(rent.category, 'rent', 'not "interest" — a month has to read as what happened');
  assert.equal(rent.passive, true, 'which is exactly what the 2,000 a month goal measures');

  // A portfolio pays dividends, a deposit pays interest. The word matters because the category
  // is what he reads in the list.
  const port = cleanAccount({ kind: 'portfolio', currency: 'USD', value: 10000, payout: 'quarterly', payment: 90, startsAt: utc(2024, 6, 1) });
  assert.equal(scheduledFlows([port], w, { now: utc(2026, 9, 20) })[0].category, 'dividend');
});

test('rent he types by hand is not counted twice', () => {
  // THE HAZARD THIS FEATURE CREATED. He has typed the Cairo rent every month for a year; those
  // flows carry no schedule id, so the exact-id guard cannot see them. The day the flat learned
  // to produce its own rent, every one of those months would have counted it twice.
  const w = { from: utc(2026, 9, 1), to: utc(2026, 10, 1) - 1 };
  const now = utc(2026, 9, 20);
  const byHand = cleanFlow({ dir: 'in', category: 'rent', amount: 27000, currency: 'EGP', ts: utc(2026, 9, 3), recurring: true });

  assert.equal(scheduledFlows([FLAT()], w, { now }).length, 1, 'without the hand-typed one, the flat pays');
  assert.deepEqual(scheduledFlows([FLAT()], w, { now, flows: [byHand] }), [], 'with it, the projection steps aside');

  // The match has to be tight, or it swallows genuinely separate money.
  const differentAmount = cleanFlow({ dir: 'in', category: 'rent', amount: 19000, currency: 'EGP', ts: utc(2026, 9, 3) });
  const differentMonth = cleanFlow({ dir: 'in', category: 'rent', amount: 27000, currency: 'EGP', ts: utc(2026, 9, 22) });
  const differentCurrency = cleanFlow({ dir: 'in', category: 'rent', amount: 27000, currency: 'EUR', ts: utc(2026, 9, 3) });
  const wrongWay = cleanFlow({ dir: 'out', category: 'rent', amount: 27000, currency: 'EGP', ts: utc(2026, 9, 3) });
  for (const [what, f] of [['amount', differentAmount], ['date', differentMonth], ['currency', differentCurrency], ['direction', wrongWay]]) {
    assert.equal(scheduledFlows([FLAT()], w, { now, flows: [f] }).length, 1, `a different ${what} is different money`);
  }
});

// ---- Extra payments ----
//
// "I want to fix euro loan as I paid some extra already and it is less than it now shows. I need
//  to be able to add extra payments when I want, and add past instalments so you count right."
//
// A balance derived only from dates says he owes what a borrower who never paid a penny extra
// would owe. He has. So a loan carries its own history of what he actually paid, and the balance
// is walked period by period over it rather than discounted from a schedule.

const EURLOAN = (payments = []) => cleanAccount({
  id: 'e1', label: 'loan eur 1', kind: 'loan', currency: 'EUR', value: 9500, ratePct: 7.43,
  payout: 'monthly', payment: 192, startsAt: utc(2025, 10, 11), endsAt: utc(2030, 2, 28), payments,
});
const TODAY = utc(2026, 9, 15);

test('the walked balance agrees with the discounted one when nothing extra was paid', () => {
  // Two ways of asking the same question, and they have to give the same answer or the change
  // that made overpayments possible quietly moved every loan in the app.
  const b = balanceNow(LOAN1(), SEPT);
  assert.equal(Math.round(b.amount), 157664);
  assert.equal(b.paymentsMade, 7);
  assert.equal(b.paymentsLeft, 3, 'three instalments left, not four — a float tail is not a payment');
  assert.equal(b.extra, 0);
  assert.equal(b.monthsEarly, 0, 'paying exactly the schedule finishes exactly on time');

  // Still exact at both ends.
  assert.equal(Math.round(balanceNow(LOAN1(), utc(2024, 12, 1)).amount), 445000);
  assert.equal(balanceNow(LOAN1(), utc(2028, 1, 1)).amount, 0);
});

test('an extra payment comes straight off what is owed', () => {
  const plain = balanceNow(EURLOAN(), TODAY);
  const paid = balanceNow(EURLOAN([
    { id: 'x1', at: utc(2026, 3, 15), amount: 500, note: 'bonus' },
    { id: 'x2', at: utc(2026, 7, 2), amount: 1000 },
  ]), TODAY);

  assert.equal(paid.extra, 1500);
  assert.equal(paid.extraCount, 2);
  assert.ok(paid.amount < plain.amount, 'this is the whole complaint: it showed more than he owes');
  // At least the 1,500 itself, and a little more for the interest it stopped accruing.
  assert.ok(plain.amount - paid.amount >= 1500);
  assert.equal(paid.paymentsMade, plain.paymentsMade, 'an overpayment is not an instalment');
});

test('overpaying buys months and interest, and the app says how many', () => {
  const paid = balanceNow(EURLOAN([{ id: 'x1', at: utc(2026, 3, 15), amount: 1500 }]), TODAY);
  assert.ok(paid.monthsEarly > 0, 'the number no lender puts on a statement');
  assert.ok(paid.paymentsLeft < balanceNow(EURLOAN(), TODAY).paymentsLeft);
  assert.ok(paid.interestSaved > 0);
  // Same principal either way, so every euro of difference in what he hands over is interest.
  assert.ok(paid.interestSaved < 1500, 'saving cannot exceed what he put in');
});

test('a payment dated in the future has not been made yet', () => {
  const later = balanceNow(EURLOAN([{ id: 'x1', at: utc(2027, 6, 1), amount: 1000 }]), TODAY);
  assert.equal(later.extra, 0, 'the app must not spend money he has not spent');
  assert.equal(Math.round(later.amount), Math.round(balanceNow(EURLOAN(), TODAY).amount));
});

test('overpaying a loan into the ground settles it and never goes below nothing', () => {
  const cleared = balanceNow(EURLOAN([{ id: 'x1', at: utc(2026, 3, 15), amount: 99999 }]), TODAY);
  assert.equal(cleared.amount, 0);
  assert.equal(cleared.settled, true);
  assert.ok(cleared.amount >= 0, 'a debt cannot go negative — that would be an asset');
  assert.ok(cleared.repaid <= 9500, 'and he cannot repay more than he borrowed, as far as the balance is concerned');
});

test('an extra payment on something with no schedule still reduces it', () => {
  // A credit card he has been paying down: no term, no instalment, but the money left.
  const card = cleanAccount({
    kind: 'card', currency: 'EUR', value: 1200, ratePct: 19,
    payments: [{ id: 'p1', at: utc(2026, 5, 1), amount: 300 }],
  });
  const b = balanceNow(card, TODAY);
  assert.equal(b.amount, 900);
  assert.equal(b.extra, 300);
});

test('cleanPayment: an extra payment is sanitised like everything else', () => {
  assert.equal(cleanAccount({ kind: 'loan', payments: [{ amount: -5 }] }).payments.length, 0, 'a negative payment is not a payment');
  assert.equal(cleanAccount({ kind: 'loan', payments: 'nonsense' }).payments.length, 0);
  const two = cleanAccount({ kind: 'loan', payments: [{ at: 2000, amount: 1 }, { at: 1000, amount: 2 }] }).payments;
  assert.equal(two[0].at, 1000, 'kept in date order, because the balance is walked through them');
  // And an asset never grows one.
  assert.equal(balanceNow(cleanAccount({ kind: 'property', currency: 'EGP', value: 100, payments: [{ at: 1, amount: 50 }] }), TODAY).amount, 100);
});

// ---- Where the passive income comes from ----
//
// One green bar says he is 15% of the way to 2,000 a month. It does not say whether that 15% is
// a flat he owns or a certificate that matures in 2027, and those are not the same progress.

test('monthOf: passive income is split by source, largest first', () => {
  const now = utc(2026, 9, 10);
  const flows = [
    cleanFlow({ dir: 'in', category: 'rent', amount: 18000, currency: 'EGP', ts: now }),      // 333.33
    cleanFlow({ dir: 'in', category: 'interest', amount: 24750, currency: 'EGP', ts: now }),  // 458.33
    cleanFlow({ dir: 'in', category: 'dividend', amount: 54, currency: 'USD', ts: now }),     // 50
    cleanFlow({ dir: 'in', category: 'salary', amount: 3200, currency: 'EUR', ts: now }),
  ];
  const m = monthOf(flows, T, 'EUR');
  const by = m.passiveByCategory;
  assert.deepEqual(by.map((x) => x.category), ['interest', 'rent', 'dividend']);
  assert.equal(Math.round(by[0].amount), 458);
  assert.equal(Math.round(by[1].amount), 333);
  assert.equal(by.find((x) => x.category === 'salary'), undefined, 'a salary is not passive');
  // The parts have to add up to the whole, or the bar and the number above it disagree.
  assert.ok(Math.abs(by.reduce((t, x) => t + x.amount, 0) - m.passive) < 1e-9);
});

test('monthOf: nothing passive is an empty split, not a phantom slice', () => {
  const m = monthOf([cleanFlow({ dir: 'in', category: 'salary', amount: 100, currency: 'EUR', ts: Date.now() })], T, 'EUR');
  assert.deepEqual(m.passiveByCategory, []);
  assert.equal(m.passive, 0);
});

test('contractedIncome: each stream says what kind of income it is, and whether it ends', () => {
  const now = utc(2026, 9, 15);
  const flat = cleanAccount({ label: 'Flat', kind: 'property', currency: 'EGP', value: 2700000, payout: 'monthly', payment: 18000, startsAt: utc(2023, 6, 1) });
  const cd = cleanAccount({ label: 'CD', kind: 'deposit', currency: 'EGP', value: 495000, ratePct: 20, payout: 'quarterly', startsAt: utc(2024, 5, 28), endsAt: utc(2027, 5, 28) });
  const c = contractedIncome([flat, cd], now);

  const rent = c.streams.find((r) => r.label === 'Flat');
  const interest = c.streams.find((r) => r.label === 'CD');
  assert.equal(rent.category, 'rent');
  assert.equal(interest.category, 'interest');
  // The distinction the whole thing exists for: one of these stops.
  assert.equal(rent.endsAt, null, 'a flat he owns keeps paying');
  assert.equal(interest.endsAt, utc(2027, 5, 28), 'a certificate hands the money back and stops');
});

// ---- His own words for his own money ----
//
// He calls the Cairo rent "Apt 1". The passive split keyed on that, found nothing it recognised,
// and painted the largest slice of his goal in the grey reserved for "something else" — while
// the app knew perfectly well, two cards further down, that the flat pays 27,000 EGP a month.

test('matchRecorded: a flow under his own name is matched to the holding it came from', () => {
  const flat = cleanAccount({
    id: 'p1', label: 'Cairo apartment', kind: 'property', currency: 'EGP',
    value: 2700000, payout: 'monthly', payment: 27000, startsAt: utc(2023, 6, 1),
  });
  const w = { from: utc(2026, 9, 1), to: utc(2026, 10, 1) - 1 };
  const now = utc(2026, 9, 20);
  const byHand = cleanFlow({ id: 'f1', dir: 'in', category: 'apt 1', amount: 27000, currency: 'EGP', ts: utc(2026, 9, 2), passive: true });

  const m = matchRecorded([flat], w, { now, flows: [byHand] });
  assert.equal(m.get('f1').source, 'rent');
  assert.equal(m.get('f1').accountId, 'p1');

  // It is the SAME rule that stops the rent being counted twice, so the two can never disagree
  // about which flow is which.
  assert.deepEqual(scheduledFlows([flat], w, { now, flows: [byHand] }), []);

  // And it is just as tight: different money stays different.
  for (const f of [
    cleanFlow({ id: 'x', dir: 'in', category: 'apt 1', amount: 19000, currency: 'EGP', ts: utc(2026, 9, 2) }),
    cleanFlow({ id: 'x', dir: 'in', category: 'apt 1', amount: 27000, currency: 'EGP', ts: utc(2026, 9, 25) }),
    cleanFlow({ id: 'x', dir: 'in', category: 'apt 1', amount: 27000, currency: 'EUR', ts: utc(2026, 9, 2) }),
    cleanFlow({ id: 'x', dir: 'out', category: 'apt 1', amount: 27000, currency: 'EGP', ts: utc(2026, 9, 2) }),
  ]) {
    assert.equal(matchRecorded([flat], w, { now, flows: [f] }).size, 0);
  }
  // A flow already tagged to a schedule or a subscription is not up for matching.
  assert.equal(matchRecorded([flat], w, { now, flows: [{ ...byHand, schedId: 'p1:2026-09-01' }] }).size, 0);
});

test('monthOf: the split follows the source, but the list keeps his name for it', () => {
  const now = utc(2026, 9, 10);
  const flows = [
    { ...cleanFlow({ dir: 'in', category: 'apt 1', amount: 27000, currency: 'EGP', ts: now, passive: true }), source: 'rent' },
    cleanFlow({ dir: 'in', category: 'interest', amount: 24750, currency: 'EGP', ts: now }),
  ];
  const m = monthOf(flows, T, 'EUR');
  const cats = m.passiveByCategory.map((x) => x.category);
  assert.ok(cats.includes('rent'), 'the slice is rent, so it wears the rent colour');
  assert.ok(!cats.includes('apt 1'), 'and does not also appear under his own name');
  // Without a source, his word stands — the app never invents a category it has not worked out.
  const unknown = monthOf([cleanFlow({ dir: 'in', category: 'apt 1', amount: 100, currency: 'EUR', ts: now, passive: true })], T, 'EUR');
  assert.deepEqual(unknown.passiveByCategory.map((x) => x.category), ['apt 1']);
});
