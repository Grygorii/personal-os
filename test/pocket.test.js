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
  assert.deepEqual(dep, { type: 'account', kind: 'deposit', value: 540000, currency: 'EGP', ratePct: null, label: 'Cairo savings' });
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
