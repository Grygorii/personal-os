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

/** An id that is unique even twice in the same millisecond.
 *
 *  `Date.now().toString(36)` is not: fifty of them made back to back are one id fifty times. With
 *  a unique index on flows, accounts and subs that is either a 500 he sees, or — for an account,
 *  which is saved by upsert on its id — the SECOND one silently overwriting the first. A lost
 *  holding that never reported an error is the worst outcome this file can produce. */
let idSeq = 0;
export const newId = () => `${Date.now().toString(36)}${(idSeq = (idSeq + 1) % 1296).toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

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
// WHAT COMES BACK AT THE END, AND WHAT DOES NOT.
//
// A certificate is redeemed: on the last day the bank hands over the principal and the thing
// ceases to exist. A FLAT IS NOT. Its end date is the end of a tenancy, not of the asset — the
// building is still his the morning after, and nobody pays him 2,032,000 EGP for it.
//
// Treating them alike put "Pays back 2,032,000 EGP at maturity" under his apartment and had the
// app ready to announce, in April 2027, that his flat had matured and the money was sitting idle.
export const REDEEMABLE_KINDS = ['deposit'];
export const isRedeemable = (kind) => REDEEMABLE_KINDS.includes(kind);
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

export function cleanPayment(p) {
  return {
    id: txt(p?.id, 32) || newId(),
    at: num(p?.at) || Date.now(),
    amount: Math.max(0, num(p?.amount)),
    note: txt(p?.note, 120),
  };
}

export function cleanAccount(a) {
  return {
    id: txt(a?.id, 32) || newId(),
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
    // EVERY PAYMENT HE HAS ACTUALLY MADE beyond the schedule: an overpayment, a lump off the
    // principal, an instalment the start date does not account for. A balance derived only from
    // dates says he owes what a borrower who never paid a penny extra would owe — and he has.
    // This is the account's own history, and it is what makes the balance his rather than the
    // schedule's.
    // HOW MANY OF THIS CURRENCY HE GOT FOR ONE EURO WHEN HE GOT IT. 54 EGP to the euro in May
    // 2024, say. Without it the app can convert his money but cannot tell him what holding it
    // has cost or made him — which for a household with 90% of its net worth in a currency it
    // does not spend is the largest single fact about its finances.
    rateThen: a?.rateThen == null || a.rateThen === '' ? null : Math.max(0, num(a.rateThen)) || null,
    payments: (Array.isArray(a?.payments) ? a.payments : []).slice(0, 400)
      .map(cleanPayment).filter((p) => p.amount > 0).sort((x, y) => x.at - y.at),
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
    id: txt(f?.id, 32) || newId(),
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
    // Which scheduled payment this flow IS — "<accountId>:<YYYY-MM-DD>". A recorded flow
    // carrying one replaces the projection for that date, and that single field is all that
    // stands between this and a month counting the same coupon twice.
    schedId: txt(f?.schedId, 64) || null,
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
// Below this, a balance is nought. Float, not judgement: half a cent is far under any real
// residue and far over the 1e-11 that walking a loan leaves behind.
const CENT = 0.005;

export function balanceNow(a, now = Date.now()) {
  const entered = Math.max(0, num(a?.value));
  const pays = (a?.payments || []).filter((p) => p.amount > 0);
  const nil = { amount: entered, entered, settled: false, repaid: 0, extra: 0, extraCount: 0 };
  if (!isLiability(a?.kind)) return nil;

  const t = depositProgress(a, now);
  const s = t?.schedule;

  // No schedule to amortise against, but an overpayment still reduces what is owed. A credit
  // card balance he has been paying down is exactly this case.
  if (!t?.hasTerm || !s || !s.total || !s.every) {
    const extra = pays.filter((p) => p.at <= now).reduce((n, p) => n + p.amount, 0);
    const amount = Math.max(0, entered - extra);
    return { ...nil, amount, settled: amount <= 0 && extra > 0, repaid: entered - amount, extra, extraCount: pays.filter((p) => p.at <= now).length };
  }

  // Discounted at the loan's OWN rate — the one its payments imply when he has stated them, and
  // only otherwise the headline. Mixing the two (his instalment against the paperwork's rate) is
  // two different loans, and it does not even return the principal on day one.
  const r = t.implied
    ? t.implied.perPeriodPct / 100
    : (s.every && entered > 0 && t.perYear ? (t.perYear / entered) * (s.every / 12) : 0);

  // WALKED, NOT DISCOUNTED. Present value gives the right answer for a borrower who paid exactly
  // the schedule and nothing more; it has no way to hear about the 500 he put in last March.
  // Walking the loan period by period does: interest, then the instalment, then whatever else he
  // actually paid that period.
  const dates = [];
  for (let i = 1; i <= 2400; i++) {
    const at = addMonths(s.start, i * s.every);
    if (a.endsAt && at > a.endsAt) break;
    dates.push(at);
  }

  let bal = entered, made = 0, extra = 0, extraCount = 0, pi = 0;
  const sorted = [...pays].sort((x, y) => x.at - y.at);
  let clearedAt = null;
  for (const at of dates) {
    if (at > now) break;
    bal = bal * (1 + r);
    while (pi < sorted.length && sorted[pi].at <= at) {
      bal -= sorted[pi].amount; extra += sorted[pi].amount; extraCount++; pi++;
    }
    bal -= s.perPayment;
    made++;
    // ZERO, WITHIN REASON. Walking ten periods lands on 3.6e-11 rather than 0, and a balance of
    // four hundred-billionths of a pound is still a balance to a `> 0` test — which quietly adds
    // a whole extra instalment to how long the loan has left.
    if (bal <= CENT) { bal = 0; clearedAt = at; break; }
  }
  // Anything paid since the last instalment fell due.
  while (pi < sorted.length && sorted[pi].at <= now) {
    bal = Math.max(0, bal - sorted[pi].amount); extra += sorted[pi].amount; extraCount++; pi++;
    if (bal <= 0 && !clearedAt) clearedAt = sorted[pi - 1].at;
  }

  // Never more than was borrowed: a balance above the original principal would mean the app had
  // invented debt, and that is the direction a money app must never be wrong in.
  const amount = Math.max(0, Math.min(entered, bal));

  // WHAT THE OVERPAYING BOUGHT HIM, which is the thing no lender ever puts on a statement.
  // Keep walking with the instalment alone and see when it hits zero.
  let left = 0;
  if (amount > 0) {
    let b = amount;
    while (left < 2400 && b > CENT) { b = b * (1 + r) - s.perPayment; left++; if (s.perPayment <= b * r) { left = null; break; } }
  }
  const scheduledTotal = s.total;
  const willTake = left == null ? null : made + left;
  const monthsEarly = willTake == null ? null : Math.max(0, (scheduledTotal - willTake) * s.every);
  // Same principal either way, so every euro of difference in what he hands over is interest.
  const totalWithout = s.perPayment * scheduledTotal;
  const totalWith = left == null ? null : s.perPayment * willTake + extra;
  const interestSaved = totalWith == null ? null : Math.max(0, totalWithout - totalWith);

  return {
    amount, entered,
    settled: amount <= 0,
    repaid: Math.max(0, entered - amount),
    paymentsMade: made,
    extra, extraCount,
    clearedAt,
    // Nulls where overpaying has been so large the instalment no longer covers the interest, or
    // so small it never will. Both are real answers and neither is a number.
    monthsEarly, interestSaved,
    paymentsLeft: left,
  };
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

  // WHERE THE PASSIVE INCOME CAME FROM. One total says he is 15% of the way to the goal; the
  // split says whether that 15% is a flat he owns or a certificate that matures in 2027, and
  // those are not the same progress.
  const passiveBy = {};
  for (const f of inWindow.filter((x) => x.dir === 'in' && x.passive)) {
    const v = conv(f);
    if (v == null) continue;
    // `source` is what the app worked out this money IS; `category` is what he called it.
    // Colour follows the source, so "Apt 1" is rent — but the list keeps his name for it.
    const k = f.source || f.category || 'other';
    passiveBy[k] = (passiveBy[k] || 0) + v;
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
    passiveByCategory: Object.entries(passiveBy).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
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
/** How far a currency can fall before a rate paid in it is worth nothing.
 *
 *  A 20% deposit in Egyptian pounds returns nothing at all to a euro household if the pound
 *  loses 1/1.2 of its value — 16.7% — over the same year. Above that it is a loss. This needs no
 *  exchange-rate history and no forecast: it is the bar the currency has to clear, stated so he
 *  can judge it himself. The same arithmetic as realReturn(), solved for zero. */
export function breakEvenFall(nominalPct) {
  const r = num(nominalPct) / 100;
  if (!(r > 0)) return null;
  return (r / (1 + r)) * 100;
}

export function interestPicture(accounts, table, base = 'EUR', now = Date.now()) {
  const running = (a) => !(a.endsAt && now >= a.endsAt) && !(a.startsAt && now < a.startsAt);
  const rows = accounts
    .filter((a) => a.ratePct != null && a.value > 0 && running(a))
    .map((a) => {
      // On what is OWED today, not on what was borrowed. A loan seven payments from the end is
      // not still costing a full year's interest on its opening balance.
      const base_ = balanceNow(a, now).amount;
      const inBase = toBase(base_, a.currency, table);
      const liability = isLiability(a.kind);
      // THE RATE THIS ACCOUNT ACTUALLY CARRIES. For a loan whose instalments he has entered
      // that is the implied rate, not the headline — otherwise this card charges Loan 1 at 24%
      // directly underneath a warning that says it costs 20.6%, and two numbers on one screen
      // disagree about the same loan.
      const implied = liability ? depositProgress(a, now)?.implied : null;
      const ratePct = implied ? implied.nominalPct : a.ratePct;
      const annualLocal = base_ * (ratePct / 100);
      return {
        ...a,
        inBase,
        annualLocal,
        effectiveRatePct: ratePct,
        annualBase: inBase == null ? null : inBase * (ratePct / 100),
        liability,
      };
    });
  const known = rows.filter((r) => r.annualBase != null);
  const earned = known.filter((r) => !r.liability).reduce((n, r) => n + r.annualBase, 0);
  const paid = known.filter((r) => r.liability).reduce((n, r) => n + r.annualBase, 0);

  // WHAT THAT INTEREST IS ACTUALLY WORTH.
  //
  // Nearly all of his is earned in Egyptian pounds and every bill he pays is in euro. A 20%
  // rate is not a 20% return to him; high local rates and devaluation are not two separate
  // facts, the first is largely compensation for the second. The app says this about a single
  // deposit already (realReturn in fx.js) and then prints a confident euro total here as though
  // it were income. So each foreign currency reports the rate it pays on average and how far it
  // has to fall to wipe that out.
  const byCurrency = {};
  for (const r of known.filter((x) => !x.liability && x.currency !== base && x.inBase > 0)) {
    const c = byCurrency[r.currency] || (byCurrency[r.currency] = { currency: r.currency, principalInBase: 0, annualBase: 0 });
    c.principalInBase += r.inBase;
    c.annualBase += r.annualBase;
  }
  const foreign = Object.values(byCurrency).map((c) => {
    // Weighted by money, not by count: a rate on 500,000 matters more than one on 5,000.
    const weightedRatePct = (c.annualBase / c.principalInBase) * 100;
    return { ...c, weightedRatePct, breakEvenFallPct: breakEvenFall(weightedRatePct) };
  }).sort((a, b) => b.annualBase - a.annualBase);

  return {
    base, rows, earned, paid,
    net: earned - paid,
    foreign,
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

// The pieces a plan is BUILT from, in his words:
//
//   "500 from salary"                  → contribution, 500 a month, from year 1
//   "rent from apartment 1"            → income, 450 a month, from year 1
//   "deposit 10000 under 2%"           → lump, 10,000 once, at its OWN 2%
//   "in year 3 another apartment"      → income, from year 3
//
// `contribution` is money he puts in. `income` is money that arrives — it also counts towards
// the passive-income goal, which is the only difference between the two. `spending` is a cost
// that eats into what he can save. `lump` lands once.
//   "the flat, bought for 27,000, that I might sell for 40,000 in year 6"  → asset
//
// An `asset` is a thing he OWNS, not money in a pot: it joins the capital and, unless he says
// otherwise, IT DOES NOT GROW. A flat quietly compounding at the market yield is a fantasy, and
// the difference over ten years is most of the answer. If he expects to sell it, he says for how
// much and when, and that is a far more honest input than any growth rate.
export const EVENT_KINDS = ['contribution', 'lump', 'income', 'spending', 'asset'];

export function cleanEvent(e) {
  const atYear = Math.max(1, Math.min(60, Math.round(num(e?.atYear)) || 1));
  return {
    id: txt(e?.id, 32) || newId(),
    // Which year of the plan it takes effect. Year 1 is the next twelve months.
    atYear,
    // And when it stops, if it does. "Rent until year 10" — a lease that ends, a loan that gets
    // paid off, a child who leaves. Without this every plan runs every line for ever.
    untilYear: e?.untilYear == null || !num(e.untilYear) ? null : Math.max(atYear, Math.min(60, Math.round(num(e.untilYear)))),
    kind: EVENT_KINDS.includes(e?.kind) ? e.kind : 'contribution',
    // A monthly figure for contribution/income/spending; a one-off total for a lump.
    amount: num(e?.amount),
    // AND THE CURRENCY IT IS IN.
    //
    // The one place in this app that broke its own founding rule. He typed his Cairo rent as
    // "18,000 a month" — 18,000 EGP, about 305 euro — and the plan read it as 18,000 EUR and
    // projected 2.77 MILLION over ten years. Every other figure here carries its currency;
    // these did not, and the form even told him everything was in euro.
    currency: cleanCurrency(e?.currency) || 'EUR',
    // ITS OWN RATE, when the money has one. A deposit at 2% and a portfolio at 7% are not the
    // same money, and a plan that compounds both at one figure is wrong about whichever it is
    // not describing — usually by tens of thousands over ten years. Null means "whatever the
    // market does", and it follows the scenario yield like everything else.
    ratePct: e?.ratePct == null || e.ratePct === '' ? null : num(e.ratePct),
    // For an asset: when he expects to sell it, and for how much. Naming a price is honest in a
    // way a growth rate is not — "I think it will fetch 40,000 in year six" is a belief he can
    // defend, and "it grows 6% a year for ever" is one nobody can.
    sellAtYear: e?.sellAtYear == null || !num(e.sellAtYear) ? null : Math.max(atYear, Math.min(60, Math.round(num(e.sellAtYear)))),
    sellFor: e?.sellFor == null || e.sellFor === '' ? null : Math.max(0, num(e.sellFor)),
    label: txt(e?.label, 80),
    // Which holding this piece came from, when it came from one — so a deposit he has already
    // told the plan about (by hand or from the template) is not ALSO credited automatically.
    // Without this, "the deposits are paying the loan" recurs every time an account and a piece
    // both describe the same coupon.
    holdingId: txt(e?.holdingId, 40) || null,
    // Written by the app, not by him — a coupon the plan credits on its own because he has a live
    // certificate and never told the plan otherwise. The one place this matters is the drill-down:
    // he should be able to see that a year's total includes money he never typed.
    auto: !!e?.auto,
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
  // WHAT HE ACTUALLY HAS, each at the rate it actually pays.
  //
  // This used to be one lump grown at one invented rate. He asked where 5% came from, and the
  // answer was: from me. His four Egyptian certificates pay 17.5-22.5%, his flat pays rent and
  // not interest, and his cash pays nothing — and the plan grew all of it at five per cent.
  //
  //   [{ id, capital, ratePct, label, untilYear }]
  //
  // `untilYear` is when a certificate's term runs out; from the year after, that money is
  // ordinary cash again and follows whatever rate he has set for the rest.
  startBuckets = [],
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

  // MONEY IN BUCKETS, ONE PER RATE.
  //
  // A deposit at 2% and a portfolio at whatever the market does are not the same money, and a
  // plan that grows both at one figure is wrong about whichever it is not describing. Over ten
  // years that is not a rounding error, it is tens of thousands. So each piece with its own rate
  // gets its own bucket and compounds at its own rate; everything else sits in the default one
  // and follows the scenario yield.
  const buckets = new Map([['default', { rate: y, capital: Math.max(0, num(startCapital)), monthly: 0, label: null }]]);
  for (const b of startBuckets) {
    if (!(num(b.capital) > 0)) continue;
    buckets.set(`s:${b.id}`, {
      rate: num(b.ratePct || 0) / 100,
      capital: num(b.capital),
      monthly: 0,
      label: b.label || null,
      held: true,
      untilYear: b.untilYear || null,
    });
  }
  const bucketFor = (e) => {
    // Each asset gets its OWN bucket, so selling one is exact rather than a share of a pool —
    // and so it can sit at 0% while everything else follows the market.
    if (e.kind === 'asset') {
      const key = `a:${e.id}`;
      if (!buckets.has(key)) {
        buckets.set(key, { rate: num(e.ratePct || 0) / 100, capital: 0, monthly: 0, label: e.label || 'asset', asset: true });
      }
      return buckets.get(key);
    }
    if (e.ratePct == null) return buckets.get('default');
    const key = `r${e.ratePct}`;
    if (!buckets.has(key)) buckets.set(key, { rate: num(e.ratePct) / 100, capital: 0, monthly: 0, label: `${e.ratePct}%` });
    return buckets.get(key);
  };

  let baseMonthly = num(monthlySurplus);   // what he saves today, before anything he has listed
  let extraIncome = 0;                     // income from pieces, on top of what the capital yields
  let extraSpending = 0;
  const rows = [];

  for (let year = 1; year <= n; year++) {
    // Pieces start at the START of their year, so year 3 means "from year three onwards", and
    // stop at the END of untilYear.
    for (const e of evts.filter((x) => x.atYear === year)) {
      const b = bucketFor(e);
      if (e.kind === 'contribution') b.monthly += e.amount;
      else if (e.kind === 'income') { extraIncome += e.amount; b.monthly += e.amount; }
      else if (e.kind === 'spending') { extraSpending += e.amount; buckets.get('default').monthly -= e.amount; }
      else if (e.kind === 'lump') b.capital += e.amount;
      else if (e.kind === 'asset') b.capital += e.amount;
    }
    // A term that runs out. The certificate stops paying its rate and the money becomes ordinary
    // cash — which is the truth, and a great deal less flattering than a 20% deposit compounding
    // for thirty years.
    const maturedThisYear = [];
    for (const [, b] of buckets) {
      if (!b.held || !b.untilYear || b.untilYear >= year) continue;
      buckets.get('default').capital += b.capital;
      if (b.capital > 0 && b.label) maturedThisYear.push(b.label);
      b.capital = 0; b.untilYear = null;
    }
    // Sold: the asset leaves at the price he expects, and the money becomes cash he can invest,
    // so it moves into the bucket that follows the market. Without a price it goes for whatever
    // it is carried at — no gain invented.
    const soldThisYear = [];
    for (const e of evts.filter((x) => x.kind === 'asset' && x.sellAtYear === year)) {
      const b = bucketFor(e);
      const proceeds = e.sellFor != null ? e.sellFor : b.capital;
      buckets.get('default').capital += proceeds;
      b.capital = 0; b.monthly = 0;
      soldThisYear.push(e.label || 'asset');
    }
    for (const e of evts.filter((x) => x.untilYear != null && x.untilYear === year - 1)) {
      const b = bucketFor(e);
      if (e.kind === 'contribution') b.monthly -= e.amount;
      else if (e.kind === 'income') { extraIncome -= e.amount; b.monthly -= e.amount; }
      else if (e.kind === 'spending') { extraSpending -= e.amount; buckets.get('default').monthly += e.amount; }
    }

    // Contributions through the year, then growth. Deliberately not the other way round: it
    // credits a full year of return to money that arrived in December.
    const def = buckets.get('default');
    const monthly = [...buckets.values()].reduce((t, b) => t + b.monthly, 0) + baseMonthly;
    let contributedThisYear = 0;
    for (const b of buckets.values()) {
      const add = Math.max(0, (b === def ? b.monthly + baseMonthly : b.monthly)) * 12;
      contributedThisYear += add;
      b.capital = b.capital * (1 + b.rate) + add;
    }
    const capital = [...buckets.values()].reduce((t, b) => t + b.capital, 0);
    // Each bucket yields at ITS rate, so a plan half in 2% deposits does not report itself as
    // though all of it were in the market.
    const fromCapital = [...buckets.values()].reduce((t, b) => t + (b.capital * b.rate) / 12, 0);
    const passive = fromCapital + extraIncome + monthlyPassiveNow;

    // WHAT THIS YEAR IS MADE OF. A total nobody can take apart is not a plan, it is a claim — the
    // sentence that built this whole tab in the first place, and it applies to a single year's
    // figure exactly as much as it applied to the ten-year one. `auto` marks a piece the app added
    // on its own (a coupon from a certificate he never told the plan about) so the drill-down can
    // say so, rather than let it read as something he typed.
    const breakdown = {
      base: baseMonthly,
      pieces: [
        ...evts.filter((x) => ['contribution', 'income', 'spending'].includes(x.kind)
          && x.atYear <= year && (x.untilYear == null || x.untilYear >= year))
          .map((x) => ({ label: x.label || x.kind, kind: x.kind, auto: x.auto, monthly: x.kind === 'spending' ? -x.amount : x.amount })),
        ...evts.filter((x) => x.kind === 'lump' && x.atYear === year)
          .map((x) => ({ label: x.label || 'lump', kind: 'lump', auto: x.auto, once: x.amount })),
        ...evts.filter((x) => x.kind === 'asset' && x.atYear === year)
          .map((x) => ({ label: x.label || 'asset', kind: 'asset', auto: x.auto, once: x.amount })),
        ...evts.filter((x) => x.kind === 'asset' && x.sellAtYear === year)
          .map((x) => ({ label: `${x.label || 'asset'} sold`, kind: 'sale', auto: x.auto, once: x.sellFor })),
      ],
      // What is actually growing, bucket by bucket — a 2% deposit and the market are not one line.
      buckets: [...buckets.entries()].filter(([k, b]) => k !== 'default' && b.capital > 0)
        .map(([, b]) => ({ label: b.label, capital: b.capital, ratePct: b.rate * 100, monthly: (b.capital * b.rate) / 12 })),
      everythingElse: def.capital > 0 ? { capital: def.capital, ratePct: y * 100, monthly: (def.capital * y) / 12 } : null,
    };

    rows.push({
      year,
      capital,
      contributedThisYear,
      monthlyContribution: monthly,
      passiveMonthly: passive,
      extraSpending,
      goalMet: goalMonthly > 0 ? passive >= goalMonthly : null,
      events: evts.filter((x) => x.atYear === year).map((x) => x.label || x.kind),
      ends: [...evts.filter((x) => x.untilYear === year).map((x) => x.label || x.kind), ...maturedThisYear],
      // Kept apart from `ends`: a line stopping and an asset being sold are different events,
      // and the wording for each belongs in the view, not baked into the data.
      sold: soldThisYear,
      breakdown,
    });
  }

  const hit = rows.find((r) => r.goalMet);
  return {
    rows,
    yieldPct: num(yieldPct),
    // What sits at a rate of its own, so the page can say "half of this is not market money".
    ownRate: [...buckets.entries()].filter(([k]) => k !== 'default' && buckets.get(k).capital > 0)
      .map(([, b]) => ({ ratePct: b.rate * 100, capital: b.capital, label: b.label, asset: !!b.asset, held: !!b.held })),
    endCapital: rows[rows.length - 1].capital,
    endPassive: rows[rows.length - 1].passiveMonthly,
    goalReachedInYear: hit ? hit.year : null,
    // Travels with every figure this produces, wherever it is printed.
    assumes: 'the yield holds every year, contributions continue, no tax, no inflation, no bad year',
  };
}

/** The plan run at more than one yield, where a yield is a guess.
 *
 *  This used to hard-code 3.5 / 5 / 7 and call it "typical", which is where his 5% came from —
 *  and it was applied to certificates paying 20% and to cash paying nothing. The rate is HIS now:
 *  every holding grows at the rate it actually pays, and the one number left over is what he
 *  expects the REST to earn, which he sets and which defaults to nothing.
 *
 *  At nought there is no range to draw, because nought is a decision and not a forecast. Above
 *  it, a point and a half either way, so his own guess is not read as a fact. */
export function planYields(yieldPct) {
  const r = Math.max(0, num(yieldPct));
  if (r === 0) return [0];
  return [Math.max(0, r - 1.5), r, r + 1.5];
}

export function forecastRange(opts = {}, yields = planYields(opts.yieldPct ?? 0)) {
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
    // The date the schedule is anchored to. For a tenancy with no stated start that is the day
    // it was added, and callers must use THIS rather than re-deriving it from the account, or
    // the rent has dates here and no dates there.
    start,
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

// How many times a year each frequency pays. `maturity` pays once, at the end.
const PAYOUTS_PER_YEAR = { monthly: 12, quarterly: 4, yearly: 1 };

function termProgress(a, now = Date.now()) {
  if (!a || !(a.value > 0)) return null;
  // AN ASSET DOES NOT HAVE TO HAVE A RATE TO PAY YOU.
  //
  // A deposit is described by a percentage. A FLAT IS NOT: he knows the rent — 27,000 EGP a
  // month — and not what fraction of the flat's value that happens to be. Requiring a rate here
  // is why he could not add the apartment with the rent he actually receives: the income simply
  // had nowhere to go, and the flat sat in his net worth doing nothing.
  //
  // So either describes an income: a rate, or an amount and how often it arrives.
  const perPeriod = PAYOUTS_PER_YEAR[a.payout];
  const paysAmount = a.payment > 0 && (perPeriod || a.payout === 'maturity');
  if (a.ratePct == null && !paysAmount) return null;

  const start = a.startsAt, end = a.endsAt;
  const perYear = a.ratePct != null
    ? a.value * (a.ratePct / 100)
    : (perPeriod ? a.payment * perPeriod : 0);

  // What the asset actually returns, when he told us the rent rather than a percentage. This is
  // the number that says whether a flat is working or merely expensive — and it is the same
  // question the app asks of a deposit rate, asked of bricks.
  const yieldPct = a.ratePct == null && perYear > 0 && a.value > 0 ? (perYear / a.value) * 100 : null;

  // No start date: a tenancy he has had for years has no interesting beginning, so the day he
  // added it anchors the schedule. Better than refusing to show the rent at all.
  const anchor = start || (paysAmount && a.payout !== 'maturity' ? a.at : null);
  if (!anchor) return { perYear, yieldPct, currency: a.currency, hasTerm: false, payout: a.payout || null, schedule: null };
  if (!start) {
    return {
      perYear, yieldPct, currency: a.currency, hasTerm: false, running: true,
      liability: isLiability(a.kind), payout: a.payout || null,
      schedule: payoutSchedule({
        start: anchor, end: null, payout: a.payout, perYear,
        principal: a.value, payment: a.payment ?? null, amortising: isLiability(a.kind),
      }, now),
    };
  }

  const upTo = Math.min(now, end ?? now);
  const elapsedDays = Math.max(0, (upTo - start) / DAY);
  // A RATE ACCRUES; RENT DOES NOT.
  //
  // Interest is being earned every day between coupons, so measuring it as a fraction of a year
  // is right. Rent is not: on the 20th of the month he has had this month's payment and not a
  // twentieth of next month's. Where the income is defined by an amount rather than a rate, "so
  // far" is the money that has actually arrived.
  const accrues = a.ratePct != null;
  const earned = accrues ? perYear * yearsBetween(start, upTo) : null;

  const liability = isLiability(a.kind);
  const common = { principal: a.value, payment: a.payment ?? null, amortising: liability };

  if (!end) {
    return {
      perYear, yieldPct, currency: a.currency, hasTerm: false, start, elapsedDays, earned, running: true,
      liability, payout: a.payout || null,
      schedule: payoutSchedule({ ...common, start, end: null, payout: a.payout, perYear }, now),
    };
  }

  const termDays = Math.max(1, (end - start) / DAY);
  const termYears = yearsBetween(start, end);
  const totalAtMaturity = perYear * termYears;
  const ended = now >= end;
  const redeemable = isRedeemable(a.kind) && !liability;
  const schedule = payoutSchedule({ ...common, start, end, payout: a.payout, perYear, totalAtMaturity }, now);
  return {
    perYear,
    yieldPct,
    currency: a.currency,
    hasTerm: true,
    start, end,
    liability,
    payout: a.payout || null,
    schedule,
    // Whether the end date is the end of a TERM (the money comes back) or of an ARRANGEMENT (the
    // income stops and the asset stays). Every sentence about the end date hangs off this.
    redeemable,
    endsWhat: liability ? 'debt' : redeemable ? 'term' : a.kind === 'property' ? 'tenancy' : 'arrangement',
    termDays,
    elapsedDays: Math.min(elapsedDays, termDays),
    remainingDays: Math.max(0, (end - now) / DAY),
    termYears,
    pctThrough: Math.min(100, termYears > 0 ? (yearsBetween(start, upTo) / termYears) * 100 : 100),
    // Cash where the income is an amount, accrual where it is a rate — see above. The schedule
    // is built before this point, so the count of payments already made is to hand.
    earned: accrues ? earned : (schedule?.paidSoFar ?? 0),
    remaining: accrues ? Math.max(0, totalAtMaturity - earned) : Math.max(0, schedule?.leftToPay ?? 0),
    totalAtMaturity,
    // What he gets back on the day it ends, principal included — for the things that ARE handed
    // back. A flat is still his the morning after the tenancy ends, and nobody redeems it.
    valueAtMaturity: redeemable ? a.value + totalAtMaturity : null,
    matured: ended && redeemable,
    // The arrangement is over, whatever kind of thing it is. `matured` means the money came back;
    // this only means the end date has passed, and the two are not the same event.
    ended,
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
    endingSoon: rows.filter((r) => r.progress.hasTerm && !r.progress.ended && r.progress.remainingDays <= 90),
    ended: rows.filter((r) => r.progress.ended),
    // Only the things that are actually REDEEMED — where money comes back and then sits idle.
    // A tenancy running out is a different event and needs a different sentence.
    matured: rows.filter((r) => r.progress.matured),
    maturingSoon: rows.filter((r) => r.progress.hasTerm && r.progress.redeemable && !r.progress.matured && r.progress.remainingDays <= 90),
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
  if (raw.rateThen !== undefined) {
    const n = raw.rateThen === '' || raw.rateThen === null ? null : Number(String(raw.rateThen).replace(',', '.'));
    out.rateThen = n && Number.isFinite(n) && n > 0 ? n : null;
  }
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
    // `ended`, not `matured`. Narrowing `matured` to things that are actually redeemed left this
    // gate open for everything that is not: a tenancy that ran out in 2024 went on being reported
    // as 305 a month of contracted income. Exactly the failure this app exists to prevent, and
    // introduced by the change that fixed the one next to it.
    if (!t || !t.schedule || t.ended || t.matured) continue;
    const row = {
      label: a.label || a.kind,
      currency: a.currency,
      // The same word the month uses, so the same source wears the same colour in both places.
      category: isLiability(a.kind) ? 'loan'
        : a.kind === 'property' ? 'rent'
        : a.kind === 'portfolio' ? 'dividend'
        : 'interest',
      endsAt: a.endsAt || null,
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
    id: txt(s?.id, 32) || newId(),
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


// ---- What the month already knows is going to happen ----
//
// A deposit coupon and a loan instalment are the two largest, most predictable movements in this
// household, and until now neither appeared in a month at all: In and Out counted only what he
// had typed. A month that omits 1,075 EUR of loan payments and a 419 EUR coupon is not a picture
// of the month.
//
// These are not guesses. A fixed-term certificate paying 24,750 EGP on 28 November and a car loan
// billing 58,063.45 on the same day are contractual, dated, and known — which is exactly what
// separates them from "salary probably arrives". So they are projected into the month.
//
// TWO RULES KEEP IT HONEST:
//
//   1. Only a payment whose DATE HAS PASSED counts in the totals. One still ahead is shown
//      separately as "still due", because "left over" must keep meaning what actually happened.
//      Folding a future charge into it would turn the record of a month into a forecast of one.
//   2. Every projection has a stable id, and a recorded flow carrying that id REPLACES it. That
//      is the only thing standing between this feature and a month that counts the same coupon
//      twice, which is worse than not counting it at all.

/** Every date a SUBSCRIPTION charges, inside a window. Same shape as a holding's schedule,
 *  because a subscription that bills on the 14th is exactly as real as a coupon that pays on the
 *  28th, and the month should not care which kind of thing it was. */
export function subChargeDates(s, { from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  if (!s || !(s.amount > 0)) return [];
  const start = s.startsAt || s.at;
  if (!start) return [];
  // A free trial is not a charge, so the first real one is the day it expires.
  const first = s.trialEndsAt && s.trialEndsAt > start ? s.trialEndsAt : start;
  const out = [];
  if (s.every === 'weekly') {
    for (let i = 0; i <= 5000; i++) {
      const at = first + i * WEEK;
      if (at > to || (s.endsAt && at >= s.endsAt)) break;
      if (at >= from) out.push(at);
    }
    return out;
  }
  const step = PERIOD_MONTHS[s.every] || 1;
  for (let i = 0; i <= 2400; i++) {
    const at = addMonths(first, i * step);
    if (at > to || (s.endsAt && at >= s.endsAt)) break;
    if (at >= from) out.push(at);
  }
  return out;
}

/** Every date a holding pays or bills, inside a window. */
export function paymentDates(a, { from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  const t = termProgress(a);
  const s = t?.schedule;
  if (!s) return [];
  if (s.payout === 'maturity') {
    return a.endsAt && a.endsAt >= from && a.endsAt <= to ? [a.endsAt] : [];
  }
  const anchor = s.start;
  const every = PAYOUT_MONTHS[s.payout];
  if (!every || !anchor) return [];
  const out = [];
  for (let i = 1; i <= 2400; i++) {
    const at = addMonths(anchor, i * every);
    if (a.endsAt && at > a.endsAt) break;
    if (at > to) break;
    if (at >= from) out.push(at);
  }
  return out;
}

/** The scheduled movements inside a month, as flow-shaped rows the rest of the app can total.
 *
 *  `recorded` is the set of schedule ids already entered as real flows; those are dropped, so
 *  confirming a payment swaps a projection for the real thing rather than adding to it. */
/** Which recorded flows ARE scheduled payments he typed himself.
 *
 *  He calls his rent "Apt 1", so the app had no idea it was rent: it went into the passive split
 *  as an unknown source, in the grey reserved for "something else". It is not something else, it
 *  is the flat. Matching a hand-typed flow to the holding it came from teaches the app what his
 *  own words mean — and it is the same match that stops the rent being counted twice, so the two
 *  can never disagree about which flow is which.
 *
 *  Returns a Map of flow id → { source, accountId, label }.
 */
export function matchRecorded(accounts, window = {}, { now = Date.now(), flows = [] } = {}) {
  const out = new Map();
  const untagged = (flows || []).filter((f) => !f.schedId && !f.subId);
  if (!untagged.length) return out;

  for (const a of accounts || []) {
    const t = depositProgress(a, now);
    if (!t?.schedule) continue;
    const perPayment = t.schedule.perPayment;
    if (!(perPayment > 0)) continue;
    const owed = isLiability(a.kind);
    const source = owed ? (a.kind === 'card' ? 'card' : 'loan')
      : a.kind === 'property' ? 'rent'
      : a.kind === 'portfolio' ? 'dividend'
      : 'interest';

    for (const at of paymentDates(a, window)) {
      for (const f of untagged) {
        if (out.has(f.id)) continue;
        if (f.dir !== (owed ? 'out' : 'in')) continue;
        if (f.currency !== a.currency) continue;
        if (Math.abs(f.amount - perPayment) > Math.max(0.01, perPayment * 0.01)) continue;
        if (Math.abs(f.ts - at) > 5 * DAY) continue;
        out.set(f.id, { source, accountId: a.id, label: a.label || a.kind });
        break;
      }
    }
  }
  return out;
}

export function scheduledFlows(accounts, window = {}, { now = Date.now(), recorded = new Set(), flows = [], subs = [] } = {}) {
  // AND THE ONE HE HAS BEEN TYPING BY HAND.
  //
  // He has entered the Cairo rent every month for a year. Those flows carry no schedule id, so
  // the exact-id guard does not see them — and the day the flat learned to produce its own rent,
  // every one of those months would have counted it twice. A recorded flow that looks like a
  // scheduled one IS it: same direction, same currency, the same amount within a percent, within
  // five days of the date. Suppressing a real projection is a small loss; double-counting the
  // rent is a wrong total, and a wrong total gets believed.
  const untagged = (flows || []).filter((f) => !f.schedId && !f.subId);
  const looksLike = (p) => untagged.some((f) =>
    f.dir === p.dir
    && f.currency === p.currency
    && Math.abs(f.amount - p.amount) <= Math.max(0.01, p.amount * 0.01)
    && Math.abs(f.ts - p.ts) <= 5 * DAY);

  const out = [];
  for (const a of accounts || []) {
    const t = depositProgress(a, now);
    if (!t?.schedule) continue;
    const owed = isLiability(a.kind);
    const perPayment = t.schedule.perPayment;
    if (!(perPayment > 0)) continue;

    for (const at of paymentDates(a, window)) {
      const schedId = `${a.id}:${new Date(at).toISOString().slice(0, 10)}`;
      if (recorded.has(schedId)) continue;
      if (looksLike({ dir: owed ? 'out' : 'in', currency: a.currency, amount: perPayment, ts: at })) continue;

      // A LOAN INSTALMENT IS NOT ALL SPENDING. Part of it buys back his own debt, and that part
      // is saving wearing the clothes of an expense. The split is the interest on the balance
      // outstanding at that moment; everything above it comes off the principal.
      let interestPart = null, principalPart = null;
      if (owed) {
        const bal = balanceNow(a, at - 1).amount;
        const rate = t.implied ? t.implied.perPeriodPct / 100
          : (a.value > 0 ? (t.perYear / a.value) * ((t.schedule.every || 12) / 12) : 0);
        interestPart = Math.min(perPayment, bal * rate);
        principalPart = Math.max(0, perPayment - interestPart);
      }

      out.push({
        id: schedId,
        schedId,
        accountId: a.id,
        label: a.label || a.kind,
        dir: owed ? 'out' : 'in',
        category: owed ? (a.kind === 'card' ? 'card' : 'loan')
          : a.kind === 'property' ? 'rent'
          : a.kind === 'portfolio' ? 'dividend'
          : 'interest',
        amount: perPayment,
        currency: a.currency,
        ts: at,
        // A deposit coupon is money arriving without him working for it, which is the whole
        // point of the goal. It has to count towards it the moment it lands.
        passive: !owed,
        scheduled: true,
        // Passed means it happened; ahead means it is coming. Only the first counts.
        due: at <= now,
        estimated: !!t.schedule.estimated,
        interestPart,
        principalPart,
      });
    }
  }
  // SUBSCRIPTIONS BELONG HERE TOO.
  //
  // They were deliberately kept out of the month's totals, on the reasoning that a subscription
  // is what he has agreed to pay and a flow is what has left. That was over-careful and it made
  // the month wrong: a household paying for Netflix and a gym showed OUT of nothing. A charge on
  // the 14th is exactly as real as a coupon on the 28th, and it goes through the same two rules —
  // only a date that has passed counts, and recording one replaces it.
  for (const sub of subs || []) {
    if (!(sub.amount > 0)) continue;
    for (const at of subChargeDates(sub, window)) {
      const schedId = `sub:${sub.id}:${new Date(at).toISOString().slice(0, 10)}`;
      if (recorded.has(schedId)) continue;
      if (looksLike({ dir: 'out', currency: sub.currency, amount: sub.amount, ts: at })) continue;
      out.push({
        id: schedId,
        schedId,
        subId: sub.id,
        label: sub.label,
        dir: 'out',
        category: sub.category || 'subscriptions',
        amount: sub.amount,
        currency: sub.currency,
        ts: at,
        passive: false,
        scheduled: true,
        due: at <= now,
        estimated: false,
        interestPart: null,
        principalPart: null,
      });
    }
  }

  return out.sort((x, y) => y.ts - x.ts);
}


// ---- The currency his money is actually in ----
//
// He earns and spends in euro, and roughly nine tenths of what he owns is in Egyptian pounds.
// That is the largest single fact about this household's finances — larger than which deposit
// pays what — and until now the app could convert his money without ever telling him what the
// currency itself had done to him.
//
// The arithmetic for it has existed in fx.js since the beginning (`realReturn`) and has never
// once run, because nothing ever passed it a historical rate. So an account can now carry the
// rate he got it at, and the app records the rate each day from here on. Neither is invented:
// where there is no history, this says so rather than drawing a line through one point.

/** What each currency he holds is doing to him.
 *
 *  `history` is a list of dated rate tables, oldest first, as recorded day by day. */
export function currencyPicture(accounts, table, base = 'EUR', { history = [], now = Date.now(), basis = {} } = {}) {
  const rateOf = (t, cur) => (cur === (t?.base || base) ? 1 : Number(t?.rates?.[cur]));
  const rows = [];

  const byCurrency = {};
  for (const a of accounts || []) {
    if (a.currency === base) continue;
    const owed = isLiability(a.kind);
    const held = balanceNow(a, now).amount;
    if (!(held > 0)) continue;
    (byCurrency[a.currency] = byCurrency[a.currency] || []).push({ a, held, owed });
  }

  for (const [currency, list] of Object.entries(byCurrency)) {
    const rateNow = rateOf(table, currency);
    // ONE RATE FOR THE WHOLE POSITION, because that is how the money got there.
    //
    // He did not earn Egyptian pounds. He took euro and exchanged them, so every pound he holds
    // has a known euro cost — and asking him to type a starting rate into five separate holdings
    // was asking five times for one fact. A currency-level basis stands in wherever a holding has
    // no rate of its own; a holding that does have one always wins, because a certificate bought
    // in a different year really was bought at a different rate.
    const b = basis?.[currency] || null;
    // And the date it is measured from is the day he first moved money into that currency —
    // not the day this app started keeping a diary, which is what "0.0% since Sep 2" was.
    const firstHeld = Math.min(...list.map(({ a }) => a.startsAt || a.at || now));
    if (!(rateNow > 0)) {
      rows.push({ currency, rateNow: null, unconverted: true, holdings: [], exposureInBase: null });
      continue;
    }

    const holdings = list.map(({ a, held, owed }) => {
      const nowInBase = held / rateNow;
      // What that same money was worth in euro on the day he got it. Only where he has said so —
      // a made-up starting rate would produce a made-up gain, which is worse than no answer.
      const rateThen = a.rateThen > 0 ? a.rateThen : (b?.rateThen > 0 ? b.rateThen : null);
      const rateSource = a.rateThen > 0 ? 'holding' : (b?.rateThen > 0 ? 'basis' : null);
      const thenInBase = rateThen > 0 ? held / rateThen : null;
      // A weakening currency erodes a holding and, in exactly the same measure, erodes a DEBT in
      // his favour. Same arithmetic, opposite sign, and getting the sign wrong here would tell
      // him a falling pound was costing him money it was actually saving him.
      const moveInBase = thenInBase == null ? null : (owed ? thenInBase - nowInBase : nowInBase - thenInBase);
      return {
        id: a.id, label: a.label || a.kind, kind: a.kind, owed,
        value: held, currency,
        rateThen, rateSource,
        nowInBase, thenInBase, moveInBase,
        movePct: thenInBase ? ((nowInBase - thenInBase) / thenInBase) * 100 : null,
        // For a holding that also pays a rate, the question the app was built to ask: is 20% in
        // a currency that fell still 20%?
        real: a.ratePct != null && rateThen > 0 ? realReturn({ nominalPct: a.ratePct, rateThen, rateNow }) : null,
      };
    });

    const exposureInBase = holdings.reduce((t, h) => t + (h.owed ? -h.nowInBase : h.nowInBase), 0);
    const known = holdings.filter((h) => h.moveInBase != null);

    // What is recorded, not what is guessed. Two points make a line; one makes nothing.
    const series = history
      .map((t) => ({ at: t.at, rate: rateOf(t, currency) }))
      .filter((x) => x.rate > 0)
      .sort((a2, b2) => a2.at - b2.at);
    const first = series[0];
    const recordedChangePct = first && first.rate > 0 ? ((rateNow - first.rate) / first.rate) * 100 : null;
    // What the rate has done since he BOUGHT IN — the comparison he actually wants — falling back
    // to the recorded diary only when he has not said what he exchanged at.
    const sinceAt = b?.rateThen > 0 ? (b.at || firstHeld) : (first ? first.at : null);
    const changePct = b?.rateThen > 0 ? ((rateNow - b.rateThen) / b.rateThen) * 100 : recordedChangePct;

    rows.push({
      currency,
      rateNow,
      exposureInBase,
      holdings,
      // Only where he told the app what he paid for it.
      movedInBase: known.length ? known.reduce((t, h) => t + h.moveInBase, 0) : null,
      told: known.length,
      untold: holdings.length - known.length,
      series,
      since: sinceAt,
      sinceIsBasis: !!(b?.rateThen > 0),
      basisRate: b?.rateThen || null,
      basisAt: b?.at || null,
      // The day he first put money into this currency — the honest default for the basis date,
      // so the only thing he has to type is the rate.
      firstHeld,
      changePct,
      recordedChangePct,
      // WHAT HE PUT IN, AND WHAT IT IS NOW. Every pound came from euro, so this is not an
      // estimate of anything — it is the price he paid against the price today.
      investedInBase: known.length ? known.reduce((t, h) => t + (h.owed ? -h.thenInBase : h.thenInBase), 0) : null,
      // WHAT A MOVE WOULD DO. No forecast and no history needed — just the size of the bet he is
      // already holding, which is the number that decides whether it is one he wants.
      sensitivity: [10, 20].map((pct) => ({
        weakensPct: pct,
        // The currency losing `pct` means it takes (1 + pct/100) as many of them to buy a euro.
        deltaInBase: exposureInBase * (1 / (1 + pct / 100) - 1),
      })),
    });
  }

  return rows.sort((a2, b2) => Math.abs(b2.exposureInBase || 0) - Math.abs(a2.exposureInBase || 0));
}


// ---- A plan to start from ----
//
// "I want to add and create the plan on my own. From you I need a template, so I will see how it
//  will look through the years."
//
// So this reads what he already has and writes the plan he is already living: every coupon that
// arrives, every instalment that leaves, the flat and its rent, the subscriptions. Nothing here
// is a forecast — each piece is a figure the app already holds, and each one is his to edit or
// delete afterwards.
//
// It is also the only way "the deposits are paying the loan" can show up at all: as income in and
// spending out, in the same list, netting to whatever it really nets to.

/** Which plan year a date falls in. Year 1 is the next twelve months. */
export function planYearOf(at, now = Date.now()) {
  if (!at || at <= now) return null;
  return Math.max(1, Math.ceil(yearsBetween(now, at)));
}

/** What a holding PAYS, per month, in its own currency — a coupon in, an instalment out. Shared
 *  by `planTemplate` (which writes it as a piece he can see and edit) and `web.js` (which credits
 *  it automatically the moment nobody has written a piece for it yet, `holdingId` says so, and
 *  either way this is the one place the number is computed). `null` when the holding says nothing.
 *
 *  Liabilities are not optional here the way a deposit's coupon might feel optional: a loan he
 *  never told the plan about does not stop costing him money for that reason. Crediting the
 *  coupon and forgetting the instalment is the same mistake in a new shape — a plan that looks
 *  healthier than the household it describes. */
export function holdingFlow(a, now = Date.now()) {
  const t = depositProgress(a, now);
  if (!t?.schedule || !(t.perYear > 0) || t.ended) return null;
  const owed = isLiability(a.kind);
  const perMonth = t.perYear / 12;
  // The instalment, not the interest: repaying principal is money leaving his account too, and
  // this is a cash-flow plan.
  const amount = owed && t.schedule.every ? (t.schedule.perPayment * (12 / t.schedule.every)) / 12 : perMonth;
  return {
    kind: owed ? 'spending' : 'income',
    label: `${a.label || a.kind} ${owed ? 'payment' : (a.kind === 'property' ? 'rent' : 'interest')}`,
    currency: a.currency,
    amount,
    holdingId: a.id,
  };
}

export function planTemplate(accounts = [], subs = [], now = Date.now()) {
  const out = [];
  const add = (e) => out.push(cleanEvent({ ...e, id: newId() }));

  for (const a of accounts) {
    const flow = holdingFlow(a, now);
    if (flow) add({ ...flow, atYear: 1, untilYear: planYearOf(a.endsAt, now) });

    // The flat itself: something he owns, at what it is worth, holding its value unless he says
    // otherwise. The certificates are already in the plan's opening capital, so they are not
    // repeated here.
    if (a.kind === 'property' && a.value > 0) {
      add({ kind: 'asset', label: a.label || 'property', currency: a.currency, amount: a.value, atYear: 1, holdingId: a.id });
    }
  }

  // Everything he subscribes to, as one line. Twelve separate rows for Netflix and a gym would
  // bury the plan; the Subs tab is where they live individually.
  const live = (subs || []).filter((s) => s.amount > 0 && !(s.endsAt && now >= s.endsAt));
  const byCurrency = {};
  for (const s of live) byCurrency[s.currency] = (byCurrency[s.currency] || 0) + subPerYear(s) / 12;
  for (const [currency, perMonth] of Object.entries(byCurrency)) {
    if (perMonth > 0) add({ kind: 'spending', label: 'subscriptions', currency, amount: perMonth, atYear: 1 });
  }

  return out;
}
