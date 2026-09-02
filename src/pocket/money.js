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

// How often a rate is actually PAID OUT, which is a different question from what the rate is.
// A deposit paying 20% monthly hands over money twelve times a year; the same 20% "at maturity"
// hands over nothing until the last day. Same headline, completely different household. The
// same applies in reverse to a loan: quarterly means four bills a year, not twelve.
// `maturity` is the honest name for "all of it at the end" — it is not a frequency, so it is
// listed here rather than being expressed as a period in months.
export const PAYOUT_KINDS = ['monthly', 'quarterly', 'yearly', 'maturity'];
export const PAYOUT_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

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
    // A fixed-term deposit is defined by its dates as much as its rate: an Egyptian
    // certificate is "20% for three years from May 2024", and without the term nothing can say
    // what has been earned so far or what is still to come.
    startsAt: a?.startsAt == null ? null : num(a.startsAt) || null,
    endsAt: a?.endsAt == null ? null : num(a.endsAt) || null,
    // Null means he has not said, and null is shown as "not said" rather than being defaulted
    // to a frequency. Assuming monthly on a certificate that pays at maturity would invent
    // twelve payments a year that never arrive.
    payout: PAYOUT_KINDS.includes(a?.payout) ? a.payout : null,
    // What actually leaves or arrives each period, off his own statement. It OVERRIDES every
    // derived figure, because a bank's number beats an app's arithmetic every time: his car
    // loan bills 58,063.45 a quarter, the best model here says 60,461, and the model is the one
    // that is wrong. Null means he has not said, and then it is derived and labelled as such.
    payment: a?.payment == null ? null : Math.max(0, num(a.payment)) || null,
    note: txt(a?.note, 300),
    at: num(a?.at) || Date.now(),
  };
}

/** A date the way he writes it. Dotted and slashed forms are read DAY FIRST — 28.05.2024 is
 *  28 May, the European reading, which is how he typed it. ISO (2024-05-28) is unambiguous and
 *  read as itself. Anything else is null rather than a guess: a misread date silently shifts
 *  every interest figure that depends on it. */
export function parseDate(raw) {
  const s = String(raw || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }
  if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) {
    const day = +m[1], month = +m[2];
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return Date.UTC(+m[3], month - 1, day);
  }
  return null;
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
    // Which subscription this charge belongs to, when it came from one. It keeps the Subs tab
    // and the Month tab telling the same story — and it is why a subscription charge is not
    // also flagged `recurring`: the subscription IS the recurring record, and having both would
    // put the same bill in two "you have not entered this yet" lists.
    subId: txt(f?.subId, 32) || null,
    // Passive is set explicitly, but a category that is obviously passive defaults to true so
    // he does not have to remember a flag for the thing the whole goal is about.
    passive: f?.passive == null ? PASSIVE_KINDS.includes(category) : !!f.passive,
    note: txt(f?.note, 300),
  };
}

/** WHAT IS OWED TODAY, which is not what was borrowed.
 *
 *  He entered a 445,000 EGP car loan and the app went on subtracting 445,000 from his net worth
 *  while he was seven payments of ten through repaying it. Every instalment he had already made
 *  was invisible — the debt never moved, so paying it down looked like nothing happening.
 *
 *  For a liability with a term and a schedule, what he still owes is the PAYOFF: the present
 *  value of the payments still to come, discounted at the loan's own rate. Not the sum of them
 *  — that includes interest for years he has not reached yet, and settling tomorrow would not
 *  cost that. Everything else keeps the figure he typed, which is right for a credit-card
 *  balance, a deposit, a flat and a bank account alike.
 */
export function balanceNow(a, now = Date.now()) {
  const entered = Math.max(0, num(a?.value));
  if (!isLiability(a?.kind)) return { amount: entered, entered, settled: false, repaid: 0 };
  const t = depositProgress(a, now);
  const s = t?.schedule;
  if (!t?.hasTerm || !s || !s.total) return { amount: entered, entered, settled: false, repaid: 0 };
  const left = Math.max(0, s.total - s.made);
  if (left === 0) return { amount: 0, entered, settled: true, repaid: entered, paymentsLeft: 0 };

  // Discounted at the loan's OWN rate — the one its payments imply when he has stated them,
  // and only otherwise the headline. Mixing the two (his instalment against the paperwork's
  // rate) is two different loans, and it does not even return the principal on day one.
  const r = t.implied
    ? t.implied.perPeriodPct / 100
    : (s.every && entered > 0 && t.perYear ? (t.perYear / entered) * (s.every / 12) : 0);
  const owed = r > 0
    ? (s.perPayment * (1 - Math.pow(1 + r, -left))) / r
    : s.perPayment * left;
  // Never more than was borrowed: a payoff above the original principal would mean the app had
  // invented debt, and that is the direction a money app must never be wrong in.
  const amount = Math.min(entered, owed);
  return { amount, entered, settled: false, repaid: Math.max(0, entered - amount), paymentsLeft: left };
}

/** Everything he owns, in one currency. Anything without a rate is EXCLUDED from the total and
 *  named — a net worth that quietly omits the Egyptian apartment is worse than no total. */
export function netWorth(accounts, table, base = 'EUR', now = Date.now()) {
  const rows = accounts.map((a) => {
    // A part-repaid loan counts for what is left of it, not for what it started as.
    const bal = balanceNow(a, now);
    const inBase = toBase(bal.amount, a.currency, table);
    // Signed once, here, so every consumer below adds and nothing has to remember the rule.
    return { ...a, owedNow: bal.amount, repaid: bal.repaid, inBase, signed: inBase == null ? null : (isLiability(a.kind) ? -inBase : inBase) };
  });
  const known = rows.filter((r) => r.inBase != null);
  const assets = known.filter((r) => !isLiability(r.kind)).reduce((n, r) => n + r.inBase, 0);
  const debts = known.filter((r) => isLiability(r.kind)).reduce((n, r) => n + r.inBase, 0);
  const total = assets - debts;
  const byCurrency = {};
  for (const r of rows) {
    byCurrency[r.currency] = byCurrency[r.currency] || { currency: r.currency, raw: 0, inBase: 0, converted: true };
    byCurrency[r.currency].raw += isLiability(r.kind) ? -r.owedNow : r.owedNow;
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
  // "sub 12.99 EUR monthly netflix" — its own shape, because a subscription is not a spend that
  // happened, it is a spend that will keep happening until someone stops it.
  const sub = s.match(/^\/?subs?\s+[-+]?\s*(\d[\d\s.,]*)\s*(.*)$/i);
  if (!flow && !acct && !sub) return null;

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
  //
  // `payouts` is off for a flow on purpose. This helper is shared by both shapes, and a spend
  // is allowed to be called "monthly gym" — swallowing that word as a payout frequency would
  // quietly rename the category to "gym".
  const split = (rest, { payouts = false, periods = false } = {}) => {
    const words = String(rest || '').trim().split(/\s+/).filter(Boolean);
    let currency = base;
    if (words.length && isKnownCurrency(words[0])) currency = words.shift().toUpperCase();
    // A rate can sit anywhere in what is left — "20%", "20 %", "at 20%". Pulled out rather
    // than positional, because nobody remembers a field order.
    let ratePct = null;
    let startsAt = null, endsAt = null, payout = null, payment = null, every = null;
    const keep = [];
    // "start 28.05.2024 end 28.05.2027" — the keyword claims the date that follows it, and
    // BOTH are removed from what is left, so neither ends up in the label. A bare date with no
    // keyword is left alone: guessing whether it opens or closes a term is how a three-year
    // certificate silently becomes a one-day one.
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const pct = w.match(/^([\d]+(?:[.,]\d+)?)%$/);
      if (pct && ratePct == null) { ratePct = Number(pct[1].replace(',', '.')); continue; }
      if (/^(at|@|for)$/i.test(w)) continue;
      if (/^(start|from|opened)$/i.test(w) && parseDate(words[i + 1])) { startsAt = parseDate(words[++i]); continue; }
      if (/^(end|to|until|matures?|ends)$/i.test(w) && parseDate(words[i + 1])) { endsAt = parseDate(words[++i]); continue; }
      if (payouts && payout == null && PAYOUT_KINDS.includes(w.toLowerCase())) { payout = w.toLowerCase(); continue; }
      // "pays 58063.45" — the real instalment, claimed the same way a date is.
      if (payouts && payment == null && /^(pays?|payment|instal?ment|bill)$/i.test(w) && words[i + 1] != null) {
        const n = Number(String(words[i + 1]).replace(/\s/g, '').replace(',', '.'));
        if (Number.isFinite(n) && n > 0) { payment = n; i++; continue; }
      }
      // His own word for it, because the app should read what he types and not what a form
      // expects: he says "kvartally", and a line he has to retype is a line he stops typing.
      if (payouts && payout == null && /^kvartal(ly|ny)?$/i.test(w)) { payout = 'quarterly'; continue; }
      if (periods && every == null && BILLING_PERIODS.includes(w.toLowerCase())) { every = w.toLowerCase(); continue; }
      if (periods && every == null && /^(annually?|yearly|per\s*year|\/year|\/yr)$/i.test(w)) { every = 'yearly'; continue; }
      if (periods && every == null && /^kvartal(ly|ny)?$/i.test(w)) { every = 'quarterly'; continue; }
      keep.push(w);
    }
    return { currency, ratePct, startsAt, endsAt, payout, payment, every, rest: keep.join(' ') };
  };

  if (sub) {
    const amount = amountOf(sub[1]);
    if (amount == null) return null;
    const { currency, startsAt, endsAt, every, rest } = split(sub[2], { periods: true });
    return {
      type: 'sub', amount, currency,
      every: every || 'monthly',
      startsAt, endsAt,
      label: rest || 'subscription',
    };
  }

  if (acct) {
    const kind = acct[1].toLowerCase();
    if (!ACCOUNT_KINDS.includes(kind)) return { type: 'account', badKind: kind };
    const amount = amountOf(acct[2]);
    const { currency, ratePct, startsAt, endsAt, payout, payment, rest } = split(acct[3], { payouts: true });
    if (amount == null) return null;
    return { type: 'account', kind, value: amount, currency, ratePct, startsAt, endsAt, payout, payment, label: rest || kind };
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

/** Interest earned and interest paid, per year, in the base currency.
 *
 *  A term that has ENDED earns nothing. Before dates existed this file could not know that, and
 *  a certificate that matured in 2021 went on reporting 10,000 a year for ever — money added to
 *  a household's picture of itself that stopped arriving five years ago. A term that has not
 *  STARTED yet is the same mistake in the other direction. Both are excluded here and named, so
 *  the total is what is running today. */
export function interestPicture(accounts, table, base = 'EUR', now = Date.now()) {
  const running = (a) => !(a.endsAt && now >= a.endsAt) && !(a.startsAt && now < a.startsAt);
  const rows = accounts
    .filter((a) => a.ratePct != null && a.value > 0 && running(a))
    .map((a) => {
      // On what is OWED today, not on what was borrowed. A loan seven payments from the end is
      // not still costing a full year's interest on its opening balance.
      const base_ = balanceNow(a, now).amount;
      const inBase = toBase(base_, a.currency, table);
      const annualLocal = base_ * (a.ratePct / 100);
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
    // Named rather than silently dropped: "this deposit is not in the total, and here is why"
    // is information; a smaller number with no explanation is just a number he cannot check.
    ended: accounts.filter((a) => a.ratePct != null && a.endsAt && now >= a.endsAt).map((a) => a.label || a.kind),
    notStarted: accounts.filter((a) => a.ratePct != null && a.startsAt && now < a.startsAt).map((a) => a.label || a.kind),
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
export function debtVsInvesting(accounts, { expectedYieldPct = 5, rateThen, rateNow, now = Date.now() } = {}) {
  const loans = accounts.filter((a) => isLiability(a.kind) && a.ratePct != null && a.value > 0);
  return loans.map((l) => {
    // What it ACTUALLY costs, when he has told the app what he actually pays. A car loan quoted
    // at 24% whose instalments imply 20.6% is a 20.6% loan; comparing the paperwork's number
    // against an expected yield compares the wrong thing.
    const implied = depositProgress(l, now)?.implied || null;
    const headline = implied ? implied.nominalPct : l.ratePct;
    // Devaluation erodes a foreign-currency debt in the borrower's favour, exactly as it erodes
    // a deposit against him. Same arithmetic, opposite sign.
    const real = rateThen && rateNow ? realReturn({ nominalPct: headline, rateThen, rateNow }) : null;
    const effectiveCost = real ? real.realPct : headline;
    const edge = effectiveCost - expectedYieldPct;
    return {
      label: l.label || l.kind,
      currency: l.currency,
      ratePct: l.ratePct,
      impliedPct: implied ? implied.nominalPct : null,
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


// ---- What a fixed-term deposit has actually paid so far ----
//
// "20% for three years from 28.05.2024" is not one number, it is three: what it has earned to
// today, what is still to come, and how far through the term it is. Simple interest on the
// principal, because that is how these certificates pay — a coupon every month or quarter, not
// interest compounding on itself. Compounding it would overstate the return, and overstating a
// return is the one direction this app is not allowed to be wrong in.
const DAY = 86400000;

/** Add whole calendar months, clamping the day so 31 January plus one month is 28 February and
 *  not 3 March. Days-times-30.44 is the version of this that already put a one-year term at
 *  11.99 months, so the arithmetic here is calendar arithmetic throughout. */
export function addMonths(ms, n) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate();
  return Date.UTC(y, m + n, Math.min(day, lastOfTarget));
}

/** How much of a YEAR sits between two dates, measured on the calendar.
 *
 *  Not (days / 365). That reads a one-year certificate opened on 1 January 2020 as 366/365 of a
 *  year and pays 10,027 on a round 10,000 — a number he would rightly not believe, produced by
 *  arithmetic that is quietly wrong on every term spanning a leap day. Whole calendar months
 *  first, then the part-month as a fraction of the month it falls in, so 28.05.2024 → 28.05.2027
 *  is exactly three years and nothing else has to be rounded afterwards. */
export function yearsBetween(from, to) {
  if (!(to > from)) return 0;
  let months = 0;
  while (months < 1200 && addMonths(from, months + 1) <= to) months++;
  const anchor = addMonths(from, months);
  const next = addMonths(from, months + 1);
  const frac = next > anchor ? (to - anchor) / (next - anchor) : 0;
  return (months + frac) / 12;
}

/** When the money actually arrives, and how much of it each time.
 *
 *  A 20% deposit is one number; "20% paid quarterly on 495,000 EGP" is 24,750 EGP landing on a
 *  date he can plan around. That difference is the whole reason this exists — an amount with no
 *  date attached to it cannot be spent, budgeted, or waited for. */
export function payoutSchedule({ start, end, payout, perYear, totalAtMaturity, principal = 0, payment = null, amortising = false }, now = Date.now()) {
  if (!payout || !start) return null;
  if (payout === 'maturity') {
    if (!end) return null;
    return {
      payout, every: null, perPayment: payment || totalAtMaturity,
      stated: payment != null,
      made: now >= end ? 1 : 0, total: 1,
      next: now >= end ? null : end,
    };
  }
  const every = PAYOUT_MONTHS[payout];
  if (!every) return null;
  let made = 0, total = 0, next = null;
  // Walked rather than divided, so a clamped month-end date lands where the bank puts it.
  // Bounded because an open-ended holding has no last payment to stop at.
  for (let i = 1; i <= 1200; i++) {
    const at = addMonths(start, i * every);
    if (end && at > end) break;
    total++;
    if (at <= now) made++;
    else if (next == null) next = at;
    if (!end && at > now) break;
  }

  // WHAT ACTUALLY LEAVES THE ACCOUNT EACH TIME, in order of how much it can be trusted.
  //
  //   1. The number he typed off his own statement. Nothing beats it, and nothing overrides it.
  //   2. For a LOAN with no stated payment: the amortising payment — interest AND principal.
  //      Interest alone was simply wrong and showed him about half his real bill: 26,700 EGP a
  //      quarter on a loan he actually pays 58,063.45 on. A loan is repaid, a deposit is not.
  //   3. For a deposit: the coupon, which really is interest only. The principal comes back at
  //      the end, and that is the difference between the two cases.
  const periodRate = perYear && principal ? (perYear / principal) * (every / 12) : 0;
  let perPayment;
  let estimated = false;
  if (payment != null) {
    perPayment = payment;
  } else if (amortising && total > 0 && principal > 0) {
    perPayment = periodRate > 0
      ? (principal * periodRate) / (1 - Math.pow(1 + periodRate, -total))
      : principal / total;
    // Flagged, because an amortisation schedule depends on conventions the app cannot see —
    // fees, day counts, whether the bank charges on the declining balance or a flat sum. It is
    // a good estimate and it must never be presented as his bank's number.
    estimated = true;
  } else {
    perPayment = perYear * (every / 12);
  }

  return {
    payout, every, perPayment, made, total: end ? total : null, next,
    estimated,
    stated: payment != null,
    // Everything the term will move, and what is left of it.
    totalOverTerm: end ? perPayment * total : null,
    paidSoFar: perPayment * made,
    leftToPay: end ? perPayment * (total - made) : null,
  };
}

/** What a stream of payments really costs, whatever the headline says.
 *
 *  Borrow 445,000 and repay 58,063.45 ten times and you have paid 135,634 in interest — which
 *  is 20.6% a year, not the 24% on the paperwork. Solved by bisection rather than a formula
 *  because there is no closed form, and returned as null when the numbers cannot support an
 *  answer instead of a confident zero.
 *
 *  This is the honest counterpart to the deposit question: a 20% rate that pays late is worth
 *  less than 20%, and a 24% loan that is repaid steadily costs less than 24%. Both are the same
 *  arithmetic, and neither is visible from the headline. */
export function impliedRate({ principal, payment, payments, periodsPerYear }) {
  const P = num(principal), pay = num(payment), n = Math.round(num(payments)), k = num(periodsPerYear);
  if (!(P > 0 && pay > 0 && n > 0 && k > 0)) return null;
  if (pay * n <= P) return null;                       // nothing was charged; no rate to find
  const pv = (r) => (r === 0 ? pay * n : (pay * (1 - Math.pow(1 + r, -n))) / r);
  let lo = 0, hi = 1;                                  // 100% per period is far beyond any loan
  if (pv(hi) > P) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > P) lo = mid; else hi = mid;
  }
  const perPeriod = (lo + hi) / 2;
  return {
    perPeriodPct: perPeriod * 100,
    // Nominal is what a bank quotes; effective is what compounding actually does. Both, because
    // the gap between them is exactly the thing a headline rate hides.
    nominalPct: perPeriod * k * 100,
    effectivePct: (Math.pow(1 + perPeriod, k) - 1) * 100,
    totalPaid: pay * n,
    totalInterest: pay * n - P,
  };
}

/** The whole picture for one dated, rate-bearing holding — including, when he has told the app
 *  what he actually pays, what that payment really costs. */
export function depositProgress(a, now = Date.now()) {
  const t = termProgress(a, now);
  if (!t?.schedule || !t.schedule.total || !t.schedule.every) return t;
  return {
    ...t,
    implied: impliedRate({
      principal: a.value,
      payment: t.schedule.perPayment,
      payments: t.schedule.total,
      periodsPerYear: 12 / t.schedule.every,
    }),
  };
}

function termProgress(a, now = Date.now()) {
  if (!a || a.ratePct == null || !(a.value > 0)) return null;
  const start = a.startsAt, end = a.endsAt;
  const perYear = a.value * (a.ratePct / 100);

  // No dates: the yearly figure is all that can honestly be said.
  if (!start) return { perYear, currency: a.currency, hasTerm: false, payout: a.payout || null, schedule: null };

  const upTo = Math.min(now, end ?? now);
  const elapsedDays = Math.max(0, (upTo - start) / DAY);
  const earned = perYear * yearsBetween(start, upTo);

  const liability = isLiability(a.kind);
  const common = { principal: a.value, payment: a.payment ?? null, amortising: liability };

  if (!end) {
    return {
      perYear, currency: a.currency, hasTerm: false, start, elapsedDays, earned, running: true,
      liability, payout: a.payout || null,
      schedule: payoutSchedule({ ...common, start, end: null, payout: a.payout, perYear }, now),
    };
  }

  const termDays = Math.max(1, (end - start) / DAY);
  const termYears = yearsBetween(start, end);
  const totalAtMaturity = perYear * termYears;
  const matured = now >= end;
  return {
    perYear,
    currency: a.currency,
    hasTerm: true,
    start, end,
    liability,
    payout: a.payout || null,
    schedule: payoutSchedule({ ...common, start, end, payout: a.payout, perYear, totalAtMaturity }, now),
    termDays,
    elapsedDays: Math.min(elapsedDays, termDays),
    remainingDays: Math.max(0, (end - now) / DAY),
    termYears,
    pctThrough: Math.min(100, termYears > 0 ? (yearsBetween(start, upTo) / termYears) * 100 : 100),
    earned,
    remaining: Math.max(0, totalAtMaturity - earned),
    totalAtMaturity,
    // What he gets back on the day it ends, principal included.
    valueAtMaturity: a.value + totalAtMaturity,
    matured,
  };
}

/** Every dated holding at once, for a "what have I actually earned" line. */
export function depositsSummary(accounts, now = Date.now()) {
  const rows = accounts
    .map((a) => ({ account: a, progress: depositProgress(a, now) }))
    .filter((r) => r.progress);
  return {
    rows,
    // In each holding's OWN currency; converting is the caller's job, with a real rate.
    anyTerms: rows.some((r) => r.progress.hasTerm),
    maturingSoon: rows.filter((r) => r.progress.hasTerm && !r.progress.matured && r.progress.remainingDays <= 90),
    matured: rows.filter((r) => r.progress.matured),
  };
}


// ---- Months, so a year is a thing you can look back through ----
//
// A tracker that only knows "this month" cannot answer the question anyone actually has, which
// is "is this month normal?". One month is a number; twelve months is a shape — and the shape
// is what tells him the November he thinks was expensive was in fact the third one in a row.
//
// Keys are 'YYYY-MM' and windows are UTC, the same basis the rest of the app uses. No month
// NAME is produced here: naming a month is a locale decision and belongs where the locale is
// known, which is the browser.

export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The window a key covers. An unparseable key falls back to the month containing `now` rather
 *  than to epoch zero — a bad key must never silently select "everything since 1970". */
export function monthWindowOf(key, now = Date.now()) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(key || ''));
  const d = new Date(now);
  const year = m ? +m[1] : d.getUTCFullYear();
  const month = m ? +m[2] - 1 : d.getUTCMonth();
  if (!(month >= 0 && month <= 11)) return monthWindowOf(null, now);
  const from = Date.UTC(year, month, 1);
  return { key: monthKey(from), from, to: Date.UTC(year, month + 1, 1) - 1 };
}

/** The last `count` months ending with the one containing `now`, oldest first. */
export function recentMonths(count = 12, now = Date.now()) {
  const d = new Date(now);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(monthWindowOf(monthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)), now));
  }
  return out;
}

/** In, out and what was left, month by month — the strip along the top of the app.
 *
 *  Every month asked for is returned, including empty ones. A gap silently dropped from the
 *  list reads as a month that did not happen, when what it means is a month nothing was
 *  recorded in, and those are opposite messages. */
export function monthsSummary(flows, table, base = 'EUR', { count = 12, now = Date.now() } = {}) {
  return recentMonths(count, now).map((w) => {
    const m = monthOf(flows, table, base, w);
    return {
      key: w.key,
      from: w.from,
      income: m.income,
      spending: m.spending,
      surplus: m.surplus,
      passive: m.passive,
      entries: flows.filter((f) => f.ts >= w.from && f.ts <= w.to).length,
    };
  });
}

// ---- Editing something already recorded ----
//
// The one-line grammar is the fastest way to record and a hopeless way to CORRECT: retyping the
// whole line to fix a typo in an amount risks a second entry rather than a fix. So an edit is a
// patch of named fields, and this is the whitelist that decides which names exist.
//
// It is a whitelist for the reason CLAUDE.md gives — an unknown key must never reach storage —
// but with the opposite default to `saveBooks`: a key that is ABSENT means "not being changed"
// and the stored value survives. Only a key present here is touched.

export function patchFrom(kind, raw = {}) {
  const out = {};
  const given = (k) => raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '';
  const amount = (v) => {
    const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? Math.abs(n) : null;
  };

  if (kind === 'flow') {
    if (given('category')) out.category = String(raw.category);
    if (given('amount')) { const n = amount(raw.amount); if (n != null) out.amount = n; }
    if (given('currency')) out.currency = String(raw.currency);
    if (raw.dir === 'in' || raw.dir === 'out') out.dir = raw.dir;
    if (given('date')) { const t = parseDate(raw.date); if (t != null) out.ts = t; }
    // Booleans are the one case where false must get through, so they are read from presence of
    // the key rather than from truthiness of the value.
    if (raw.passive !== undefined) out.passive = !!raw.passive;
    if (raw.recurring !== undefined) out.recurring = !!raw.recurring;
    return out;
  }

  if (kind === 'sub') {
    if (given('label')) out.label = String(raw.label);
    if (given('amount')) { const n = amount(raw.amount); if (n != null) out.amount = n; }
    if (given('currency')) out.currency = String(raw.currency);
    if (given('every') && BILLING_PERIODS.includes(raw.every)) out.every = raw.every;
    if (given('category')) out.category = String(raw.category);
    for (const k of ['startsAt', 'endsAt', 'trialEndsAt']) {
      if (raw[k] !== undefined) out[k] = raw[k] === '' ? null : parseDate(raw[k]);
    }
    return out;
  }

  if (given('label')) out.label = String(raw.label);
  if (given('kind') && ACCOUNT_KINDS.includes(raw.kind)) out.kind = raw.kind;
  if (given('value')) { const n = amount(raw.value); if (n != null) out.value = n; }
  if (given('currency')) out.currency = String(raw.currency);
  // A rate can be cleared back to "it does not pay one", so an empty string is meaningful here
  // and is the one place `given()` is deliberately not used.
  if (raw.ratePct !== undefined) {
    const n = raw.ratePct === '' || raw.ratePct === null ? null : Number(String(raw.ratePct).replace(',', '.'));
    out.ratePct = n == null || !Number.isFinite(n) ? null : n;
  }
  if (raw.startsAt !== undefined) out.startsAt = raw.startsAt === '' ? null : parseDate(raw.startsAt);
  if (raw.endsAt !== undefined) out.endsAt = raw.endsAt === '' ? null : parseDate(raw.endsAt);
  if (raw.payout !== undefined) out.payout = PAYOUT_KINDS.includes(raw.payout) ? raw.payout : null;
  if (raw.payment !== undefined) {
    const n = raw.payment === '' || raw.payment === null ? null : amount(raw.payment);
    out.payment = n || null;
  }
  return out;
}


/** Money already CONTRACTED to arrive, which is not the same thing as money that has arrived.
 *
 *  The goal counts what actually LANDED this month, and it should: a promise is not income. But
 *  a household with a certificate paying quarterly does know some of next year already, and
 *  showing zero passive income beside a deposit that pays 24,750 EGP every three months reads
 *  as the app not knowing about the deposit.
 *
 *  So this is reported SEPARATELY and never added to the measured figure. Instalments come back
 *  as a per-year rate; a lump at maturity comes back as an amount and a date, because averaging
 *  it across the months would invent a monthly income that does not exist.
 *  Amounts stay in their own currency — summing across currencies is the caller's job, with a
 *  real rate, or not at all. */
export function contractedIncome(accounts, now = Date.now()) {
  const streams = [], lumps = [];
  for (const a of accounts) {
    const t = depositProgress(a, now);
    if (!t || !t.schedule || t.matured) continue;
    const row = {
      label: a.label || a.kind,
      currency: a.currency,
      liability: isLiability(a.kind),
      payout: t.schedule.payout,
      perPayment: t.schedule.perPayment,
      next: t.schedule.next,
    };
    if (t.schedule.payout === 'maturity') lumps.push({ ...row, at: t.end, includesPrincipal: true, total: t.valueAtMaturity });
    else streams.push({ ...row, perYear: t.perYear });
  }
  return { streams, lumps };
}


/** What repeats every month and has not been entered again yet.
 *
 *  Salary and the Cairo rent arrive whether or not he types them, and a month missing its
 *  salary does not read as "I forgot" — it reads as a household that earned nothing, with a
 *  surplus to match. Nothing is added to any total here: this is a list of things to confirm,
 *  because inventing income he has not received is the one thing worse than omitting it.
 *
 *  A template is the most recent recurring flow of the same direction, name and currency from
 *  BEFORE the month being read. Matching on all three matters: rent paid in EGP and rent paid
 *  in EUR are different obligations that happen to share a word.
 */
export function missingRecurring(flows, { from, to } = {}) {
  const key = (f) => `${f.dir}|${f.category}|${f.currency}`;
  const already = new Set(flows.filter((f) => f.ts >= from && f.ts <= to).map(key));
  const templates = new Map();
  for (const f of flows) {
    if (!f.recurring || f.ts >= from) continue;
    const k = key(f);
    const prev = templates.get(k);
    if (!prev || f.ts > prev.ts) templates.set(k, f);
  }
  return [...templates.values()]
    .filter((f) => !already.has(key(f)))
    .map((f) => ({
      dir: f.dir, category: f.category, amount: f.amount, currency: f.currency,
      passive: f.passive, lastSeen: f.ts,
      // The day of the month it usually lands on, so a confirmation is dated like the real one.
      day: new Date(f.ts).getUTCDate(),
    }))
    .sort((a, b) => (a.dir === b.dir ? a.category.localeCompare(b.category) : a.dir === 'in' ? -1 : 1));
}


// ---- Subscriptions ----
//
// The only category of spending nobody decides to make twice. A subscription is agreed once and
// then charges for ever, which is why it belongs here as a THING and not as a spend recorded
// after the fact: what matters about Netflix is not the €12.99 that left last Tuesday, it is
// that €155.88 a year is committed until someone actively stops it.
//
// Two numbers this exists to produce, and neither is visible from a list of charges:
//
//   1. THE NORMALISED COST. A subscription billed yearly and one billed monthly cannot be
//      compared until both are per year. €90 a year is cheaper than €9 a month and it does not
//      look it.
//   2. WHAT IT COSTS IN CAPITAL. A bill that never ends has to be funded by capital that never
//      ends. €200 a month of subscriptions is €2,400 a year, which at a sustainable withdrawal
//      needs somewhere between €34,000 and €69,000 of capital behind it — money he has to build
//      before the goal is real. Cancelling one is the same as saving years of contributions, and
//      no expense tracker ever says so.

export const BILLING_PERIODS = ['weekly', 'monthly', 'quarterly', 'yearly'];
const PERIOD_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
const WEEK = 7 * DAY;

export function cleanSub(s) {
  return {
    id: txt(s?.id, 32) || Date.now().toString(36),
    label: txt(s?.label, 80) || 'subscription',
    amount: Math.max(0, num(s?.amount)),
    currency: cleanCurrency(s?.currency) || 'EUR',
    every: BILLING_PERIODS.includes(s?.every) ? s.every : 'monthly',
    // When it started charging. Defaults to now so a subscription added today has a next date
    // without him having to remember when he signed up.
    startsAt: s?.startsAt == null ? null : num(s.startsAt) || null,
    // When it stops. Set this the day he cancels — a cancelled subscription that still bills
    // until March is money he owes, and deleting the row loses that.
    endsAt: s?.endsAt == null ? null : num(s.endsAt) || null,
    // Free until this date, then it charges. This is how subscriptions actually cost people
    // money: not by being expensive, by starting.
    trialEndsAt: s?.trialEndsAt == null ? null : num(s.trialEndsAt) || null,
    category: txt(s?.category, 40).toLowerCase() || 'subscriptions',
    note: txt(s?.note, 300),
    at: num(s?.at) || Date.now(),
  };
}

/** What it costs in a year, in its own currency.
 *
 *  Weekly is 52 times, not 4 × 12. Treating a week as a quarter of a month understates a weekly
 *  bill by 8% — which is small enough to look right and wrong every single time. */
export function subPerYear(s) {
  if (!s || !(s.amount > 0)) return 0;
  if (s.every === 'weekly') return s.amount * 52;
  const months = PERIOD_MONTHS[s.every] || 1;
  return s.amount * (12 / months);
}

/** The next time it charges, walking the calendar from the day it started.
 *
 *  Null when it has ended, or when the trial has not run out yet — a free trial is not a charge,
 *  and counting one as due would put money in the next-seven-days list that nobody will take. */
export function nextCharge(s, now = Date.now()) {
  if (!s || !(s.amount > 0)) return null;
  const start = s.startsAt || s.at || now;
  if (s.endsAt && now >= s.endsAt) return null;
  // A trial pushes the first real charge out to the day it expires.
  const first = s.trialEndsAt && s.trialEndsAt > start ? s.trialEndsAt : start;
  if (now < first) return s.endsAt && first > s.endsAt ? null : first;

  let at;
  if (s.every === 'weekly') {
    const periods = Math.floor((now - first) / WEEK) + 1;
    at = first + periods * WEEK;
  } else {
    const step = PERIOD_MONTHS[s.every] || 1;
    let i = 1;
    while (i < 2400 && addMonths(first, i * step) <= now) i++;
    at = addMonths(first, i * step);
  }
  return s.endsAt && at > s.endsAt ? null : at;
}

/** Everything at once, in one currency, with the two lines that make it worth having.
 *
 *  Anything without a rate is excluded from the totals and named, exactly as everywhere else —
 *  a subscription bill that quietly drops the one billed in dollars is worse than no bill. */
export function subsSummary(subs, table, base = 'EUR', now = Date.now()) {
  const rows = (subs || []).map((s) => {
    const perYear = subPerYear(s);
    const next = nextCharge(s, now);
    const ended = !!(s.endsAt && now >= s.endsAt);
    return {
      ...s,
      perYear,
      perMonth: perYear / 12,
      next,
      ended,
      // Still inside a free trial: costing nothing yet, and about to cost something.
      inTrial: !!(s.trialEndsAt && now < s.trialEndsAt),
      perYearInBase: toBase(perYear, s.currency, table),
      amountInBase: toBase(s.amount, s.currency, table),
    };
  });
  // A subscription that has ended is history, not a bill. It stays in the list, greyed, so
  // cancelling something shows up as an act rather than as a row disappearing.
  const live = rows.filter((r) => !r.ended);
  const known = live.filter((r) => r.perYearInBase != null);
  const perYear = known.reduce((n, r) => n + r.perYearInBase, 0);

  return {
    base,
    rows: rows.sort((a, b) => (a.ended === b.ended ? (b.perYearInBase || 0) - (a.perYearInBase || 0) : a.ended ? 1 : -1)),
    count: live.length,
    perYear,
    perMonth: perYear / 12,
    // The next fortnight, so a charge is never a surprise.
    dueSoon: live.filter((r) => r.next && r.next - now <= 14 * DAY).sort((a, b) => a.next - b.next),
    trials: live.filter((r) => r.inTrial).sort((a, b) => a.trialEndsAt - b.trialEndsAt),
    ended: rows.filter((r) => r.ended),
    unconverted: live.filter((r) => r.perYearInBase == null).map((r) => `${r.label} (${r.currency})`),
    // What a bill that never ends costs in capital that never ends. A range, at the same yields
    // the goal uses, because one number here would be a promise about the next thirty years.
    capitalNeeded: perYear > 0 ? [0.035, 0.07].map((y) => ({ yieldPct: y * 100, capital: perYear / y })) : [],
  };
}
