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

// ---- Beating the boring option ----
// He already owns a global index portfolio on a standing order that he does not touch. Picking
// stocks by hand has to beat that or it is a hobby he is paying for. These tests exist to make
// sure the comparison can actually deliver bad news.

import { benchmarkCompare } from '../src/steward/book.js';

const series = new Map([
  ['2026-01-02', 100],
  ['2026-06-01', 125],
  ['2026-09-01', 150],
]);
const at = (d) => Date.parse(d + 'T12:00:00Z');

test('benchmarkCompare: says plainly when the index would have won', () => {
  // $1,000 into a pick on 2 Jan, now worth $1,200 (+20%). The index went 100 -> 150 (+50%).
  const positions = [cleanPosition({ ticker: 'PICK', entries: [{ qty: 10, price: 100, ts: at('2026-01-02') }] })];
  const s = benchmarkCompare({ positions, prices: { PICK: { price: 120 } }, series, benchNow: 150, ticker: 'URTH' });
  assert.equal(s.contributed, 1000);
  assert.equal(s.actual, 1200);
  assert.equal(s.benchValue, 1500, '1,000 bought 10 units at 100, now worth 150 each');
  assert.equal(s.edge, -300);
  assert.ok(s.edgePct < 0);
  assert.equal(s.trustworthy, true);
});

test('benchmarkCompare: and when the picking genuinely won', () => {
  const positions = [cleanPosition({ ticker: 'PICK', entries: [{ qty: 10, price: 100, ts: at('2026-01-02') }] })];
  const s = benchmarkCompare({ positions, prices: { PICK: { price: 200 } }, series, benchNow: 150 });
  assert.equal(s.actual, 2000);
  assert.equal(s.edge, 500);
});

test('benchmarkCompare: money-weighted — buying a winner late does not flatter the result', () => {
  // Second tranche goes in on 1 June, when the benchmark had already run to 125. Crediting it
  // at the January price would hand him benchmark units he never funded.
  const positions = [cleanPosition({
    ticker: 'PICK',
    entries: [
      { qty: 10, price: 100, ts: at('2026-01-02') },   // 1,000 at bench 100 -> 10 units
      { qty: 10, price: 100, ts: at('2026-06-01') },   // 1,000 at bench 125 -> 8 units
    ],
  })];
  const s = benchmarkCompare({ positions, prices: { PICK: { price: 100 } }, series, benchNow: 150 });
  assert.equal(s.contributed, 2000);
  assert.equal(s.benchValue, 18 * 150, 'eighteen units, not twenty');
});

test('benchmarkCompare: money taken out leaves the benchmark too', () => {
  // Without subtracting the sale, he would be credited a benchmark stake he no longer funds.
  const positions = [cleanPosition({
    ticker: 'PICK',
    entries: [{ qty: 10, price: 100, ts: at('2026-01-02') }],
    exits: [{ qty: 5, price: 100, ts: at('2026-06-01') }],
  })];
  const s = benchmarkCompare({ positions, prices: { PICK: { price: 100 } }, series, benchNow: 150 });
  assert.equal(s.contributed, 500, 'a thousand in, five hundred back out');
  assert.equal(s.benchValue, 6 * 150, '10 units bought, 4 sold back at 125');
});

test('benchmarkCompare: a weekend buy uses the last trading day, not nothing', () => {
  // 2026-01-04 is a Sunday here: there is no row, and dropping the leg would silently shrink
  // the comparison rather than reporting a gap.
  const positions = [cleanPosition({ ticker: 'PICK', entries: [{ qty: 10, price: 100, ts: at('2026-01-04') }] })];
  const s = benchmarkCompare({ positions, prices: { PICK: { price: 100 } }, series, benchNow: 150 });
  assert.equal(s.missingLegs, 0);
  assert.equal(s.benchValue, 1500, 'priced off 2 January');
});

test('benchmarkCompare: a leg with no benchmark price is counted as missing, not skipped quietly', () => {
  const positions = [cleanPosition({ ticker: 'PICK', entries: [{ qty: 10, price: 100, ts: at('2020-01-02') }] })];
  const s = benchmarkCompare({ positions, prices: { PICK: { price: 100 } }, series, benchNow: 150 });
  assert.equal(s.missingLegs, 1);
  assert.equal(s.trustworthy, false, 'a partial scoreboard must announce itself');
});

// ---- Funding a book over two years ----
// $1,000 now and $1,000 a month for 24 months. Judged against a half-built book, every buy in
// year one breaches a limit and the bot cries wolf until he stops reading it. Judged against
// what he has committed to fund, the same buy is 4% and the warnings mean something again.

import { plannedCapital, checkRulesPlanned, planProgress } from '../src/steward/book.js';

const PLAN = { monthly: 1000, months: 24, startCapital: 1000, startedAt: Date.parse('2026-09-01T00:00:00Z') };

test('plannedCapital: what he has committed, and what is still to come', () => {
  const p = plannedCapital(PLAN, Date.parse('2026-09-02T00:00:00Z'));
  assert.equal(p.committed, 25000, '1,000 now plus 1,000 a month for 24 months');
  assert.equal(p.monthsLeft, 24);
  assert.equal(p.toCome, 24000);

  // A year in, the remaining commitment has shrunk but the total has not.
  const later = plannedCapital(PLAN, Date.parse('2027-09-01T00:00:00Z'));
  assert.equal(later.monthsLeft, 12);
  assert.equal(later.toCome, 12000);
  assert.equal(later.committed, 25000, 'the plan does not shrink as it is funded');

  assert.equal(plannedCapital(null), null);
  assert.equal(plannedCapital({ monthly: 0, months: 24 }), null, 'a plan with no money in it is not a plan');
});

test('checkRulesPlanned: the first buy of a 25k plan is 4%, not 100%', () => {
  const empty = summarise([], {});
  const planned = plannedCapital(PLAN, PLAN.startedAt);

  // Against the book alone this is the entire account and would warn.
  assert.match(
    checkRules({ ticker: 'KO', addValue: 1000, book: empty, invalidation: 'cut' }).join(' '),
    /100% of the book/,
    'the old rule, which is why it needed replacing'
  );
  // Against the plan it is 4% of committed capital, which is the truth.
  assert.deepEqual(
    checkRulesPlanned({ ticker: 'KO', addValue: 1000, book: empty, planned, invalidation: 'cut' }),
    [],
    'a first position inside the starter size says nothing'
  );
});

test('checkRulesPlanned: the ceiling still bites when it should', () => {
  const planned = plannedCapital(PLAN, PLAN.startedAt);
  const empty = summarise([], {});
  // 6,000 into one name is 24% of the 25,000 plan — past the 20% ceiling even on day one.
  assert.match(
    checkRulesPlanned({ ticker: 'KO', addValue: 6000, book: empty, planned, invalidation: 'cut' }).join(' '),
    /24% of your planned capital/
  );
  // And 3,000 is 12% — inside the ceiling but above the 10% starter size for a NEW name.
  assert.match(
    checkRulesPlanned({ ticker: 'NEW', addValue: 3000, book: empty, planned, invalidation: 'cut' }).join(' '),
    /starter size/
  );
});

test('checkRulesPlanned: once the book outgrows the plan, the book is the measure', () => {
  const big = summarise(
    [cleanPosition({ ticker: 'KO', entries: [{ qty: 1000, price: 100 }] })],
    { KO: { price: 100 } }
  );                                        // a 100,000 book against a 25,000 plan
  const planned = plannedCapital(PLAN, PLAN.startedAt);
  // 30,000 more of KO would be 130,000 of 130,000 — the plan must not soften a real breach.
  assert.match(
    checkRulesPlanned({ ticker: 'KO', addValue: 30000, book: big, planned, invalidation: 'cut' }).join(' '),
    /100% of your planned capital/
  );
});

test('checkRulesPlanned: no plan behaves exactly like the old rule', () => {
  const empty = summarise([], {});
  assert.match(
    checkRulesPlanned({ ticker: 'KO', addValue: 1000, book: empty, planned: null, invalidation: 'cut' }).join(' '),
    /100% of/,
    'without a plan there is nothing to measure against but the book'
  );
});

test('planProgress: reports what he has put in, and refuses to project', () => {
  const book = summarise([cleanPosition({ ticker: 'KO', entries: [{ qty: 50, price: 100 }] })], { KO: { price: 120 } });
  const p = planProgress(PLAN, book, PLAN.startedAt);
  assert.equal(p.invested, 5000, 'what he paid, not what it is worth');
  assert.equal(Math.round(p.fundedPct), 20);
  assert.equal(p.committed, 25000);
  // There is deliberately no projected-value field. He has seen enough of those this week.
  assert.equal(p.projected, undefined);
});

// ---- Reading a filing ----
// The model copies figures out of the document; the code decides what they mean. These test
// the deciding half, which is the half that must never be wrong.

import { cleanFigures, coverageOf, digestFlags, compareDigests, htmlToText } from '../src/steward/digest.js';

test('cleanFigures: filings write negatives in brackets and scale in words', () => {
  const f = cleanFigures({
    revenue: '12,345.6 million', capex: '(2,100)', dividendsPaid: '(3,910)',
    operatingCashFlow: '8,092', netIncome: 'not disclosed', cash: '1.2 billion',
  });
  assert.equal(f.revenue, 12345.6e6);
  assert.equal(f.capex, 2100, 'capex is a magnitude, not a sign');
  assert.equal(f.dividendsPaid, 3910);
  assert.equal(f.operatingCashFlow, 8092);
  assert.equal(f.netIncome, null, 'prose where a number belongs is unknown, not zero');
  assert.equal(f.cash, 1.2e9);
});

test('coverageOf: free cash flow cover is the number that matters', () => {
  const f = cleanFigures({ operatingCashFlow: 8092, capex: 2100, dividendsPaid: 3910, netIncome: 5000, buybacks: 2000, totalDebt: 30000, cash: 5000 });
  const c = coverageOf(f);
  assert.equal(c.freeCashFlow, 5992);
  assert.ok(Math.abs(c.fcfCover - 1.532) < 0.001);
  assert.ok(Math.abs(c.earningsCover - 1.279) < 0.001);
  assert.equal(c.netDebt, 25000);
  // Buybacks compete for the same cash: 5,992 against 5,910 is barely over one.
  assert.ok(c.fcfCoverWithBuybacks < 1.02);
});

test('coverageOf: a missing figure produces null, never a confident ratio', () => {
  const c = coverageOf(cleanFigures({ operatingCashFlow: 8092, dividendsPaid: 3910 }));
  assert.equal(c.freeCashFlow, null, 'no capex means no free cash flow');
  assert.equal(c.fcfCover, null);
  // A zero dividend must not divide.
  assert.equal(coverageOf(cleanFigures({ operatingCashFlow: 100, capex: 10, dividendsPaid: 0 })).fcfCover, null);
});

test('digestFlags: the gap between profit and cash is where a cut hides', () => {
  const f = cleanFigures({ operatingCashFlow: 4000, capex: 1000, dividendsPaid: 3500, netIncome: 5000 });
  const flags = digestFlags(f, coverageOf(f)).join(' | ');
  assert.match(flags, /Earnings cover the dividend but cash does not/);

  const unsafe = cleanFigures({ operatingCashFlow: 3000, capex: 1000, dividendsPaid: 3000 });
  assert.match(digestFlags(unsafe, coverageOf(unsafe)).join(' '), /NOT funded by the business/);

  const healthy = cleanFigures({ operatingCashFlow: 9000, capex: 1000, dividendsPaid: 2000, netIncome: 3000 });
  assert.deepEqual(digestFlags(healthy, coverageOf(healthy)), [], 'a well-covered payer is quiet');

  // Unknown must announce itself rather than passing as fine.
  assert.match(digestFlags(cleanFigures({}), coverageOf(cleanFigures({}))).join(' '), /unknown, not fine/);
});

test('compareDigests: a cover falling over three quarters is the whole story', () => {
  const mk = (fcfCover, div) => ({ coverage: { fcfCover }, figures: { dividendsPaid: div } });
  const out = compareDigests(mk(1.05, 3900), mk(1.8, 3900)).join(' | ');
  assert.match(out, /FCF cover down from 1\.80x to 1\.05x/);
  assert.match(out, /⚠/, 'falling cover is flagged, not just reported');
  // A dividend that shrank is the loudest signal there is.
  assert.match(compareDigests(mk(2, 1000), mk(2, 3900)).join(' '), /Dividends paid FELL/);
  assert.deepEqual(compareDigests(mk(1.5, 100), null), [], 'nothing to compare against on the first read');
});

test('htmlToText: script and style contents never become prose', () => {
  const t = htmlToText('<style>.a{color:red}</style><script>var x=1</script><p>Dividends paid</p><p>3,910</p>');
  assert.doesNotMatch(t, /color:red|var x/);
  assert.match(t, /Dividends paid/);
  assert.match(t, /3,910/);
});
