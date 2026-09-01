// ---- The book ----
//
// Pure functions over positions: no database, no network, no model. Everything that decides
// what a position IS lives here, so it can be tested, and so a bug in the chatty parts can
// never quietly rewrite the record of what he actually did.
//
// The shape of this is deliberately the same shape as Kept. A book has a thought and the page
// it came from; a position has a THESIS and the price it was taken at. Kept exists because
// finishing a book is not the same as using it. This exists because having a view is not the
// same as having been right — and the only way to tell the difference later is to write down,
// at the moment you enter, what would prove you wrong.

const MAX_LEG = 500;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pos = (v) => Math.max(0, num(v));
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/** One buy or sell. Price and quantity are always positive; direction is the leg it sits in,
 *  never a negative number — a minus sign that survived into a quantity once turned a sale
 *  into a purchase and doubled a position on paper. */
function cleanLeg(l) {
  return {
    qty: pos(l?.qty),
    price: pos(l?.price),
    ts: num(l?.ts) || Date.now(),
    note: txt(l?.note, 300),
  };
}

export const SIDES = ['long', 'short'];
export const VERDICTS = ['holds', 'broken', 'unclear'];

/** The whitelist. Same rule as saveBooks in Kept: a field this does not know about is gone,
 *  so anything added later must be added here too — and an absent key is not the same as an
 *  empty one. */
export function cleanPosition(p) {
  const entries = (Array.isArray(p?.entries) ? p.entries : []).slice(-MAX_LEG).map(cleanLeg).filter((l) => l.qty > 0);
  const exits = (Array.isArray(p?.exits) ? p.exits : []).slice(-MAX_LEG).map(cleanLeg).filter((l) => l.qty > 0);
  return {
    id: txt(p?.id, 32) || Date.now().toString(36),
    ticker: txt(p?.ticker, 12).toUpperCase(),
    name: txt(p?.name, 120),
    side: SIDES.includes(p?.side) ? p.side : 'long',
    entries,
    exits,
    // The two fields the whole thing exists for.
    thesis: txt(p?.thesis, 2000),
    invalidation: txt(p?.invalidation, 1000),
    // Every time he was asked "does the thesis still hold?" and what he said.
    checks: (Array.isArray(p?.checks) ? p.checks : []).slice(-100).map((c) => ({
      ts: num(c?.ts) || Date.now(),
      verdict: VERDICTS.includes(c?.verdict) ? c.verdict : 'unclear',
      note: txt(c?.note, 600),
    })),
    opened: num(p?.opened) || (entries[0]?.ts ?? Date.now()),
    // What he concluded after it was over. The lesson is the only part that compounds.
    review: p?.review ? { ts: num(p.review.ts) || Date.now(), lesson: txt(p.review.lesson, 1000) } : null,
  };
}

/** Quantities and money, from the legs alone — never stored, always derived. A stored balance
 *  and a leg list disagree the first time a leg is edited, and then neither can be trusted. */
export function positionMath(p) {
  const bought = p.entries.reduce((n, l) => n + l.qty, 0);
  const sold = p.exits.reduce((n, l) => n + l.qty, 0);
  const cost = p.entries.reduce((n, l) => n + l.qty * l.price, 0);
  const avgCost = bought > 0 ? cost / bought : 0;
  const proceeds = p.exits.reduce((n, l) => n + l.qty * l.price, 0);
  const qty = Math.max(0, bought - sold);
  // Realised P&L against average cost, which is what a person means by "did I make money on
  // the bit I sold". Not tax lots — this is a decision journal, not an accountant.
  const closedQty = Math.min(bought, sold);
  const realised = proceeds - closedQty * avgCost;
  return {
    qty, bought, sold, avgCost, cost, proceeds, realised,
    open: qty > 1e-9,
    invested: qty * avgCost,
  };
}

/** What it is worth now, and what that means. Requires a real quote — there is deliberately
 *  no default price argument, so a caller with no quote cannot accidentally value at zero. */
export function valuePosition(p, quote) {
  const m = positionMath(p);
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
    return { ...m, price: null, value: null, unrealised: null, pct: null };
  }
  const dir = p.side === 'short' ? -1 : 1;
  const value = m.qty * quote.price;
  const unrealised = dir * (quote.price - m.avgCost) * m.qty;
  const pct = m.avgCost > 0 ? dir * ((quote.price - m.avgCost) / m.avgCost) * 100 : null;
  return { ...m, price: quote.price, value, unrealised, pct };
}

/** The whole book at once, for a review or a status line. */
export function summarise(positions, prices) {
  const rows = positions.map((p) => ({ p, v: valuePosition(p, prices?.[p.ticker]) }));
  const open = rows.filter((r) => r.v.open);
  const valued = open.filter((r) => r.v.value != null);
  const totalValue = valued.reduce((n, r) => n + r.v.value, 0);
  return {
    rows, open,
    totalValue,
    totalInvested: open.reduce((n, r) => n + r.v.invested, 0),
    unrealised: valued.reduce((n, r) => n + r.v.unrealised, 0),
    realised: rows.reduce((n, r) => n + r.v.realised, 0),
    // Named so the gap is impossible to miss: a total that silently omits a third of the book
    // is worse than no total.
    unpricedTickers: open.filter((r) => r.v.value == null).map((r) => r.p.ticker),
    // Concentration, as a share of what we can actually value.
    weights: valued
      .map((r) => ({ ticker: r.p.ticker, pct: totalValue > 0 ? (r.v.value / totalValue) * 100 : 0 }))
      .sort((a, b) => b.pct - a.pct),
  };
}

/** His own rules, checked mechanically. The model is not asked whether a trade is too big —
 *  that is arithmetic, and arithmetic should not be delegated to something that can be talked
 *  out of it. */
export const DEFAULT_RULES = {
  maxPositionPct: 20,      // no single name above this share of the book
  maxNewPositionPct: 10,   // and a NEW one starts smaller than the ceiling
  requireInvalidation: true,
};

export function checkRules({ ticker, addValue, book, rules = DEFAULT_RULES, invalidation }) {
  const warnings = [];
  const total = (book?.totalValue || 0) + pos(addValue);
  if (total > 0) {
    const existing = book?.weights?.find((w) => w.ticker === ticker);
    const existingValue = existing ? (existing.pct / 100) * (book.totalValue || 0) : 0;
    const after = ((existingValue + pos(addValue)) / total) * 100;
    if (after > rules.maxPositionPct) {
      warnings.push(`${ticker} would be ${after.toFixed(0)}% of the book — your ceiling is ${rules.maxPositionPct}%.`);
    } else if (!existing && after > rules.maxNewPositionPct) {
      warnings.push(`A new position at ${after.toFixed(0)}% is above your ${rules.maxNewPositionPct}% starter size.`);
    }
  }
  if (rules.requireInvalidation && !txt(invalidation, 1000)) {
    warnings.push('No invalidation written. What would tell you this is wrong?');
  }
  return warnings;
}

/** Positions whose thesis has not been examined lately. The point of the whole system: an
 *  unexamined thesis is how a trade becomes a bag. Sorted oldest-first so a review starts with
 *  the one that has been ignored longest. */
export function stale(positions, days = 30, now = Date.now()) {
  const cutoff = now - days * 86400000;
  return positions
    .filter((p) => positionMath(p).open)
    .map((p) => ({ p, last: p.checks.length ? p.checks[p.checks.length - 1].ts : p.opened }))
    .filter((x) => x.last < cutoff)
    .sort((a, b) => a.last - b.last)
    .map((x) => x.p);
}

/** Positions he has already said are broken and has not closed. This is the single most
 *  valuable line the bot can produce, and it needs no model at all. */
export function brokenButHeld(positions) {
  return positions.filter((p) => {
    if (!positionMath(p).open) return false;
    const last = p.checks[p.checks.length - 1];
    return last && last.verdict === 'broken';
  });
}

// ---- Reading a trade the way he'd type it ----
// "bought 10 MSTR at 402.50", "sold 5 mstr @ 390", "add 3 NVDA 178.2".
// Deterministic first, model second: a parse that works is free, instant, and cannot invent a
// quantity. Anything this does not recognise is handed to the brain instead.
const BUY = /\b(bought|buy|add(?:ed)?|long)\b/i;
const SELL = /\b(sold|sell|trim(?:med)?|clos(?:e|ed)|exit(?:ed)?)\b/i;

export function parseTradeLine(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const isSell = SELL.test(s);
  const isBuy = BUY.test(s);
  if (!isSell && !isBuy) return null;
  // qty, then a symbol, then a price introduced by "at", "@" or just spacing.
  const m = s.match(/(\d+(?:[.,]\d+)?)\s+([A-Za-z][A-Za-z0-9.\-]{0,11})\b(?:\s*(?:at|@|for)?\s*\$?\s*(\d+(?:[.,]\d+)?))?/);
  if (!m) return null;
  const qty = Number(m[1].replace(',', '.'));
  const ticker = m[2].toUpperCase();
  const price = m[3] == null ? null : Number(m[3].replace(',', '.'));
  if (!(qty > 0)) return null;
  // A bare word where a symbol should be ("bought 2 more shares") is not a ticker. Requiring
  // a price or an all-caps symbol keeps ordinary sentences out of the book.
  if (!/^[A-Z0-9.\-]+$/.test(m[2]) && price == null) return null;
  return { action: isSell ? 'sell' : 'buy', ticker, qty, price };
}

// ---- Income, and the trap that comes with it ----
//
// His strategy: high dividends that still grow. Those two words pull against each other, and
// the tension is the whole game — the highest yields on any screen are almost always the ones
// about to be cut. So the book is judged on income AND on whether that income is safe, never
// on yield alone.

/** What the book pays, per year, at today's yields. */
export function incomeOf(positions, prices, funds) {
  const rows = [];
  for (const p of positions) {
    const m = positionMath(p);
    if (!m.open) continue;
    const f = funds?.[p.ticker];
    const q = prices?.[p.ticker];
    if (!f || f.yieldPct == null || !q) { rows.push({ ticker: p.ticker, income: null }); continue; }
    // Yield applies to market value, not to what he paid — that is what the payment actually
    // is today. Yield-on-cost is a different (flattering) number and is reported separately.
    const value = m.qty * q.price;
    const income = value * (f.yieldPct / 100);
    rows.push({
      ticker: p.ticker, income, value,
      yieldPct: f.yieldPct,
      yieldOnCost: m.avgCost > 0 ? (f.yieldPct * q.price) / m.avgCost : null,
      payoutRatio: f.payoutRatio,
      divGrowth5y: f.divGrowth5y,
    });
  }
  const known = rows.filter((r) => r.income != null);
  const annual = known.reduce((n, r) => n + r.income, 0);
  const value = known.reduce((n, r) => n + r.value, 0);
  return {
    rows, annual, monthly: annual / 12,
    portfolioYield: value > 0 ? (annual / value) * 100 : null,
    unknown: rows.filter((r) => r.income == null).map((r) => r.ticker),
  };
}

/** The yield trap, checked arithmetically rather than argued about.
 *
 *  A payout ratio over 100% means the company is paying out more than it earns, which it can
 *  do for a while and not forever. Above ~80% there is no room for a bad year. And a very
 *  high yield is usually not generosity — it is the market pricing in a cut that has not been
 *  announced yet. None of this is a reason never to buy; it is a reason to know which one
 *  you are buying. */
export const INCOME_RULES = {
  yieldSuspicious: 8,     // above this, ask why it is that high before anything else
  payoutStretched: 80,    // % of earnings
  payoutUnsustainable: 100,
};

export function dividendFlags(f, rules = INCOME_RULES) {
  const flags = [];
  if (!f) return flags;
  if (f.payoutRatio != null && f.payoutRatio > rules.payoutUnsustainable) {
    flags.push(`payout ratio ${f.payoutRatio.toFixed(0)}% — paying out more than it earns`);
  } else if (f.payoutRatio != null && f.payoutRatio > rules.payoutStretched) {
    flags.push(`payout ratio ${f.payoutRatio.toFixed(0)}% — little room for a bad year`);
  }
  if (f.yieldPct != null && f.yieldPct > rules.yieldSuspicious) {
    flags.push(`yield ${f.yieldPct.toFixed(1)}% — high enough that the market may be pricing in a cut`);
  }
  if (f.divGrowth5y != null && f.divGrowth5y < 0) {
    flags.push(`dividend has SHRUNK over 5 years (${f.divGrowth5y.toFixed(1)}%/yr) — income, but not growing`);
  }
  return flags;
}
