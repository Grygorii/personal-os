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

import { toBase, cleanCurrency, isKnownCurrency, realReturn } from '../fx.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// What he holds. `portfolio` is the steward's book, carried here so net worth is the whole
// picture rather than the part that happens to live in this database.
// The kinds he actually holds. `card` is a credit card BALANCE — what is owed on it, not a
// spending limit — which is why it sits with `loan` on the liability side.
export const ACCOUNT_KINDS = ['cash', 'deposit', 'property', 'portfolio', 'card', 'loan', 'other'];
// What is OWED, not owned. A loan is stored as a positive number like everything else — the
// sign lives in the kind, never in the value — and subtracted where it counts. Without this a
// borrowing either vanishes from net worth or, worse, is added to it.
export const LIABILITY_KINDS = ['loan', 'card'];
export const isLiability = (kind) => LIABILITY_KINDS.includes(kind);
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
  const rows = accounts.map((a) => {
    const inBase = toBase(a.value, a.currency, table);
    // Signed once, here, so every consumer below adds and nothing has to remember the rule.
    return { ...a, inBase, signed: inBase == null ? null : (isLiability(a.kind) ? -inBase : inBase) };
  });
  const known = rows.filter((r) => r.inBase != null);
  const assets = known.filter((r) => !isLiability(r.kind)).reduce((n, r) => n + r.inBase, 0);
  const debts = known.filter((r) => isLiability(r.kind)).reduce((n, r) => n + r.inBase, 0);
  const total = assets - debts;
  const byCurrency = {};
  for (const r of rows) {
    byCurrency[r.currency] = byCurrency[r.currency] || { currency: r.currency, raw: 0, inBase: 0, converted: true };
    byCurrency[r.currency].raw += isLiability(r.kind) ? -r.value : r.value;
    if (r.inBase == null) byCurrency[r.currency].converted = false;
    else byCurrency[r.currency].inBase += r.signed;
  }
  return {
    rows, total, base, assets, debts,
    byKind: ACCOUNT_KINDS.map((k) => ({
      kind: k,
      inBase: known.filter((r) => r.kind === k).reduce((n, r) => n + r.inBase, 0),
    })).filter((x) => x.inBase > 0),
    byCurrency: Object.values(byCurrency),
    unconverted: rows.filter((r) => r.inBase == null).map((r) => `${r.label || r.kind} (${r.currency})`),
    // How much of the whole is exposed to one currency. For a household with most of its net
    // worth in a currency it does not spend, this is the number that matters most.
    exposure: Object.values(byCurrency)
      .filter((c) => c.converted && total > 0 && c.inBase > 0)
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
    let currency = base;
    if (words.length && isKnownCurrency(words[0])) currency = words.shift().toUpperCase();
    // A rate can sit anywhere in what is left — "20%", "20 %", "at 20%". Pulled out rather
    // than positional, because nobody remembers a field order.
    let ratePct = null;
    const keep = [];
    for (const w of words) {
      const m = w.match(/^([\d]+(?:[.,]\d+)?)%$/);
      if (m && ratePct == null) { ratePct = Number(m[1].replace(',', '.')); continue; }
      if (/^(at|@)$/i.test(w)) continue;
      keep.push(w);
    }
    return { currency, ratePct, rest: keep.join(' ') };
  };

  if (acct) {
    const kind = acct[1].toLowerCase();
    if (!ACCOUNT_KINDS.includes(kind)) return { type: 'account', badKind: kind };
    const amount = amountOf(acct[2]);
    const { currency, ratePct, rest } = split(acct[3]);
    if (amount == null) return null;
    return { type: 'account', kind, value: amount, currency, ratePct, label: rest || kind };
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

// ---- What the rates actually do ----
//
// He has deposits paying a percentage and credits costing one. Two questions follow, and both
// are arithmetic, so neither is left to be felt.

/** Interest earned and interest paid, per year, in the base currency. */
export function interestPicture(accounts, table, base = 'EUR') {
  const rows = accounts
    .filter((a) => a.ratePct != null && a.value > 0)
    .map((a) => {
      const inBase = toBase(a.value, a.currency, table);
      const annualLocal = a.value * (a.ratePct / 100);
      return {
        ...a,
        inBase,
        annualLocal,
        annualBase: inBase == null ? null : inBase * (a.ratePct / 100),
        liability: isLiability(a.kind),
      };
    });
  const known = rows.filter((r) => r.annualBase != null);
  const earned = known.filter((r) => !r.liability).reduce((n, r) => n + r.annualBase, 0);
  const paid = known.filter((r) => r.liability).reduce((n, r) => n + r.annualBase, 0);
  return {
    base, rows, earned, paid,
    net: earned - paid,
    unconverted: rows.filter((r) => r.annualBase == null).map((r) => `${r.label || r.kind} (${r.currency})`),
  };
}

/** THE QUESTION ANYONE WITH BOTH A LOAN AND A PORTFOLIO SHOULD ASK FIRST.
 *
 *  Paying 20% on a credit while expecting 7% from investing is a guaranteed 13% loss on every
 *  euro that goes into the market instead of into the debt. Clearing the loan is a risk-free
 *  return equal to its rate — the only risk-free return anyone is ever offered — and it beats
 *  any yield he could chase. This is the single most valuable thing this app can tell him, and
 *  it needs no model at all.
 *
 *  The comparison is honest about currency: a loan in EGP at 20% is not really costing 20% to a
 *  euro household if the pound is falling, so where a rate history is known the real cost is
 *  used instead of the headline. */
export function debtVsInvesting(accounts, { expectedYieldPct = 5, rateThen, rateNow } = {}) {
  const loans = accounts.filter((a) => isLiability(a.kind) && a.ratePct != null && a.value > 0);
  return loans.map((l) => {
    // Devaluation erodes a foreign-currency debt in the borrower's favour, exactly as it erodes
    // a deposit against him. Same arithmetic, opposite sign.
    const real = rateThen && rateNow ? realReturn({ nominalPct: l.ratePct, rateThen, rateNow }) : null;
    const effectiveCost = real ? real.realPct : l.ratePct;
    const edge = effectiveCost - expectedYieldPct;
    return {
      label: l.label || l.kind,
      currency: l.currency,
      ratePct: l.ratePct,
      effectiveCostPct: effectiveCost,
      expectedYieldPct,
      edge,
      // Positive edge means the debt costs more than investing is expected to pay.
      payFirst: edge > 0,
    };
  }).sort((a, b) => b.edge - a.edge);
}

// ---- Looking years ahead ----
//
// "Show me ten years, and let me say that something changes in year three."
//
// This is the same arithmetic as the eToro challenge he was shown, and the difference is
// entirely in the presentation. That document quoted 2053 to the dollar off ONE optimistic
// yield and called it a plan. The honest version runs the same maths across a spread of
// yields, prints its assumptions beside every figure, and never produces a single number that
// could be mistaken for a promise.
//
// The most important property: an error in the yield COMPOUNDS. Over ten years the gap between
// 3.5% and 7% is not a detail, it is most of the answer — which is exactly why one line is a
// lie and a range is not.

export const EVENT_KINDS = ['contribution', 'lump', 'income', 'spending'];

export function cleanEvent(e) {
  return {
    id: txt(e?.id, 32) || Date.now().toString(36),
    // Which year of the plan it takes effect. Year 1 is the next twelve months.
    atYear: Math.max(1, Math.min(60, Math.round(num(e?.atYear)) || 1)),
    kind: EVENT_KINDS.includes(e?.kind) ? e.kind : 'contribution',
    // A monthly figure for contribution/income/spending; a one-off total for a lump.
    amount: num(e?.amount),
    label: txt(e?.label, 80),
  };
}

/** Year-by-year, from what he saves now and whatever he says will change.
 *
 *  `monthlySurplus` is what he actually saved — measured, not hoped for. Events adjust it from
 *  a given year: a raise, a second rental, a child, a mortgage ending. Nothing is inferred;
 *  if he does not say something changes, nothing does, and the flat line is the honest default.
 */
export function forecast({
  startCapital = 0,
  monthlySurplus = 0,
  monthlyPassiveNow = 0,
  years = 10,
  yieldPct = 5,
  events = [],
  goalMonthly = 0,
} = {}) {
  const n = Math.max(1, Math.min(60, Math.round(num(years)) || 10));
  const y = num(yieldPct) / 100;
  const evts = (Array.isArray(events) ? events : []).map(cleanEvent);

  let capital = Math.max(0, num(startCapital));
  let contribution = num(monthlySurplus);
  let extraIncome = 0;     // passive income from events, on top of what the capital yields
  let extraSpending = 0;
  const rows = [];

  for (let year = 1; year <= n; year++) {
    // Events land at the START of their year, so year 3 means "from year three onwards".
    for (const e of evts.filter((x) => x.atYear === year)) {
      if (e.kind === 'contribution') contribution += e.amount;
      else if (e.kind === 'income') { extraIncome += e.amount; contribution += e.amount; }
      else if (e.kind === 'spending') { extraSpending += e.amount; contribution -= e.amount; }
      else if (e.kind === 'lump') capital += e.amount;
    }
    // Contributions through the year, then growth. Deliberately not the other way round: it
    // credits a full year of return to money that arrived in December.
    const added = Math.max(0, contribution) * 12;
    capital = capital * (1 + y) + added;
    const passive = (capital * y) / 12 + extraIncome + monthlyPassiveNow;
    rows.push({
      year,
      capital,
      contributedThisYear: added,
      monthlyContribution: contribution,
      passiveMonthly: passive,
      extraSpending,
      goalMet: goalMonthly > 0 ? passive >= goalMonthly : null,
      events: evts.filter((x) => x.atYear === year).map((x) => x.label || x.kind),
    });
  }

  const hit = rows.find((r) => r.goalMet);
  return {
    rows,
    yieldPct: num(yieldPct),
    endCapital: rows[rows.length - 1].capital,
    endPassive: rows[rows.length - 1].passiveMonthly,
    goalReachedInYear: hit ? hit.year : null,
    // Travels with every figure this produces, wherever it is printed.
    assumes: 'the yield holds every year, contributions continue, no tax, no inflation, no bad year',
  };
}

/** The same ten years at three yields, because the spread between them IS the uncertainty.
 *  Anyone shown one line will believe it; three lines cannot be mistaken for a forecast. */
export function forecastRange(opts = {}, yields = [3.5, 5, 7]) {
  const runs = yields.map((yieldPct) => forecast({ ...opts, yieldPct }));
  return {
    runs,
    years: runs[0].rows.length,
    low: runs[0],
    mid: runs[Math.floor(runs.length / 2)],
    high: runs[runs.length - 1],
    // How far apart the optimistic and pessimistic answers are at the end. On a ten-year view
    // this is usually large, and seeing it is the point.
    spreadAtEnd: runs[runs.length - 1].endCapital - runs[0].endCapital,
    assumes: runs[0].assumes,
  };
}
