// ---- Pocket: what comes in, what goes out, and what it all adds up to ----
//
// Pure. No database, no network, no model. Everything that decides what a number MEANS lives
// here so it can be tested, because this is the file that answers "how much do I actually
// have" and getting that wrong is not a display bug.
//
// The household is genuinely three-currency: he earns and spends in euro, holds a portfolio in
// dollars, and has deposits and an apartment in Egypt. So:
//
//   AN AMOUNT WITHOUT A CURRENCY IS NOT AN AMOUNT.
//
// Every figure is stored in the currency it exists in and converted only when shown. Nothing
// is stored converted — a stored conversion is wrong the moment the rate moves, and the
// original is gone so it cannot be corrected. A missing rate produces null and is reported as
// "not converted", never as the raw number passed through, and never as zero.

import { toBase, cleanCurrency, isKnownCurrency } from '../fx.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// What he holds. `portfolio` is the steward's book, carried here so net worth is the whole
// picture rather than the part that happens to live in this database.
export const ACCOUNT_KINDS = ['cash', 'deposit', 'property', 'portfolio', 'other'];
// Money that arrives without him working for it. This flag, not the category name, is what
// the goal counts — "rent" typed as a category is a label; `passive` is a decision.
export const PASSIVE_KINDS = ['rent', 'interest', 'dividend'];

export function cleanAccount(a) {
  return {
    id: txt(a?.id, 32) || Date.now().toString(36),
    label: txt(a?.label, 80),
    kind: ACCOUNT_KINDS.includes(a?.kind) ? a.kind : 'cash',
    currency: cleanCurrency(a?.currency) || 'EUR',
    value: Math.max(0, num(a?.value)),
    // For a deposit: the rate it pays, in its own currency. Which is not the same thing as
    // what it earns him — see realReturn() in fx.js.
    ratePct: a?.ratePct == null ? null : num(a.ratePct),
    note: txt(a?.note, 300),
    at: num(a?.at) || Date.now(),
  };
}

export function cleanFlow(f) {
  const category = txt(f?.category, 40).toLowerCase();
  return {
    id: txt(f?.id, 32) || Date.now().toString(36),
    dir: f?.dir === 'out' ? 'out' : 'in',
    category,
    amount: Math.abs(num(f?.amount)),
    currency: cleanCurrency(f?.currency) || 'EUR',
    ts: num(f?.ts) || Date.now(),
    // Repeats every month unless he says otherwise — salary, rent, a subscription.
    recurring: !!f?.recurring,
    // Passive is set explicitly, but a category that is obviously passive defaults to true so
    // he does not have to remember a flag for the thing the whole goal is about.
    passive: f?.passive == null ? PASSIVE_KINDS.includes(category) : !!f.passive,
    note: txt(f?.note, 300),
  };
}

/** Everything he owns, in one currency. Anything without a rate is EXCLUDED from the total and
 *  named — a net worth that quietly omits the Egyptian apartment is worse than no total. */
export function netWorth(accounts, table, base = 'EUR') {
  const rows = accounts.map((a) => ({ ...a, inBase: toBase(a.value, a.currency, table) }));
  const known = rows.filter((r) => r.inBase != null);
  const total = known.reduce((n, r) => n + r.inBase, 0);
  const byCurrency = {};
  for (const r of rows) {
    byCurrency[r.currency] = byCurrency[r.currency] || { currency: r.currency, raw: 0, inBase: 0, converted: true };
    byCurrency[r.currency].raw += r.value;
    if (r.inBase == null) byCurrency[r.currency].converted = false;
    else byCurrency[r.currency].inBase += r.inBase;
  }
  return {
    rows, total, base,
    byKind: ACCOUNT_KINDS.map((k) => ({
      kind: k,
      inBase: known.filter((r) => r.kind === k).reduce((n, r) => n + r.inBase, 0),
    })).filter((x) => x.inBase > 0),
    byCurrency: Object.values(byCurrency),
    unconverted: rows.filter((r) => r.inBase == null).map((r) => `${r.label || r.kind} (${r.currency})`),
    // How much of the whole is exposed to one currency. For a household with most of its net
    // worth in a currency it does not spend, this is the number that matters most.
    exposure: Object.values(byCurrency)
      .filter((c) => c.converted && total > 0)
      .map((c) => ({ currency: c.currency, pct: (c.inBase / total) * 100 }))
      .sort((a, b) => b.pct - a.pct),
  };
}

/** One month of flows. `from`/`to` bound it so "this month" is a decision the caller makes and
 *  not something guessed at in here. */
export function monthOf(flows, table, base = 'EUR', { from, to } = {}) {
  const start = from == null ? 0 : from;
  const end = to == null ? Number.MAX_SAFE_INTEGER : to;
  const inWindow = flows.filter((f) => f.ts >= start && f.ts <= end);
  const conv = (f) => toBase(f.amount, f.currency, table);

  const sum = (list) => list.reduce((acc, f) => {
    const v = conv(f);
    if (v == null) { acc.unconverted.push(f); return acc; }
    acc.total += v;
    return acc;
  }, { total: 0, unconverted: [] });

  const income = sum(inWindow.filter((f) => f.dir === 'in'));
  const spending = sum(inWindow.filter((f) => f.dir === 'out'));
  const passive = sum(inWindow.filter((f) => f.dir === 'in' && f.passive));

  const byCategory = {};
  for (const f of inWindow.filter((x) => x.dir === 'out')) {
    const v = conv(f);
    if (v == null) continue;
    byCategory[f.category || 'uncategorised'] = (byCategory[f.category || 'uncategorised'] || 0) + v;
  }

  return {
    base,
    income: income.total,
    spending: spending.total,
    surplus: income.total - spending.total,
    passive: passive.total,
    // The lever he actually controls, and at his stage the one that moves the goal fastest.
    savingsRatePct: income.total > 0 ? ((income.total - spending.total) / income.total) * 100 : null,
    spendingByCategory: Object.entries(byCategory).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
    unconverted: [...income.unconverted, ...spending.unconverted].map((f) => `${f.category || f.dir} (${f.currency})`),
  };
}

/** Passive income against the target. Deliberately just the gap — no date, no projection. */
export function goalProgress(passiveMonthly, goal) {
  const target = num(goal?.monthly);
  if (!(target > 0)) return null;
  const now = Math.max(0, num(passiveMonthly));
  return {
    target,
    now,
    pct: (now / target) * 100,
    gap: Math.max(0, target - now),
    currency: cleanCurrency(goal?.currency) || 'EUR',
  };
}

/** How far off the goal is, given what he saves and what the money earns.
 *
 *  Returned as a RANGE across explicitly stated yields, never a single number, because a single
 *  number is a promise and the inputs do not support one. The eToro challenge he was shown
 *  quotes a date in 2053 to the dollar off exactly this arithmetic with one optimistic yield;
 *  the honest version of the same maths is a spread with its assumptions printed beside it. */
export function yearsToGoal({ invested, monthlyContribution, goalMonthly, yields = [0.035, 0.05, 0.07] }) {
  const target = num(goalMonthly) * 12;            // annual income needed
  const start = Math.max(0, num(invested));
  const add = Math.max(0, num(monthlyContribution)) * 12;
  if (!(target > 0)) return null;

  const scenarios = yields.map((y) => {
    const capitalNeeded = target / y;
    if (start >= capitalNeeded) return { yieldPct: y * 100, capitalNeeded, years: 0 };
    if (add <= 0) return { yieldPct: y * 100, capitalNeeded, years: null };
    // Capital compounds at the same rate the income is drawn at — dividends reinvested, which
    // is what he is actually doing. Capped so an unreachable combination reports unreachable
    // rather than looping.
    let capital = start, years = 0;
    while (capital < capitalNeeded && years < 100) { capital = capital * (1 + y) + add; years += 1; }
    return { yieldPct: y * 100, capitalNeeded, years: years >= 100 ? null : years };
  });

  const reachable = scenarios.filter((s) => s.years != null).map((s) => s.years);
  return {
    scenarios,
    fastest: reachable.length ? Math.min(...reachable) : null,
    slowest: reachable.length ? Math.max(...reachable) : null,
    // Stated so it travels with the number wherever it is printed.
    assumes: 'income reinvested, contributions held flat, no tax, no inflation adjustment',
  };
}

// ---- Reading a line he typed ----
//
// "in 3200 salary" · "out 40 food" · "in 27000 EGP rent" · "add deposit 540000 EGP Cairo flat"
//
// The currency is decided in CODE, not in the pattern. A regex group of three letters also
// matches the start of "salary", "food" and "gas", so an earlier version of this recorded
// 3,200 SAL — a currency with no rate, which silently dropped the amount out of every total.
// A three-letter word is only a currency if it is actually a currency.
export function parseEntry(text, base = 'EUR') {
  const s = String(text || '').trim();
  // A leading sign is tolerated and then ignored: direction comes from the word "in" or "out",
  // never from a minus, so "out -40 food" is a spend of 40 rather than an unparseable line he
  // has to retype.
  const flow = s.match(/^\/?(in|out)\s+[-+]?\s*(\d[\d\s.,]*)\s*(.*)$/i);
  const acct = s.match(/^\/?add\s+(\w+)\s+[-+]?\s*(\d[\d\s.,]*)\s*(.*)$/i);
  if (!flow && !acct) return null;

  // "12,50" and "1 200,50" and "1,200.50" all mean what he thinks they mean.
  const amountOf = (raw) => {
    const t = String(raw).replace(/\s/g, '');
    // Last separator wins as the decimal point; anything before it is a thousands mark.
    const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
    let cleaned;
    if (lastComma > lastDot) cleaned = t.replace(/\./g, '').replace(',', '.');
    else cleaned = t.replace(/,/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.abs(n) : null;
  };

  // The first word of the remainder is a currency only if it is one.
  const split = (rest) => {
    const words = String(rest || '').trim().split(/\s+/).filter(Boolean);
    if (words.length && isKnownCurrency(words[0])) {
      return { currency: words[0].toUpperCase(), rest: words.slice(1).join(' ') };
    }
    return { currency: base, rest: words.join(' ') };
  };

  if (acct) {
    const kind = acct[1].toLowerCase();
    if (!ACCOUNT_KINDS.includes(kind)) return { type: 'account', badKind: kind };
    const amount = amountOf(acct[2]);
    const { currency, rest } = split(acct[3]);
    if (amount == null) return null;
    return { type: 'account', kind, value: amount, currency, label: rest || kind };
  }

  const amount = amountOf(flow[2]);
  if (amount == null) return null;
  const { currency, rest } = split(flow[3]);
  const words = rest.split(/\s+/).filter(Boolean);
  return {
    type: 'flow',
    dir: flow[1].toLowerCase(),
    amount, currency,
    category: (words[0] || 'uncategorised').toLowerCase(),
    note: rest,
  };
}
