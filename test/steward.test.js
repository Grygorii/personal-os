// The steward's arithmetic. Pure functions, no database, no network, no model.
//
// These matter more than the usual test file: this code decides what he thinks he owns and
// what he thinks it is worth. A wrong number here does not produce a bad screen, it produces
// a bad trade — so the cases below are the ones that would cost money, not the ones that are
// easy to write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPosition, positionMath, valuePosition, summarise, checkRules,
  stale, brokenButHeld, parseTradeLine, incomeOf, dividendFlags, DEFAULT_RULES,
} from '../src/steward/book.js';
import { cleanTicker, priceFacts } from '../src/steward/market.js';

const P = (over = {}) => cleanPosition({ ticker: 'MSTR', entries: [{ qty: 10, price: 400 }], ...over });

test('positionMath: average cost across several buys, and what is left after selling', () => {
  const p = P({ entries: [{ qty: 10, price: 400 }, { qty: 10, price: 300 }], exits: [{ qty: 5, price: 500 }] });
  const m = positionMath(p);
  assert.equal(m.bought, 20);
  assert.equal(m.avgCost, 350);
  assert.equal(m.qty, 15, 'still holding fifteen');
  // Sold 5 at 500 that cost 350 each.
  assert.equal(Math.round(m.realised), 750);
  assert.equal(m.open, true);
});

test('positionMath: a fully sold position is closed, not held at zero', () => {
  const m = positionMath(P({ exits: [{ qty: 10, price: 450 }] }));
  assert.equal(m.qty, 0);
  assert.equal(m.open, false);
  assert.equal(Math.round(m.realised), 500);
});

test('cleanPosition: a negative or junk quantity never becomes a holding', () => {
  // A minus sign surviving into a quantity would turn a sale into a purchase.
  const p = cleanPosition({ ticker: 'ko', entries: [{ qty: -5, price: 60 }, { qty: 'x', price: 60 }, { qty: 3, price: 60 }] });
  assert.equal(p.ticker, 'KO', 'tickers are normalised');
  assert.equal(p.entries.length, 1, 'only the real leg survives');
  assert.equal(positionMath(p).qty, 3);
});

test('valuePosition: no quote means no value — never zero', () => {
  // A failed fetch that valued at zero once showed a whole book as a total loss.
  const v = valuePosition(P(), null);
  assert.equal(v.value, null);
  assert.equal(v.unrealised, null);
  assert.notEqual(v.value, 0, 'unknown must not read as worthless');
  assert.equal(v.qty, 10, 'what he holds is still known');
});

test('valuePosition: gain and loss, long and short', () => {
  const up = valuePosition(P(), { price: 500 });
  assert.equal(up.unrealised, 1000);
  assert.equal(Math.round(up.pct), 25);
  const down = valuePosition(P(), { price: 300 });
  assert.equal(down.unrealised, -1000);
  // A short makes money when the price falls; the sign must flip.
  const short = valuePosition(P({ side: 'short' }), { price: 300 });
  assert.equal(short.unrealised, 1000);
});

test('summarise: an unpriced holding is excluded from the total AND named', () => {
  const positions = [P(), P({ ticker: 'ABC', entries: [{ qty: 5, price: 100 }] })];
  const b = summarise(positions, { MSTR: { price: 500 } });
  assert.equal(b.totalValue, 5000, 'only what could be priced');
  assert.deepEqual(b.unpricedTickers, ['ABC'], 'and the gap is reported, never silent');
  assert.equal(b.weights[0].ticker, 'MSTR');
});

test('checkRules: concentration and a missing invalidation are caught before the trade', () => {
  // A two-name book, so the arithmetic is actually exercised: 5,000 of MSTR, 5,000 of KO.
  const book = summarise(
    [P(), P({ ticker: 'KO', entries: [{ qty: 100, price: 40 }] })],
    { MSTR: { price: 500 }, KO: { price: 50 } }
  );
  assert.equal(book.totalValue, 10000);

  // Adding 5,000 more MSTR: 10,000 of 15,000 = 67%, well past the 20% ceiling.
  const warn = checkRules({ ticker: 'MSTR', addValue: 5000, book, invalidation: 'payout cut' });
  assert.match(warn.join(' '), /67% of the book/, 'doubling up breaches the 20% ceiling');

  // A brand-new name has a tighter starter limit than the ceiling.
  const starter = checkRules({ ticker: 'NEW', addValue: 2000, book, invalidation: 'payout cut' });
  assert.match(starter.join(' '), /starter size/);

  // A position that is ALREADY over the ceiling warns on any addition at all, however small —
  // the rule is about the state he ends up in, not the size of the tick.
  assert.match(
    checkRules({ ticker: 'MSTR', addValue: 10, book, invalidation: 'payout cut' }).join(' '),
    /50% of the book/,
    'MSTR is already half the book, so even a tiny add is worth flagging'
  );

  // A book where the name is genuinely small: 1,000 of MSTR against 9,000 of KO.
  const spread = summarise(
    [P({ entries: [{ qty: 2, price: 500 }] }), P({ ticker: 'KO', entries: [{ qty: 180, price: 50 }] })],
    { MSTR: { price: 500 }, KO: { price: 50 } }
  );
  assert.deepEqual(checkRules({ ticker: 'MSTR', addValue: 100, book: spread, invalidation: 'payout cut' }), [],
    'topping up a 10% position is within the rules and says nothing');

  const noInv = checkRules({ ticker: 'MSTR', addValue: 100, book: spread, invalidation: '' });
  assert.match(noInv.join(' '), /What would tell you this is wrong/);
  assert.equal(DEFAULT_RULES.requireInvalidation, true);
});

test('stale and brokenButHeld: the two questions worth asking without a model', () => {
  const now = Date.now();
  const old = P({ ticker: 'OLD', opened: now - 60 * 86400000 });
  const fresh = P({ ticker: 'NEW', opened: now - 60 * 86400000, checks: [{ ts: now - 86400000, verdict: 'holds' }] });
  const names = stale([old, fresh], 30, now).map((p) => p.ticker);
  assert.deepEqual(names, ['OLD'], 'checked yesterday is not stale');

  const broken = P({ ticker: 'BAD', checks: [{ ts: now, verdict: 'broken' }] });
  const closedBroken = P({ ticker: 'GONE', exits: [{ qty: 10, price: 1 }], checks: [{ ts: now, verdict: 'broken' }] });
  assert.deepEqual(brokenButHeld([broken, closedBroken, old]).map((p) => p.ticker), ['BAD'],
    'a broken thesis he already exited is not still a problem');
});

test('parseTradeLine: the ways he would actually type a fill', () => {
  assert.deepEqual(parseTradeLine('bought 10 MSTR at 402.50'), { action: 'buy', ticker: 'MSTR', qty: 10, price: 402.5 });
  assert.deepEqual(parseTradeLine('sold 5 mstr @ 390'), { action: 'sell', ticker: 'MSTR', qty: 5, price: 390 });
  assert.deepEqual(parseTradeLine('add 3 NVDA 178,20'), { action: 'buy', ticker: 'NVDA', qty: 3, price: 178.2 });
  assert.equal(parseTradeLine('bought 10 MSTR').price, null, 'no price given is null, never guessed');
  // Ordinary sentences must not become trades.
  for (const junk of ['', 'how is my book doing', 'I am thinking about buying more soon', null]) {
    assert.equal(parseTradeLine(junk), null, JSON.stringify(junk));
  }
});

test('incomeOf: income is on market value, and unknown yields are not counted as zero', () => {
  const positions = [P({ ticker: 'KO', entries: [{ qty: 100, price: 50 }] }), P({ ticker: 'XYZ' })];
  const prices = { KO: { price: 60 }, XYZ: { price: 10 } };
  const funds = { KO: { yieldPct: 3, payoutRatio: 70 } };       // nothing for XYZ
  const inc = incomeOf(positions, prices, funds);
  assert.equal(Math.round(inc.annual), 180, '3% of 6,000 held, not of what he paid');
  assert.equal(Math.round(inc.portfolioYield), 3);
  assert.deepEqual(inc.unknown, ['XYZ'], 'a missing yield is reported, not treated as no dividend');
  // Yield on cost is the flattering number and must stay separate from the real one.
  const ko = inc.rows.find((r) => r.ticker === 'KO');
  assert.ok(ko.yieldOnCost > ko.yieldPct, 'bought lower, so yield on cost reads higher');
});

test('dividendFlags: the yield trap is caught by arithmetic, not by argument', () => {
  assert.deepEqual(dividendFlags(null), []);
  assert.deepEqual(dividendFlags({ yieldPct: 3, payoutRatio: 55, divGrowth5y: 7 }), [], 'a healthy payer is quiet');

  const unsafe = dividendFlags({ yieldPct: 12, payoutRatio: 130, divGrowth5y: -4 }).join(' | ');
  assert.match(unsafe, /more than it earns/);
  assert.match(unsafe, /pricing in a cut/);
  assert.match(unsafe, /SHRUNK/);

  assert.match(dividendFlags({ payoutRatio: 88 }).join(' '), /little room/, '80-100% is stretched, not yet broken');
});

test('cleanTicker: only a plausible symbol reaches a URL', () => {
  assert.equal(cleanTicker(' mstr '), 'MSTR');
  assert.equal(cleanTicker('BRK.B'), 'BRK.B');
  for (const bad of ['', null, 'not a ticker', '../etc/passwd', 'A'.repeat(20), '<script>']) {
    assert.equal(cleanTicker(bad), '', JSON.stringify(bad));
  }
});

test('priceFacts: the model is told what it may use and what it must not invent', () => {
  const facts = priceFacts({
    prices: { KO: { ticker: 'KO', price: 60, currency: 'USD', at: Date.now(), source: 'finnhub', delayed: false } },
    missing: ['XYZ'],
  });
  assert.match(facts, /KO 60\.00 USD/);
  assert.match(facts, /the only prices that exist for you/);
  assert.match(facts, /NO PRICE AVAILABLE for: XYZ/);
  assert.match(facts, /Do not estimate/);
  // With nothing at all, it must still say so rather than staying silent.
  assert.match(priceFacts({ prices: {}, missing: [] }), /PRICES: none available/);
});

// ---- Rebalancing ----
// He wants to rebalance monthly on a $1,000 book. These exist to make sure the honest answer —
// "do nothing, the trade costs more than the drift" — is the one the arithmetic actually gives,
// because that is the answer most months and it is the one that saves him money.

import { driftOf, rebalancePlan, REBALANCE_RULES } from '../src/steward/book.js';

const T = (ticker, qty, price, target) =>
  cleanPosition({ ticker, target, entries: [{ qty, price }] });

test('driftOf: actual weight against the target that was written down', () => {
  // 600 of KO, 400 of PEP, in a 1,000 book with 50/50 targets.
  const positions = [T('KO', 60, 10, 50), T('PEP', 40, 10, 50)];
  const d = driftOf(positions, { KO: { price: 10 }, PEP: { price: 10 } });
  assert.equal(d.total, 1000);
  const ko = d.rows.find((r) => r.ticker === 'KO');
  assert.equal(ko.actualPct, 60);
  assert.equal(ko.drift, 10, 'ten points above target');
  assert.equal(ko.gap, -100, 'a hundred dollars too much');
  assert.equal(ko.outside, true, 'past the tighter of 5pts and a quarter of 50%');
});

test('driftOf: an unfinished plan is named, not silently measured against', () => {
  const d = driftOf([T('KO', 60, 10, 30), T('PEP', 40, 10, 30)], { KO: { price: 10 }, PEP: { price: 10 } });
  assert.equal(d.targetsSum, 60);
  const plan = rebalancePlan({ positions: [T('KO', 60, 10, 30), T('PEP', 40, 10, 30)], prices: { KO: { price: 10 }, PEP: { price: 10 } } });
  assert.match(plan.notes.join(' '), /add up to 60%/);
});

test('rebalancePlan: small drift on a small book means DO NOTHING, and says why', () => {
  // 1,000 book, KO 2 points off target. Two points of a 1,000 book is $20 — less than the
  // minimum trade, so acting on it costs more than the drift it corrects.
  const positions = [T('KO', 52, 10, 50), T('PEP', 48, 10, 50)];
  const plan = rebalancePlan({ positions, prices: { KO: { price: 10 }, PEP: { price: 10 } } });
  assert.deepEqual(plan.buys, []);
  assert.deepEqual(plan.sells, [], 'inside the band, so nothing is sold');
  assert.match(plan.notes.join(' '), /Nothing to do/);
  assert.match(plan.notes.join(' '), /cost more than the drift/);
});

test('rebalancePlan: new money goes to the underweight, and nothing is sold', () => {
  const positions = [T('KO', 70, 10, 50), T('PEP', 30, 10, 50)];
  const prices = { KO: { price: 10 }, PEP: { price: 10 } };
  const plan = rebalancePlan({ positions, prices, contribution: 200 });
  assert.equal(plan.sells.length, 0, 'a contribution fixes drift without realising anything');
  assert.equal(plan.buys.length, 1);
  assert.equal(plan.buys[0].ticker, 'PEP', 'the one furthest below target');
  assert.equal(plan.buys[0].amount, 200, 'all of it, since the gap is larger than the cheque');
});

test('rebalancePlan: a contribution larger than the gap still gets fully allocated', () => {
  const positions = [T('KO', 55, 10, 50), T('PEP', 45, 10, 50)];
  const plan = rebalancePlan({ positions, prices: { KO: { price: 10 }, PEP: { price: 10 } }, contribution: 500 });
  const total = plan.buys.reduce((n, b) => n + b.amount, 0);
  assert.equal(total, 500, 'no money is left unallocated');
});

test('rebalancePlan: selling is a last resort — only outside the band, only with no new money', () => {
  const positions = [T('KO', 70, 10, 50), T('PEP', 30, 10, 50)];
  const prices = { KO: { price: 10 }, PEP: { price: 10 } };
  const withCash = rebalancePlan({ positions, prices, contribution: 100 });
  assert.equal(withCash.sells.length, 0, 'new money available means no sale');

  const noCash = rebalancePlan({ positions, prices });
  assert.equal(noCash.sells.length, 1, 'genuinely outside the band and no contribution');
  assert.equal(noCash.sells[0].ticker, 'KO');
  assert.equal(noCash.sells[0].amount, 200);
});

test('rebalancePlan: no targets means it asks for them rather than inventing any', () => {
  const plan = rebalancePlan({ positions: [cleanPosition({ ticker: 'KO', entries: [{ qty: 10, price: 10 }] })], prices: { KO: { price: 10 } } });
  assert.match(plan.notes.join(' '), /No targets set/);
  assert.deepEqual(plan.buys, []);
});

test('REBALANCE_RULES: the band is the tighter of absolute and relative', () => {
  // A 4% target: a quarter of it is 1pt, which is tighter than 5pts and so governs.
  const small = driftOf([T('A', 6, 10, 4), T('B', 94, 10, 96)], { A: { price: 10 }, B: { price: 10 } });
  assert.equal(small.rows.find((r) => r.ticker === 'A').band, 1);
  // A 50% target: a quarter is 12.5pts, so the 5pt absolute band governs instead.
  const big = driftOf([T('A', 50, 10, 50), T('B', 50, 10, 50)], { A: { price: 10 }, B: { price: 10 } });
  assert.equal(big.rows.find((r) => r.ticker === 'A').band, 5);
  assert.equal(REBALANCE_RULES.minTradeValue, 25);
});
