// ---- Pocket as a Telegram Mini App ----
//
// Chat is the fastest way to RECORD something. It is a poor way to LOOK at anything: no tabs,
// no colour, no way to scan a month and see where the money went. So the bot keeps the typing
// and this serves the seeing.
//
// SECURITY, because this is a public URL in front of a household's finances:
//   - every request carries Telegram's signed initData, verified server-side against the bot
//     token (constant-time, with a freshness window);
//   - and the verified Telegram user id must equal TELEGRAM_CHAT_ID. A valid signature only
//     proves the request came from Telegram — it does not prove it came from HIM. Without the
//     second check, any Telegram user who found the URL could open the Mini App and read
//     everything.
// There is no session cookie and no fallback path. No initData, no answer.

import http from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { verifyInitData } from '../miniapp.js';
import { VERSION } from './version.js';
import * as fx from '../fx.js';
import * as store from './store.js';
import {
  netWorth, monthOf, goalProgress, yearsToGoal, interestPicture, debtVsInvesting,
  parseEntry, ACCOUNT_KINDS, PAYOUT_KINDS, isLiability, forecastRange, depositProgress,
  monthWindowOf, recentMonths, monthsSummary, patchFrom, depositsSummary, contractedIncome,
  missingRecurring, cleanFlow, balanceNow, subsSummary, BILLING_PERIODS, cleanSub,
  scheduledFlows, EVENT_KINDS, parseDate, matchRecorded, subChargeDates, currencyPicture, cleanEvent,
} from './money.js';

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readBody(req, limit = 100_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** The gate. Returns { ok } or { ok:false, why } — the reason matters because "not authorised"
 *  has five different causes here and they need five different fixes. None of the reasons leaks
 *  a secret: they name which check failed, never the token, and only ever the last four digits
 *  of an id that is his own. */
function authorised(req) {
  const initData = req.headers['x-telegram-init-data'];
  if (!config.telegramToken) return { ok: false, why: 'The server has no bot token set.' };
  if (!initData) {
    return { ok: false, why: 'Telegram sent no signature. Open this from the “Open Pocket” button in the chat, not from a link or a browser.' };
  }
  const user = verifyInitData(initData, config.telegramToken);
  if (!user) {
    return { ok: false, why: 'Telegram’s signature did not verify. Usually this means the bot token here is not the token of the bot you opened this from — check TELEGRAM_BOT_TOKEN, especially if it was revoked and replaced.' };
  }
  if (!user.id) return { ok: false, why: 'The signature verified but carried no user.' };
  if (String(user.id) !== String(config.telegramChatId)) {
    const tail = (v) => String(v).slice(-4);
    return {
      ok: false,
      why: `Signed in as Telegram user …${tail(user.id)}, but this Pocket is set to …${tail(config.telegramChatId)}. Set TELEGRAM_CHAT_ID to ${user.id}.`,
    };
  }
  return { ok: true };
}

// How far back the strip of months along the top of the app reaches.
const STRIP_MONTHS = 12;

/** The window the app needs loaded for a given month: that month, plus the whole strip above
 *  it, in ONE query — scrolling back through the year must not be thirteen round trips to a
 *  512 MB cluster shared with a live shop. */
export function spanFor(monthKey, now = Date.now()) {
  const w = monthWindowOf(monthKey, now);
  const strip = recentMonths(STRIP_MONTHS, now);
  return {
    w,
    strip,
    span: { from: Math.min(w.from, strip[0].from), to: Math.max(w.to, strip[strip.length - 1].to) },
  };
}

/** Everything the page draws, from data already loaded. Pure on purpose: no database, no clock
 *  of its own, no network — so the entire payload the browser receives can be built from
 *  fixtures and checked, which is how the drawing code gets tested at all. */
export function buildState({ base = 'EUR', table, monthKey, accounts = [], spanFlows = [], subs = [], goal = null, events = { years: 10, list: [] }, history = [], basis = {}, now = Date.now() }) {
  const { w, strip, span } = spanFor(monthKey, now);
  const flows = spanFlows.filter((f) => f.ts >= w.from && f.ts <= w.to);

  // Without rates nothing can be totalled honestly, so the page is told so rather than being
  // handed numbers that quietly exclude two of three currencies.
  if (!table) {
    return { base, ratesAvailable: false, accounts, flows, subs: { rows: [] }, goal, kinds: ACCOUNT_KINDS, events: events.list };
  }

  // Sanitised here rather than trusted from the caller: a plan piece stored before pieces had a
  // currency has none, and treating that as "unconvertible" would drop it from the plan instead
  // of reading it as the base — which is what it was typed as.
  const plan = { ...events, list: (events.list || []).map(cleanEvent) };

  const n = netWorth(accounts, table, base, now);

  // Deposit coupons and loan instalments, projected into the months on screen. Contractual and
  // dated, so they belong in a month; but only the ones whose date has PASSED go into the
  // totals, and any that he has already recorded by hand drop out entirely.
  const recorded = new Set(spanFlows.map((f) => f.schedId).filter(Boolean));
  // What his own words mean. A flow he called "Apt 1" that matches the flat's rent to the euro
  // and the week IS the flat's rent, and the split should colour it as such.
  const matched = matchRecorded(accounts, { from: span.from, to: span.to }, { now, flows: spanFlows });
  const withSource = (list) => list.map((f) => (matched.has(f.id) ? { ...f, source: matched.get(f.id).source } : f));
  const spanSched = scheduledFlows(accounts, { from: span.from, to: span.to }, { now, recorded, flows: spanFlows, subs });
  const sched = spanSched.filter((f) => f.ts >= w.from && f.ts <= w.to);
  const landed = (list) => list.filter((f) => f.due);

  const m = monthOf(withSource(flows).concat(landed(sched)), table, base, w);
  // The Goal and Plan tabs are always about NOW, never about whichever month he happens to be
  // reading. Browsing back to a thin August must not quietly rewrite the ten-year projection.
  const nowWindow = strip[strip.length - 1];
  const cur = w.key === nowWindow.key ? m
    : monthOf(withSource(spanFlows).concat(landed(spanSched)), table, base, nowWindow);
  const ip = interestPicture(accounts, table, base, now);
  const g = goalProgress(cur.passive, goal);
  const invested = netWorth(accounts.filter((a) => ['portfolio', 'deposit'].includes(a.kind)), table, base, now).total;

  return {
    base,
    ratesAvailable: true,
    ratesAge: fx.rateAge(table),
    kinds: ACCOUNT_KINDS,
    payoutKinds: PAYOUT_KINDS,
    // The edit form offers a list rather than a free text box on purpose: typing "EGY" into a
    // currency field would fall back to the base and silently move an Egyptian holding to euro.
    currencies: [...fx.KNOWN_CURRENCIES],
    liabilityKinds: ACCOUNT_KINDS.filter(isLiability),
    month: m,
    // Which month is on screen, and the year behind it. `from` travels with each one so the
    // browser can name the month in his own locale — naming it here would hard-code English.
    monthKey: w.key,
    monthFrom: w.from,
    months: monthsSummary(spanFlows.concat(landed(spanSched)), table, base, { count: STRIP_MONTHS, now }),
    // Each account with its converted value alongside the original — the euro figure alone
    // hides a devaluation, so the page always has both.
    accounts: accounts.map((a) => {
      // What is owed TODAY. For a part-repaid loan this is the payoff, not the opening balance —
      // and both travel, because "445,000 borrowed, 155,000 left" is the honest sentence and
      // either number alone is a different, wronger one.
      const bal = balanceNow(a, now);
      return {
      ...a,
      liability: isLiability(a.kind),
      owedNow: bal.amount,
      repaidSoFar: bal.repaid,
      settled: bal.settled,
      // What overpaying has bought him: months off the end, and interest he never has to pay.
      // The one thing no lender puts on a statement.
      extraPaid: bal.extra || 0,
      extraCount: bal.extraCount || 0,
      monthsEarly: bal.monthsEarly ?? null,
      interestSavedInBase: bal.interestSaved == null ? null : fx.toBase(bal.interestSaved, a.currency, table),
      paymentsMade: bal.paymentsMade ?? null,
      paymentsLeft: bal.paymentsLeft ?? null,
      owedNowInBase: fx.toBase(bal.amount, a.currency, table),
      repaidInBase: fx.toBase(bal.repaid, a.currency, table),
      inBase: fx.toBase(bal.amount, a.currency, table),
      shown: fx.describeAmount(bal.amount, a.currency, table, base),
      // What this one has actually paid so far, in its own currency, plus the converted
      // figures so the page never does money arithmetic itself.
      term: (() => {
        const t = depositProgress(a, now);
        if (!t) return null;
        return {
          ...t,
          earnedInBase: t.earned == null ? null : fx.toBase(t.earned, a.currency, table),
          remainingInBase: t.remaining == null ? null : fx.toBase(t.remaining, a.currency, table),
          perYearInBase: fx.toBase(t.perYear, a.currency, table),
          schedule: t.schedule && {
            ...t.schedule,
            perPaymentInBase: fx.toBase(t.schedule.perPayment, a.currency, table),
            paidSoFarInBase: fx.toBase(t.schedule.paidSoFar, a.currency, table),
            leftToPayInBase: t.schedule.leftToPay == null ? null : fx.toBase(t.schedule.leftToPay, a.currency, table),
            totalOverTermInBase: t.schedule.totalOverTerm == null ? null : fx.toBase(t.schedule.totalOverTerm, a.currency, table),
          },
        };
      })(),
      };
    }),
    // Recorded and scheduled together, newest first, each saying which it is. The month list
    // has to show the coupon and the instalment or the totals above it cannot be checked.
    flows: [...flows, ...landed(sched)]
      .sort((a, b) => b.ts - a.ts)
      .map((f) => ({ ...f, inBase: fx.toBase(f.amount, f.currency, table) })),
    // Still to come before the month is out. Kept OUT of In/Out/Left over on purpose — folding
    // a charge that has not happened into them turns the record of a month into a forecast.
    upcoming: (() => {
      const ahead = sched.filter((f) => !f.due).map((f) => ({ ...f, inBase: fx.toBase(f.amount, f.currency, table) })).sort((a, b) => a.ts - b.ts);
      const sum = (dir) => ahead.filter((f) => f.dir === dir).reduce((n2, f) => n2 + (f.inBase || 0), 0);
      const income = sum('in'), spending = sum('out');
      return { rows: ahead, income, spending, surplusAfter: m.surplus + income - spending };
    })(),
    // How much of the month's outgoings is buying back his own debt rather than being spent.
    principalRepaid: landed(sched)
      .filter((f) => f.principalPart != null)
      .reduce((n2, f) => n2 + (fx.toBase(f.principalPart, f.currency, table) || 0), 0),
    worth: { total: n.total, assets: n.assets, debts: n.debts, exposure: n.exposure, unconverted: n.unconverted },
    interest: {
      earned: ip.earned, paid: ip.paid, net: ip.net,
      ended: ip.ended, notStarted: ip.notStarted,
      foreign: ip.foreign,
      // What that interest is next to everything he owns. 6,622 a year against a net worth of
      // 28,036 is 24% — the number that made him look twice, and correctly.
      shareOfWorth: n.total > 0 ? (ip.earned / n.total) * 100 : null,
    },
    // A term that is nearly up, or already up. A matured certificate sitting unnoticed is
    // capital earning nothing, and nothing else in the app would ever mention it again.
    terms: (() => {
      const ds = depositsSummary(accounts, now);
      const name = (r) => r.account.label || r.account.kind;
      return {
        // Redeemed: the money came back and is now sitting idle. Only ever a certificate.
        maturingSoon: ds.maturingSoon.map((r) => ({ label: name(r), at: r.progress.end, days: Math.round(r.progress.remainingDays) })),
        matured: ds.matured.map((r) => ({
          label: name(r), at: r.progress.end,
          backInBase: fx.toBase(r.progress.valueAtMaturity, r.account.currency, table),
        })),
        // An ARRANGEMENT running out: a tenancy with no renewal. The asset stays; the income
        // stops. Saying "matured" about a flat is how the app told him he owned a certificate.
        endingSoon: ds.endingSoon.filter((r) => !r.progress.redeemable && !r.progress.liability)
          .map((r) => ({ label: name(r), at: r.progress.end, days: Math.round(r.progress.remainingDays), what: r.progress.endsWhat })),
        ended: ds.ended.filter((r) => !r.progress.redeemable && !r.progress.liability)
          .map((r) => ({ label: name(r), at: r.progress.end, what: r.progress.endsWhat })),
      };
    })(),
    // Contracted, NOT counted. Kept apart from the measured passive figure on purpose: a
    // promise is not income, and the goal only ever counts what actually landed.
    contracted: (() => {
      const c = contractedIncome(accounts, now);
      const conv = (rows, field) => rows.map((r) => ({ ...r, inBase: fx.toBase(r[field], r.currency, table) }));
      const streams = conv(c.streams.filter((r) => !r.liability), 'perYear');
      const owed = conv(c.streams.filter((r) => r.liability), 'perYear');
      return {
        streams, owed,
        lumps: conv(c.lumps.filter((r) => !r.liability), 'total'),
        perMonth: streams.reduce((n, r) => n + (r.inBase || 0), 0) / 12,
        owedPerMonth: owed.reduce((n, r) => n + (r.inBase || 0), 0) / 12,
      };
    })(),
    // WHAT THE CURRENCY ITSELF IS DOING TO HIM. Nine tenths of what he owns is in a currency he
    // does not spend, and until now the app could convert that money without ever saying what
    // holding it had cost or made him.
    currencies: currencyPicture(accounts, table, base, { history, now, basis }),
    ratesAt: table.at || null,
    // Things that repeat and have not been entered again. A list to confirm, never a total.
    missing: missingRecurring(spanFlows, w),
    billingPeriods: BILLING_PERIODS,
    // Every subscription, normalised to a year so a monthly one and a yearly one can be
    // compared at all, plus what the whole bill would cost in capital to fund for ever.
    subs: (() => {
      const sum = subsSummary(subs, table, base, now);
      // Which ones have already been charged into the month on screen, so the tab can show
      // what is still outstanding rather than asking him to remember.
      // Charged already this month — whether he recorded it or the schedule produced it. Without
      // the second half, every subscription kept offering a ✓ for a charge the month had already
      // counted, which reads as "this has not been paid" about money that has.
      const paidThisMonth = new Set([...flows, ...landed(sched)].filter((f) => f.subId).map((f) => f.subId));
      return { ...sum, rows: sum.rows.map((r) => ({ ...r, paidThisMonth: paidThisMonth.has(r.id) })) };
    })(),
    payFirst: debtVsInvesting(accounts, { expectedYieldPct: 7, now }).filter((d) => d.payFirst),
    goal: g && {
      ...g,
      // Split by where it comes from, in a FIXED order so a source never changes colour when
      // another one appears or disappears — and each source carries BOTH numbers.
      //
      // `amount` is what actually landed this month. `coming` is the rest of what that source is
      // contracted to pay in a month and has not paid yet: on the 2nd of September no certificate
      // has paid a coupon, so a bar showing only what arrived shows him one flat and nothing
      // else, which is not the shape of his income. The two are drawn differently and only the
      // first is in the headline figure.
      sources: (() => {
        const contractedBy = {};
        for (const r of contractedIncome(accounts, now).streams) {
          if (r.liability) continue;
          const v = fx.toBase(r.perYear, r.currency, table);
          if (v == null) continue;
          contractedBy[r.category] = (contractedBy[r.category] || 0) + v / 12;
        }
        const arrivedBy = Object.fromEntries((cur.passiveByCategory || []).map((x) => [x.category, x.amount]));
        const all = [...new Set([...Object.keys(arrivedBy), ...Object.keys(contractedBy)])];
        return all.map((category) => {
          const amount = arrivedBy[category] || 0;
          // Never negative: a source that paid MORE than its contract this month has nothing
          // still coming, it just had a good month.
          const coming = Math.max(0, (contractedBy[category] || 0) - amount);
          return {
            category, amount, coming,
            pctOfTarget: g.target > 0 ? (amount / g.target) * 100 : 0,
            pctComing: g.target > 0 ? (coming / g.target) * 100 : 0,
          };
        }).filter((x) => x.amount > 0 || x.coming > 0)
          .sort((a2, b2) => (b2.amount + b2.coming) - (a2.amount + a2.coming));
      })(),
    },
    // HOW MUCH OF IT ENDS. A certificate that matures in 2027 is not the same income as a flat
    // he owns, and a progress bar that treats them alike says he is closer than he is.
    passiveEnds: (() => {
      const rows = accounts
        .filter((a) => !isLiability(a.kind) && a.endsAt)
        .map((a) => ({ a, t: depositProgress(a, now) }))
        .filter((x) => x.t?.schedule && !x.t.ended)
        .map((x) => ({
          label: x.a.label || x.a.kind,
          endsAt: x.a.endsAt,
          // A tenancy that ends is not the same as capital being handed back, and the sentence
          // on the Goal tab has to be able to tell him which one this is.
          what: x.t.endsWhat,
          perMonthInBase: fx.toBase(x.t.perYear / 12, x.a.currency, table),
        }))
        .sort((p, q) => p.endsAt - q.endsAt);
      return {
        rows,
        perMonth: rows.reduce((t2, r) => t2 + (r.perMonthInBase || 0), 0),
        firstEndsAt: rows.length ? rows[0].endsAt : null,
      };
    })(),
    plan: g ? yearsToGoal({ invested, monthlyContribution: Math.max(0, cur.surplus), goalMonthly: goal.monthly }) : null,
    // Ten years from what he ACTUALLY saved this month, plus whatever he has said will change.
    // Three yields, because over a decade the yield assumption is most of the answer.
    // The plan is BUILT, not inferred. `planBase` is the one number it starts from — what he
    // actually saved this month — and he can switch it off and list everything himself instead.
    //
    // Its pieces are converted here, once, for the same reason every other figure in this app is:
    // an amount without a currency is not an amount. The forecast itself stays pure arithmetic in
    // a single currency and never learns about exchange rates.
    planUnconverted: plan.list.filter((e) => fx.toBase(e.amount, e.currency, table) == null)
      .map((e) => `${e.label || e.kind} (${e.currency})`),
    planBase: plan.useMeasured ? Math.max(0, cur.surplus) : 0,
    planUseMeasured: plan.useMeasured !== false,
    planStartCapital: invested,
    eventKinds: EVENT_KINDS,
    forecast: forecastRange({
      startCapital: invested,
      monthlySurplus: plan.useMeasured ? cur.surplus : 0,
      events: plan.list
        .map((e) => ({ ...e, amount: fx.toBase(e.amount, e.currency, table) }))
        // No rate, no amount. Excluded and named above, never passed through as though the
        // number were euro — which is exactly the failure that put 2.77 million on his screen.
        .filter((e) => e.amount != null),
      monthlyPassiveNow: 0,
      years: Number(plan.years) || 10,
      goalMonthly: goal?.monthly || 0,
    }),
    events: plan.list.map((e) => ({ ...e, amountInBase: fx.toBase(e.amount, e.currency, table) })),
    forecastYears: Number(plan.years) || 10,
  };
}

/** The same payload, with the data fetched. Everything it does beyond loading is in buildState. */
async function state(monthKey) {
  const base = config.baseCurrency || 'EUR';
  let table = null;
  try { table = await fx.rates(base); } catch (e) { table = null; }

  const { span } = spanFor(monthKey);
  // One snapshot a day, so that in a month there is something to compare today against. Never
  // allowed to break a page load — a rate the app failed to file away is not worth an error.
  if (table) store.recordRates(table).catch((e) => console.error('[pocket] rate snapshot:', e.message));
  const [accounts, spanFlows, subs, goal, events, history, basis] = await Promise.all([
    store.accounts(), store.flows(span), store.subs(), store.getGoal(), store.getPlanEvents(),
    table ? store.rateHistory().catch(() => []) : Promise.resolve([]),
    store.getFxBasis().catch(() => ({})),
  ]);
  return buildState({ base, table, monthKey, accounts, spanFlows, subs, goal, events, history, basis });
}

export function startWeb(port = process.env.PORT || 3000) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // The shell is public; it holds no data and cannot fetch any without a signature.
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await readFile(fileURLToPath(new URL('./app.html', import.meta.url)), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      // Open on purpose and carries no data: "which build is actually serving" has to be
      // answerable without opening Telegram, or a deploy that never arrived looks like a bug.
      if (url.pathname === '/health' || url.pathname === '/version') {
        return json(res, 200, { ok: true, app: 'pocket', version: VERSION });
      }

      if (url.pathname.startsWith('/api/')) {
        const gate = authorised(req);
        if (!gate.ok) return json(res, 401, { error: gate.why });

        // Which month is on screen travels on every call, so an edit made while looking at
        // August redraws August and not whatever month today happens to be.
        const asked = () => url.searchParams.get('month') || undefined;

        if (url.pathname === '/api/state') return json(res, 200, await state(asked()));

        if (url.pathname === '/api/entry' && req.method === 'POST') {
          const body = await readBody(req);
          // The SAME parser the bot uses, so a line typed in chat and a line typed in the app
          // cannot disagree about what it means.
          const parsed = parseEntry(String(body.text || ''), config.baseCurrency || 'EUR');
          if (!parsed) return json(res, 400, { error: "Didn't understand that. Try “out 40 food”." });
          if (parsed.badKind) return json(res, 400, { error: `Unknown kind “${parsed.badKind}”. One of: ${ACCOUNT_KINDS.join(', ')}.` });
          if (parsed.type === 'account') await store.saveAccount(parsed);
          else if (parsed.type === 'sub') await store.saveSub(parsed);
          else await store.addFlow(parsed);
          return json(res, 200, await state(asked()));
        }

        if (url.pathname === '/api/goal' && req.method === 'POST') {
          const body = await readBody(req);
          await store.setGoal({ monthly: Number(body.monthly) || 0, currency: body.currency || config.baseCurrency });
          return json(res, 200, await state(asked()));
        }

        if (url.pathname === '/api/plan' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.remove) await store.removePlanEvent(String(body.remove));
          else if (body.years) await store.setPlanYears(Number(body.years));
          else if (body.useMeasured !== undefined) await store.setPlanBase(body.useMeasured);
          else if (body.edit) await store.updatePlanEvent(String(body.edit), body.patch || {});
          else await store.addPlanEvent(body);
          return json(res, 200, await state(asked()));
        }

        // "I exchanged at 48 in May 2024." One fact, typed once, standing in for every holding
        // in that currency that has no rate of its own.
        if (url.pathname === '/api/fxbasis' && req.method === 'POST') {
          const body = await readBody(req);
          await store.setFxBasis(body.currency, body.rateThen, parseDate(body.at) ?? undefined);
          return json(res, 200, await state(asked()));
        }

        // An extra payment against a loan. This is the difference between what the schedule
        // says he owes and what he actually owes, and only he knows about it.
        if (url.pathname === '/api/payment' && req.method === 'POST') {
          const body = await readBody(req);
          const id = String(body.id || '');
          const saved = body.remove
            ? await store.removePayment(id, String(body.remove))
            : await store.addPayment(id, { at: parseDate(body.at) ?? Date.now(), amount: body.amount, note: body.note });
          if (!saved) return json(res, 400, { error: body.remove ? 'Nothing with that id' : 'That needs an amount.' });
          return json(res, 200, await state(asked()));
        }

        // Confirming that something which repeats has arrived again. One tap, because the
        // alternative is retyping the same salary line twelve times a year and eventually not
        // bothering — and a month missing its salary reads as a household that earned nothing.
        //
        // It records a REAL flow, identical to a typed one. Nothing is ever auto-created: the
        // app must never invent income he has not received.
        if (url.pathname === '/api/repeat' && req.method === 'POST') {
          const body = await readBody(req);
          const w = monthWindowOf(asked());
          const now = Date.now();
          // Dated into the month on screen, on the day it usually lands. Stamping it with
          // today's date while he is reading June would file June's rent in September.
          const day = Math.min(Math.max(1, Math.round(Number(body.day) || 1)), 28);
          const inThisMonth = now >= w.from && now <= w.to;
          const ts = inThisMonth ? now : w.from + (day - 1) * 86400000;
          const flow = cleanFlow({
            dir: body.dir, category: body.category, amount: body.amount,
            currency: body.currency, passive: body.passive, recurring: true, ts,
          });
          if (!(flow.amount > 0)) return json(res, 400, { error: 'That has no amount to repeat.' });
          await store.addFlow(flow);
          return json(res, 200, await state(asked()));
        }

        // A subscription charged. One tap turns the commitment into a real spend in the month,
        // tagged with the subscription it came from so the two tabs can never disagree.
        //
        // Never automatic. A subscription is what he has AGREED to pay; a flow is what has
        // actually left. Stamping charges on a schedule would fill his months with spending that
        // may have failed, been refunded, or been cancelled the week before.
        if (url.pathname === '/api/charge' && req.method === 'POST') {
          const body = await readBody(req);
          const sub = (await store.subs()).find((x) => x.id === String(body.id || ''));
          if (!sub) return json(res, 404, { error: 'No subscription with that id' });
          const w = monthWindowOf(asked());
          const now = Date.now();
          const inThisMonth = now >= w.from && now <= w.to;
          // Dated to the charge this month if there is one, so it replaces that projection
          // rather than sitting beside it.
          const dates = subChargeDates(sub, w);
          const ts = inThisMonth ? (dates.find((d) => d <= now) ?? dates[0] ?? now) : (dates[0] ?? w.from);
          await store.addFlow(cleanFlow({
            dir: 'out', category: sub.category || 'subscriptions', note: sub.label,
            amount: sub.amount, currency: sub.currency,
            ts,
            subId: sub.id,
            schedId: `sub:${sub.id}:${new Date(ts).toISOString().slice(0, 10)}`,
          }));
          return json(res, 200, await state(asked()));
        }

        // "It went through, and this is what it actually was." A scheduled payment already
        // counts in the month; confirming it turns the projection into a REAL flow carrying its
        // schedule id, which both replaces the projection (never adds to it) and makes it
        // editable — banks round, add fees, and miss days, and then his number beats ours.
        if (url.pathname === '/api/confirm' && req.method === 'POST') {
          const body = await readBody(req);
          const schedId = String(body.schedId || '');
          const w = monthWindowOf(asked());
          const accounts = await store.accounts();
          const already = new Set((await store.flows({ from: w.from, to: w.to })).map((f) => f.schedId).filter(Boolean));
          if (already.has(schedId)) return json(res, 200, await state(asked()));
          const hit = scheduledFlows(accounts, w, { now: Date.now(), subs: await store.subs() }).find((f) => f.schedId === schedId);
          if (!hit) return json(res, 404, { error: 'No scheduled payment with that id' });
          await store.addFlow(cleanFlow({
            dir: hit.dir, category: hit.category, note: hit.label,
            amount: body.amount != null && Number(body.amount) > 0 ? Number(body.amount) : hit.amount,
            currency: hit.currency, ts: hit.ts, passive: hit.passive, schedId,
          }));
          return json(res, 200, await state(asked()));
        }

        // Correcting something already recorded. Deliberately field-by-field rather than by
        // retyping the line: a mistyped amount fixed by retyping "out 40 food" produces a
        // SECOND entry, and a tracker that double-counts is worse than one that is wrong once.
        if (url.pathname === '/api/edit' && req.method === 'POST') {
          const body = await readBody(req);
          const kind = ['flow', 'sub'].includes(body.kind) ? body.kind : 'account';
          // patchFrom is the whitelist: only fields it knows reach storage, and an absent
          // field means "not being changed", never "delete it".
          const patch = patchFrom(kind, body.patch || {});
          if (!Object.keys(patch).length) return json(res, 400, { error: 'Nothing to change.' });
          const saved = kind === 'flow' ? await store.updateFlow(String(body.id || ''), patch)
            : kind === 'sub' ? await store.updateSub(String(body.id || ''), patch)
            : await store.updateAccount(String(body.id || ''), patch);
          if (!saved) return json(res, 404, { error: 'Nothing with that id' });
          return json(res, 200, await state(asked()));
        }

        if (url.pathname === '/api/remove' && req.method === 'POST') {
          const body = await readBody(req);
          const id = String(body.id || '');
          const gone = body.kind === 'flow' ? await store.removeFlow(id)
            : body.kind === 'sub' ? await store.removeSub(id)
            : await store.removeAccount(id);
          if (!gone) return json(res, 404, { error: 'Nothing with that id' });
          return json(res, 200, await state(asked()));
        }
        return json(res, 404, { error: 'no such endpoint' });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      console.error('[pocket/web]', err);
      json(res, 500, { error: err.message });
    }
  });
  server.listen(port, () => console.log(`[pocket] web on :${port}`));
  return server;
}
