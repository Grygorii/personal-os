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
import * as fx from '../fx.js';
import * as store from './store.js';
import {
  netWorth, monthOf, goalProgress, yearsToGoal, interestPicture, debtVsInvesting,
  parseEntry, ACCOUNT_KINDS, PAYOUT_KINDS, isLiability, forecastRange, depositProgress,
  monthWindowOf, recentMonths, monthsSummary, patchFrom, depositsSummary, contractedIncome,
  missingRecurring, cleanFlow, balanceNow,
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
export function buildState({ base = 'EUR', table, monthKey, accounts = [], spanFlows = [], goal = null, events = { years: 10, list: [] }, now = Date.now() }) {
  const { w, strip } = spanFor(monthKey, now);
  const flows = spanFlows.filter((f) => f.ts >= w.from && f.ts <= w.to);

  // Without rates nothing can be totalled honestly, so the page is told so rather than being
  // handed numbers that quietly exclude two of three currencies.
  if (!table) {
    return { base, ratesAvailable: false, accounts, flows, goal, kinds: ACCOUNT_KINDS, events: events.list };
  }

  const n = netWorth(accounts, table, base, now);
  const m = monthOf(flows, table, base, w);
  // The Goal and Plan tabs are always about NOW, never about whichever month he happens to be
  // reading. Browsing back to a thin August must not quietly rewrite the ten-year projection.
  const nowWindow = strip[strip.length - 1];
  const cur = w.key === nowWindow.key ? m : monthOf(spanFlows, table, base, nowWindow);
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
    months: monthsSummary(spanFlows, table, base, { count: STRIP_MONTHS, now }),
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
    flows: flows.map((f) => ({ ...f, inBase: fx.toBase(f.amount, f.currency, table) })),
    worth: { total: n.total, assets: n.assets, debts: n.debts, exposure: n.exposure, unconverted: n.unconverted },
    interest: { earned: ip.earned, paid: ip.paid, net: ip.net, ended: ip.ended, notStarted: ip.notStarted },
    // A term that is nearly up, or already up. A matured certificate sitting unnoticed is
    // capital earning nothing, and nothing else in the app would ever mention it again.
    terms: (() => {
      const ds = depositsSummary(accounts, now);
      const name = (r) => r.account.label || r.account.kind;
      return {
        maturingSoon: ds.maturingSoon.map((r) => ({ label: name(r), at: r.progress.end, days: Math.round(r.progress.remainingDays) })),
        matured: ds.matured.map((r) => ({
          label: name(r), at: r.progress.end,
          backInBase: fx.toBase(r.progress.valueAtMaturity, r.account.currency, table),
        })),
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
    // Things that repeat and have not been entered again. A list to confirm, never a total.
    missing: missingRecurring(spanFlows, w),
    payFirst: debtVsInvesting(accounts, { expectedYieldPct: 7, now }).filter((d) => d.payFirst),
    goal: g,
    plan: g ? yearsToGoal({ invested, monthlyContribution: Math.max(0, cur.surplus), goalMonthly: goal.monthly }) : null,
    // Ten years from what he ACTUALLY saved this month, plus whatever he has said will change.
    // Three yields, because over a decade the yield assumption is most of the answer.
    forecast: forecastRange({
      startCapital: invested,
      monthlySurplus: cur.surplus,
      monthlyPassiveNow: 0,
      years: Number(events.years) || 10,
      events: events.list,
      goalMonthly: goal?.monthly || 0,
    }),
    events: events.list,
    forecastYears: Number(events.years) || 10,
  };
}

/** The same payload, with the data fetched. Everything it does beyond loading is in buildState. */
async function state(monthKey) {
  const base = config.baseCurrency || 'EUR';
  let table = null;
  try { table = await fx.rates(base); } catch (e) { table = null; }

  const { span } = spanFor(monthKey);
  const [accounts, spanFlows, goal, events] = await Promise.all([
    store.accounts(), store.flows(span), store.getGoal(), store.getPlanEvents(),
  ]);
  return buildState({ base, table, monthKey, accounts, spanFlows, goal, events });
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
      if (url.pathname === '/health') return json(res, 200, { ok: true, app: 'pocket' });

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
          else await store.addPlanEvent(body);
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

        // Correcting something already recorded. Deliberately field-by-field rather than by
        // retyping the line: a mistyped amount fixed by retyping "out 40 food" produces a
        // SECOND entry, and a tracker that double-counts is worse than one that is wrong once.
        if (url.pathname === '/api/edit' && req.method === 'POST') {
          const body = await readBody(req);
          const kind = body.kind === 'flow' ? 'flow' : 'account';
          // patchFrom is the whitelist: only fields it knows reach storage, and an absent
          // field means "not being changed", never "delete it".
          const patch = patchFrom(kind, body.patch || {});
          if (!Object.keys(patch).length) return json(res, 400, { error: 'Nothing to change.' });
          const saved = kind === 'flow'
            ? await store.updateFlow(String(body.id || ''), patch)
            : await store.updateAccount(String(body.id || ''), patch);
          if (!saved) return json(res, 404, { error: 'Nothing with that id' });
          return json(res, 200, await state(asked()));
        }

        if (url.pathname === '/api/remove' && req.method === 'POST') {
          const body = await readBody(req);
          const id = String(body.id || '');
          const gone = body.kind === 'flow' ? await store.removeFlow(id) : await store.removeAccount(id);
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
