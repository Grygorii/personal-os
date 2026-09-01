// ---- The steward, in Telegram ----
//
// The old bot was a life coach: water, sleep, mood, quests, English. This replaces it
// entirely. It runs as its own deploy against its own database, so the rewrite cannot reach
// Kept, and the coach can keep running untouched until he decides to switch the token over.
//
// SINGLE USER, ON PURPOSE. It answers his chat id and nothing else. The old bot was built
// multi-tenant because the plan was to sell it; this one is his trading journal, holds his
// positions, and has no business being open to anybody. One check, at the door.

import { send, sendLong, sendInline, sendKeyboard } from '../telegram.js';
import { config } from '../config.js';
import * as store from './store.js';
import * as market from './market.js';
import * as brain from './brain.js';
import { parseTradeLine, positionMath, summarise, stale, brokenButHeld, checkRules, DEFAULT_RULES, incomeOf, dividendFlags, rebalancePlan, benchmarkCompare } from './book.js';

const money = (n) => (n == null ? 'n/a' : (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2));
const pct = (n) => (n == null ? '' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);

/** Prices for everything open, fetched once per command. */
async function priced(positions) {
  const open = positions.filter((p) => positionMath(p).open);
  const { prices, missing } = await market.quotes(open.map((p) => p.ticker));
  return { prices, missing };
}

async function cmdBook() {
  const positions = await store.allPositions();
  if (!positions.length) return 'Nothing in the book yet. Tell me a trade — "bought 10 MSTR at 402.50".';
  const { prices, missing } = await priced(positions);
  const b = summarise(positions, prices);
  if (!b.open.length) return `Nothing open. Realised to date: ${money(b.realised)}.`;

  const lines = b.open.map(({ p, v }) => {
    const head = `${p.ticker}  ${v.qty} @ ${v.avgCost.toFixed(2)}`;
    const now = v.value == null ? '— no price' : `${money(v.value)}  ${pct(v.pct)}`;
    const flag = !p.invalidation ? '  ⚠ no invalidation'
      : (p.checks[p.checks.length - 1]?.verdict === 'broken' ? '  ⛔ you called this broken' : '');
    return `${head}\n   ${now}${flag}`;
  });
  const out = [lines.join('\n'), '', `Valued ${money(b.totalValue)} · unrealised ${money(b.unrealised)} · realised ${money(b.realised)}`];

  // The number his strategy is actually judged on. Income first, then whether that income is
  // safe — a yield printed with no safety check beside it is the trap, not the goal.
  const { funds } = await market.fundamentalsFor(b.open.map(({ p }) => p.ticker));
  const inc = incomeOf(positions, prices, funds);
  if (inc.annual > 0) {
    out.push('', `Income ${money(inc.annual)}/yr · ${money(inc.monthly)}/mo · yield ${inc.portfolioYield.toFixed(2)}%`);
    const flagged = b.open
      .map(({ p }) => ({ ticker: p.ticker, flags: dividendFlags(funds[p.ticker]) }))
      .filter((f) => f.flags.length);
    for (const f of flagged) out.push(`⚠ ${f.ticker}: ${f.flags.join('; ')}`);
  } else if (market.providerName() !== 'finnhub') {
    out.push('', 'No dividend data yet — set MARKET_API_KEY (Finnhub, free tier) and I can show income, payout ratios and cut risk.');
  }

  // Never let a total quietly stand for less than the whole book.
  if (missing.length) out.push(`No price for ${missing.join(', ')} — not counted above.`);
  out.push(`Prices via ${market.providerName()}.`);
  return out.join('\n');
}

async function cmdTrade(parsed, rawText) {
  const { ticker, action, qty } = parsed;
  let price = parsed.price;
  let priceNote = '';
  if (price == null) {
    // No price typed: use a real one, and say where it came from. Never guess.
    try {
      const q = await market.quote(ticker);
      price = q.price;
      priceNote = `\nUsed ${market.describeQuote(q)} — correct me if you filled elsewhere.`;
    } catch (e) {
      return `What price did you fill ${ticker} at? I couldn't fetch one and I won't invent it.`;
    }
  }

  // Size check BEFORE recording, so the warning arrives while it is still a decision.
  let warnings = [];
  if (action === 'buy') {
    const positions = await store.allPositions();
    const { prices } = await priced(positions);
    const existing = positions.find((p) => p.ticker === ticker);
    warnings = checkRules({
      ticker, addValue: qty * price, book: summarise(positions, prices),
      rules: DEFAULT_RULES, invalidation: existing?.invalidation,
    });
  }

  const p = await store.recordTrade({ ticker, action, qty, price, note: rawText });
  const m = positionMath(p);
  const lines = [
    `${action === 'sell' ? 'Sold' : 'Bought'} ${qty} ${ticker} at ${price.toFixed(2)}.${priceNote}`,
    m.open ? `Now ${m.qty} @ avg ${m.avgCost.toFixed(2)}.` : `Position closed. Realised ${money(m.realised)}.`,
  ];
  if (warnings.length) lines.push('', ...warnings.map((w) => `⚠ ${w}`));
  if (action === 'buy' && !p.thesis) {
    lines.push('', 'Why this one? Reply "thesis <ticker> ..." — and "wrong if <ticker> ..." with what would prove it wrong. That second one is the whole point.');
  }
  return lines.join('\n');
}

/** The monthly question, answered arithmetically. "Do nothing" is the expected result and is
 *  printed as loudly as a trade would be — on a small book that answer is worth more than any
 *  suggestion, because the alternative is paying spreads to move a few dollars around. */
async function cmdRebalance(contribution) {
  const positions = await store.allPositions();
  if (!positions.filter((p) => positionMath(p).open).length) {
    return 'Nothing in the book yet. Once you own something, "target KO 8" sets what share it should be, and I check the drift from there.';
  }
  const { prices } = await priced(positions);
  const plan = rebalancePlan({ positions, prices, contribution });
  const out = [];

  const drifted = plan.drift.rows.filter((r) => r.drift != null);
  if (drifted.length) {
    out.push(drifted
      .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))
      .map((r) => `${r.ticker}  ${r.actualPct.toFixed(1)}% vs ${r.target}%  ${r.drift > 0 ? '+' : ''}${r.drift.toFixed(1)}${r.outside ? '  ⚠ outside band' : ''}`)
      .join('\n'));
  }
  if (contribution > 0) out.push('', `Putting in ${money(contribution)}:`);
  for (const b of plan.buys) out.push(`  Buy ${money(b.amount)} ${b.ticker} — ${b.why}`);
  for (const s of plan.sells) out.push(`  Trim ${money(s.amount)} ${s.ticker} — ${s.why}`);
  if (plan.notes.length) out.push('', ...plan.notes);
  return out.join('\n');
}

/** Did the picking beat just adding the money to the index?
 *  The one number that decides whether this whole exercise is worth his evenings. Built to be
 *  able to say no. */
async function cmdScore() {
  const positions = await store.allPositions();
  if (!positions.some((p) => p.entries.length)) return 'Nothing bought yet — nothing to score.';
  const bench = config.benchmark;
  const { prices } = await priced(positions);
  let series = null, benchNow = null;
  try {
    series = await market.history(bench);
    benchNow = (await market.quote(bench)).price;
  } catch (e) {
    return `Can't reach ${bench} history right now, so I won't guess at the comparison.`;
  }
  const s = benchmarkCompare({ positions, prices, series, benchNow, ticker: bench });
  const out = [
    `You put in ${money(s.contributed)}.`,
    `Your picks: ${money(s.actual)}`,
    `Same money in ${bench}: ${money(s.benchValue)}`,
    '',
    s.edge >= 0
      ? `You are ahead by ${money(s.edge)} (${s.edgePct.toFixed(1)}%).`
      : `You are behind by ${money(Math.abs(s.edge))} (${s.edgePct.toFixed(1)}%). The index would have done better, doing nothing.`,
  ];
  if (!s.trustworthy) out.push('', `${s.missingLegs} trade(s) had no ${bench} price on their date and are missing from this — treat it as rough.`);
  // Early numbers are noise, and a scoreboard that lets him conclude anything from six weeks
  // is worse than none.
  out.push('', 'Money-weighted, so buying more of a winner late does not flatter it. Under a year this is mostly noise — it starts meaning something around year two.');
  return out.join('\n');
}

async function cmdIdea(ticker, note) {
  const sym = market.cleanTicker(ticker);
  if (!sym) return 'Which ticker? e.g. "idea MSTR".';
  let quoteLine = null;
  try { quoteLine = market.describeQuote(await market.quote(sym)); } catch (e) { quoteLine = null; }
  const positions = await store.allPositions();
  const { prices } = await priced(positions);
  const prompt = await brain.idea({ ticker: sym, quote: quoteLine, positions, prices, note });
  return brain.think(prompt);
}

async function cmdCheck(ticker, verdict, note) {
  const p = await store.recordCheck({ ticker: String(ticker || '').toUpperCase(), verdict, note });
  if (!p) return `I don't have ${ticker} in the book.`;
  if (verdict === 'broken') {
    return `Noted: ${p.ticker} thesis broken.\n\nYou wrote it would be wrong if: "${p.invalidation || '(nothing written)'}"\n\nYou still hold ${positionMath(p).qty}. I'll keep asking about this one until it's closed or you change the verdict.`;
  }
  return `Noted: ${p.ticker} — ${verdict}.`;
}

export async function review(when = 'the weekly review') {
  const positions = await store.allPositions();
  if (!positions.filter((p) => positionMath(p).open).length) return null;
  const { prices } = await priced(positions);
  const prompt = await brain.reviewPrompt({
    positions, prices, when,
    stale: stale(positions), broken: brokenButHeld(positions),
  });
  return brain.think(prompt);
}

// ---- Buttons, not typing ----
// The persistent keyboard sits under the message box and never goes away, so the four things
// he does most are one tap each and he never has to remember a command. The labels ARE the
// commands: a tap sends the label as text, so it walks the same path as typing and there is
// no second code path to keep in sync.
export const KEYBOARD = [
  ['📓 Book', '⚖️ Rebalance'],
  ['📈 Score', '✅ Check theses'],
];
/** Strip the emoji so "📓 Book" routes exactly as "book" does. */
const stripIcon = (s) => String(s || '').replace(/^[^\p{L}\p{N}/]+/u, '').trim();

/** Positions needing a verdict, each with its own Yes/No buttons — the fastest possible way
 *  to answer the only question that matters, without typing a ticker. */
async function cmdCheckTheses(chatId) {
  const positions = await store.allPositions();
  const open = positions.filter((p) => positionMath(p).open);
  if (!open.length) return send('Nothing open to check.', chatId);
  const due = [...brokenButHeld(positions), ...stale(positions)];
  const list = due.length ? due : open;
  await send(due.length
    ? 'These need a verdict — does the thesis still hold?'
    : 'Everything is checked recently. Run through them anyway:', chatId);
  // Capped: twenty prompts in a row is not a review, it is a wall he will swipe past.
  for (const p of list.slice(0, 6)) {
    await sendInline(
      `*${p.ticker}* — you said it's wrong if:\n${p.invalidation || '_(nothing written — reply "wrong if ' + p.ticker + ' ..." )_'}`,
      [[{ text: '✅ Still holds', data: `holds ${p.ticker}` }, { text: '⛔ Broken', data: `broken ${p.ticker}` }]],
      chatId
    );
  }
  return null;
}

const HELP = `What I do — I keep your trade journal and argue with you about it.

Just type what you did:
  bought 10 MSTR at 402.50
  sold 5 MSTR @ 390

  book — what you hold, with live prices
  thesis MSTR ... — why you own it
  wrong if MSTR ... — what would prove you wrong
  holds MSTR / broken MSTR — does the thesis still stand?
  idea MSTR — the case for AND against, plus what I don't know
  score — did your picking beat just buying the index?
  review — what most needs your attention

I never place trades. You do that yourself, and nothing here can move money.`;

/** One message in, one reply out. A button tap arrives here as its own label, so there is
 *  exactly one path through this function whether he tapped or typed. */
export async function handle(text, chatId) {
  const s = stripIcon(text);
  if (!s) return null;
  const low = s.toLowerCase();

  if (/^\/?(start|help)\b/.test(low)) {
    await sendKeyboard(HELP, KEYBOARD, chatId);
    return null;
  }
  // Needs the chat id because it sends several messages with their own buttons rather than
  // returning one block of text.
  if (/^check theses$/i.test(s)) return cmdCheckTheses(chatId);
  if (/^\/?(book|status|portfolio)\b/.test(low)) return cmdBook();
  if (/^\/?(score|vs index|benchmark)\b/.test(low)) return cmdScore();
  if (/^\/?review\b/.test(low)) return (await review('a review he asked for just now')) || 'Nothing open to review.';

  let m;
  if ((m = s.match(/^\/?rebalance\s*(\d+(?:[.,]\d+)?)?/i))) return cmdRebalance(m[1] ? Number(m[1].replace(',', '.')) : 0);
  if ((m = s.match(/^\/?target\s+(\S+)\s+(\d+(?:[.,]\d+)?)\s*%?$/i))) {
    const p = await store.setTarget({ ticker: m[1].toUpperCase(), target: Number(m[2].replace(',', '.')) });
    if (!p) return `I don't have ${m[1].toUpperCase()} in the book. Record a buy first, or say "plan" to set the whole thing up.`;
    return `${p.ticker} target set to ${p.target}%.`;
  }
  if ((m = s.match(/^\/?idea\s+(\S+)\s*(.*)$/i))) return cmdIdea(m[1], m[2]);
  if ((m = s.match(/^\/?thesis\s+(\S+)\s+(.+)$/i))) {
    const p = await store.setThesis({ ticker: m[1].toUpperCase(), thesis: m[2] });
    if (!p) return `I don't have ${m[1].toUpperCase()} in the book.`;
    return p.invalidation ? `Thesis saved for ${p.ticker}.` : `Thesis saved for ${p.ticker}.\n\nNow the harder half: "wrong if ${p.ticker} ..." — what would tell you this isn't working?`;
  }
  if ((m = s.match(/^\/?wrong\s*if\s+(\S+)\s+(.+)$/i))) {
    const p = await store.setThesis({ ticker: m[1].toUpperCase(), invalidation: m[2] });
    return p ? `Saved. ${p.ticker} is wrong if: ${p.invalidation}` : `I don't have ${m[1].toUpperCase()} in the book.`;
  }
  if ((m = s.match(/^\/?(holds|broken|unclear)\s+(\S+)\s*(.*)$/i))) return cmdCheck(m[2], m[1].toLowerCase(), m[3]);

  const trade = parseTradeLine(s);
  if (trade) return cmdTrade(trade, s);

  // Anything else is a question about the book. It gets the same facts and the same rules —
  // there is no path to the model that skips the "never invent a number" instruction.
  const positions = await store.allPositions();
  const { prices } = await priced(positions);
  const prompt = await brain.reviewPrompt({ positions, prices, when: 'answering his question', stale: [], broken: brokenButHeld(positions) });
  return brain.think({ system: prompt.system, user: `${prompt.user}\n\nHe asked: ${s}` });
}

/** Telegram's inbound shape → handle(). Single-user gate lives here. */
export async function route({ chatId, text }) {
  if (String(chatId) !== String(config.telegramChatId)) {
    await send("This bot is one person's trading journal.", chatId);
    return;
  }
  try {
    const reply = await handle(text, chatId);
    if (reply) await sendLong(reply, chatId);
  } catch (err) {
    console.error('[steward] handler failed:', err);
    // Never leave a message unanswered. Silence after "bought 10 MSTR" reads as "it recorded
    // the trade" — the one wrong impression this bot must never give.
    await send(`Something broke handling that — nothing was recorded. ${err.message}`, chatId);
  }
}

/** The scheduled check-ins. Idle chatter is what made the old bot easy to ignore, so these
 *  only speak when the book gives them something to say: review() returns null on an empty
 *  book, and a quiet week produces no message at all. */
export const SCHEDULE = [
  // Weekday morning, before the market opens in New York and while he still has a choice
  // about the day. The old coach's slot, pointed at money.
  { id: 'steward-morning', cron: '0 8 * * 1-5', run: () => review('the weekday morning check-in, before the US open') },
  // Sunday evening: the real one. Nothing to trade on, which is exactly when a thesis can be
  // looked at honestly.
  { id: 'steward-weekly', cron: '0 18 * * 0', run: () => review('the Sunday review — the week just gone, and what he has stopped looking at') },
];

export async function runScheduled(id, chatId = config.telegramChatId) {
  const job = SCHEDULE.find((j) => j.id === id);
  if (!job) return;
  const text = await job.run();
  if (!text) return;                       // nothing worth saying beats saying something
  await sendLong(text, chatId);
  await sendInline('', [[{ text: '📓 Book', data: 'book' }, { text: '⚖️ Check theses', data: 'check theses' }]], chatId)
    .catch(() => {});                      // the buttons are a convenience, never the message
}
