// ---- Pocket, in Telegram ----
//
// Entering a transaction has to cost nothing or it does not happen. So the whole grammar is
// one line: "out 40 food", "in 3200 salary", "in 27000 EGP rent". Currency is optional and
// defaults to the base — but the moment a number IS in another currency, saying so is one
// word, and the app never guesses.
//
// Single user, like the steward. It holds his household's finances and has no business being
// open to anybody.

import { send, sendLong, sendKeyboard, sendDocument } from '../telegram.js';
import { config } from '../config.js';
import * as fx from '../fx.js';
import * as store from './store.js';
import { netWorth, monthOf, goalProgress, yearsToGoal, ACCOUNT_KINDS, parseEntry, interestPicture, debtVsInvesting, isLiability, subPerYear, subsSummary } from './money.js';

const BASE = () => (config.baseCurrency || 'EUR');
const fmt = (n, cur = BASE()) =>
  n == null ? '—' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${cur}`;

export const KEYBOARD = [
  ['💶 Month', '🏦 Worth'],
  ['🎯 Goal', '➕ Add'],
];
const stripIcon = (s) => String(s || '').replace(/^[^\p{L}\p{N}/]+/u, '').trim();

/** The month he is actually in, in his timezone. */
function monthWindow(now = new Date()) {
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1;
  return { from, to };
}

async function table() {
  try { return await fx.rates(BASE()); } catch (e) { return null; }
}

async function cmdMonth() {
  const t = await table();
  if (!t) return "Can't reach the exchange rates right now, so I won't total anything I'd have to guess at.";
  const w = monthWindow();
  const list = await store.flows(w);
  const m = monthOf(list, t, BASE(), w);
  if (!list.length) return 'Nothing recorded this month yet. Try "in 3200 salary" or "out 40 food".';

  const out = [
    `In ${fmt(m.income)} · out ${fmt(m.spending)}`,
    `Surplus ${fmt(m.surplus)}${m.savingsRatePct != null ? ` (${m.savingsRatePct.toFixed(0)}% saved)` : ''}`,
  ];
  if (m.passive > 0) out.push(`Passive ${fmt(m.passive)}`);
  if (m.spendingByCategory.length) {
    out.push('', 'Where it went:');
    for (const c of m.spendingByCategory.slice(0, 8)) out.push(`  ${c.category}  ${fmt(c.amount)}`);
  }
  if (m.unconverted.length) out.push('', `⚠ No rate for ${m.unconverted.join(', ')} — not counted above.`);
  out.push('', `Rates ${fx.rateAge(t)}.`);
  return out.join('\n');
}

async function cmdWorth() {
  const t = await table();
  if (!t) return "Can't reach the exchange rates right now, so I won't total anything I'd have to guess at.";
  const list = await store.accounts();
  if (!list.length) return 'Nothing added yet. Try "add deposit 540000 EGP Cairo savings" or "add property 2700000 EGP flat".';
  const n = netWorth(list, t, BASE());

  const out = list.map((a) => {
    const rate = a.ratePct != null ? `  ${a.ratePct}%` : '';
    return `${isLiability(a.kind) ? '−' : ''}${a.label || a.kind}  ${fx.describeAmount(a.value, a.currency, t, BASE())}${rate}`;
  });
  out.push('', `Assets ${fmt(n.assets)}${n.debts > 0 ? ` · owed ${fmt(n.debts)}` : ''}`);
  out.push(`Net worth ${fmt(n.total)}`);

  // What the rates do over a year, and then the one question anyone holding both a credit and
  // a portfolio should answer before choosing between them.
  const ip = interestPicture(list, t, BASE());
  if (ip.earned > 0 || ip.paid > 0) {
    out.push('', `Interest: earning ${fmt(ip.earned)}/yr · paying ${fmt(ip.paid)}/yr · net ${fmt(ip.net)}/yr`);
  }
  for (const d of debtVsInvesting(list, { expectedYieldPct: 7 })) {
    if (!d.payFirst) continue;
    out.push('', `⚠ ${d.label} costs ${d.ratePct}% a year. Clearing it is a guaranteed ${d.ratePct}% return — better than the ${d.expectedYieldPct}% you'd hope for investing, and with no risk at all. Pay this before you buy anything.`);
  }

  // The number that matters most for this household, and the one a single euro total hides.
  if (n.exposure.length > 1) {
    out.push('', 'Currency exposure:');
    for (const e of n.exposure) out.push(`  ${e.currency}  ${e.pct.toFixed(0)}%`);
    const foreign = n.exposure.find((e) => e.currency !== BASE());
    if (foreign && foreign.pct > 50) {
      out.push('', `⚠ ${foreign.pct.toFixed(0)}% of what you own is in ${foreign.currency}, which is not what you spend. If it falls 20%, so does most of your net worth — regardless of what the assets themselves do.`);
    }
  }
  if (n.unconverted.length) out.push('', `⚠ No rate for ${n.unconverted.join(', ')} — not in the total.`);
  out.push('', `Rates ${fx.rateAge(t)}.`);
  return out.join('\n');
}

async function cmdGoal() {
  const goal = await store.getGoal();
  if (!goal?.monthly) return 'No goal set. "goal 2000" = 2,000 a month in passive income.';
  const t = await table();
  if (!t) return "Can't reach the exchange rates right now.";
  const w = monthWindow();
  const m = monthOf(await store.flows(w), t, BASE(), w);
  const g = goalProgress(m.passive, goal);
  const accounts = await store.accounts();
  const invested = netWorth(accounts.filter((a) => ['portfolio', 'deposit'].includes(a.kind)), t, BASE()).total;

  const out = [
    `${fmt(g.now, g.currency)} of ${fmt(g.target, g.currency)} a month — ${g.pct.toFixed(1)}%`,
    `Gap: ${fmt(g.gap, g.currency)} a month`,
  ];

  const y = yearsToGoal({ invested, monthlyContribution: Math.max(0, m.surplus), goalMonthly: goal.monthly });
  if (y?.fastest != null) {
    out.push('', 'At what you saved this month:');
    for (const s of y.scenarios) {
      out.push(`  ${s.yieldPct.toFixed(1)}% yield → needs ${fmt(s.capitalNeeded)} · ${s.years == null ? 'not reachable' : `${s.years} years`}`);
    }
    // A range with its assumptions attached, never a date. The whole point of not being the
    // 31-year projection he was shown.
    out.push('', `So roughly ${y.fastest}–${y.slowest} years, and that assumes ${y.assumes}.`);
    out.push('Saving more moves this far faster than picking better does.');
  } else if (y) {
    out.push('', 'With nothing being saved each month, this goal is not reachable. The savings rate is the lever, not the returns.');
  }
  return out.join('\n');
}

async function cmdSubs() {
  const t = await table();
  if (!t) return "Can't reach the exchange rates right now, so I won't total anything I'd have to guess at.";
  const list = await store.subs();
  if (!list.length) return 'Nothing yet. Try "sub 12.99 netflix monthly".';
  const s = subsSummary(list, t, BASE());

  const out = s.rows.filter((r) => !r.ended).map((r) =>
    `${r.label}  ${r.amount} ${r.currency} ${r.every}  →  ${fmt(r.perYearInBase)}/yr${r.next ? `  (next ${new Date(r.next).toISOString().slice(0, 10)})` : ''}`);
  out.push('', `${s.count} subscriptions · ${fmt(s.perYear)} a year · ${fmt(s.perMonth)} a month`);
  if (s.capitalNeeded.length) {
    // The line an expense tracker never says: a bill that never ends is funded by capital.
    out.push('', `To pay that for ever without working you need ${fmt(s.capitalNeeded[1].capital)}–${fmt(s.capitalNeeded[0].capital)} invested behind it.`);
    out.push('Cancelling one is worth years of contributions.');
  }
  if (s.trials.length) out.push('', `⚠ Still free: ${s.trials.map((r) => `${r.label} until ${new Date(r.trialEndsAt).toISOString().slice(0, 10)}`).join(', ')}`);
  if (s.unconverted.length) out.push('', `⚠ No rate for ${s.unconverted.join(', ')} — not in the totals.`);
  return out.join('\n');
}

const HELP = `Pocket — what comes in, what goes out, and what it adds up to.

Money moving:
  in 3200 salary
  out 40 food
  in 27000 EGP rent        (any currency, just say which)
  out 1400 EUR rent

What you own:
  add deposit 540000 EGP Cairo savings
  add property 2700000 EGP apartment pays 27000 monthly
                           (a flat does not have a rate — it has rent. Put the rent in
                            and the app works out the yield, and drops it into every
                            month as passive income towards the goal.)
  add portfolio 1000 USD eToro
  add deposit 540000 EGP 20% Cairo savings     (a rate, if it pays one)
  add loan 200000 EGP 24% car credit           (a credit you owe)
  add deposit 495000 EGP 20% quarterly start 28.05.2024 end 28.05.2027
                           (dates and how often it pays — that is what turns
                            a rate into an amount on a date you can plan around)
  add loan 445000 EGP 24% quarterly pays 58063.45 start 28.11.2024 end 28.05.2027
                           ("pays" is what your statement actually charges. A loan
                            repays principal too, so the rate alone is half the bill —
                            and the payment is what reveals the real rate.)
  accounts                 — list them, with ids to remove

What you subscribe to:
  sub 12.99 netflix monthly
  sub 90 icloud yearly
  sub 4500 EGP kvartally gym
  sub 45 EUR quarterly gym from 01.03.2025
                           (a subscription is agreed once and charges for ever, so it
                            is a thing here and not a spend. The app normalises them
                            all to a year — 90 a year is cheaper than 9 a month and
                            does not look it — and says what the whole bill costs in
                            capital, because a bill that never ends needs capital that
                            never ends.)

  month    — in, out, surplus, where it went
  worth    — net worth in ${'{base}'}, and what currency it's really in
  goal 2000 — target monthly passive income
  goal     — how far along, and honestly how long
  backup   — everything, as a file, into this chat

Everything is stored in the currency it's actually in. Nothing is converted until it's shown.`;

export async function handle(text, chatId) {
  const s = stripIcon(text);
  if (!s) return null;
  const low = s.toLowerCase();

  if (/^\/?(start|help)\b/.test(low)) {
    await sendKeyboard(HELP.replace('{base}', BASE()), KEYBOARD, chatId);
    return null;
  }
  if (/^\/?(month|spending|income)\b/.test(low)) return cmdMonth();
  if (/^\/?(worth|net worth|accounts?)\b/.test(low)) return cmdWorth();
  if (/^\/?subs(criptions?)?$/.test(low)) return cmdSubs();

  // A copy of everything, as a file, into a chat he keeps for ever. The backup must not live in
  // the thing being backed up.
  if (/^\/?(backup|export)\b/.test(low)) {
    const data = await store.exportAll();
    const json = JSON.stringify(data, null, 2);
    const name = `pocket-${new Date().toISOString().slice(0, 10)}.json`;
    await sendDocument(name, json,
      `Everything: ${data.counts.accounts} holdings, ${data.counts.flows} entries, ${data.counts.subs} subscriptions.\n`
      + 'Keep it. Deleting something here has no undo, and this file is the only copy that is not in the database.',
      chatId);
    return null;
  }

  let m;
  if ((m = s.match(/^\/?goal\s+(\d+(?:[.,]\d+)?)\s*([A-Za-z]{3})?$/i))) {
    const g = await store.setGoal({ monthly: Number(m[1].replace(',', '.')), currency: m[2] || BASE() });
    return `Goal set: ${fmt(g.monthly, g.currency)} a month in passive income.\n\nSay "goal" any time for how far along you are.`;
  }
  if (/^\/?goal\b/i.test(low)) return cmdGoal();

  // One parser, tested, shared by both shapes. It decides in code whether a three-letter word
  // is a currency, because "salary" is not one.
  const p = parseEntry(s, BASE());
  if (!p) return 'Not sure what that is. "in 3200 salary", "out 40 food", or "help".';
  const t = await table();

  if (p.type === 'sub') {
    const saved = await store.saveSub(p);
    const perYear = subPerYear(saved);
    const shown = t ? fx.describeAmount(perYear, saved.currency, t, BASE()) : `${perYear} ${saved.currency}`;
    // The yearly figure, always, because the monthly one is the number that hides the decision.
    return `Subscribed: ${saved.label} — ${saved.amount} ${saved.currency} ${saved.every}.\nThat is ${shown} a year.`;
  }

  if (p.type === 'account') {
    if (p.badKind) return `I don't know the kind "${p.badKind}". One of: ${ACCOUNT_KINDS.join(', ')}.`;
    const a = await store.saveAccount(p);
    return `Added: ${a.label} — ${t ? fx.describeAmount(a.value, a.currency, t, BASE()) : `${a.value} ${a.currency}`}\nid ${a.id}`;
  }

  const f = await store.addFlow(p);
  const shown = t ? fx.describeAmount(f.amount, f.currency, t, BASE()) : `${f.amount} ${f.currency}`;
  return `${f.dir === 'in' ? 'In' : 'Out'}: ${shown} — ${f.category}${f.passive ? ' (passive)' : ''}`;
}

export async function route({ chatId, text }) {
  if (String(chatId) !== String(config.telegramChatId)) {
    await send("This one's private.", chatId);
    return;
  }
  try {
    const reply = await handle(text, chatId);
    if (reply) await sendLong(reply, chatId);
  } catch (err) {
    console.error('[pocket] handler failed:', err);
    // Silence after "out 40 food" reads as "recorded". It must never read as that when it isn't.
    await send(`Something broke — nothing was recorded. ${err.message}`, chatId);
  }
}
