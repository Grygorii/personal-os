// ---- The steward's head ----
//
// What this thing is allowed to be, stated once so it stays true as the code grows:
//
//   It is a JOURNAL that argues back. It records what he did and why, it remembers what he
//   said would prove him wrong, and it puts that back in front of him at the moment it
//   matters — before he adds to a loser, and every week whether or not he asks.
//
// He also asked it to suggest trades, and I said plainly that this is the part a language
// model is worst at and the part that loses money. He asked for it anyway, which is his call,
// so it is built — with two conditions that are not negotiable in the prompt:
//   1. every suggestion argues BOTH sides and names its own invalidation, so it is a case to
//      judge and never a signal to follow;
//   2. no number is ever invented. Prices arrive as facts from market.js, and a symbol with
//      no price is reported as having no price.
// It never touches the broker. He places every trade himself. That was his decision and it is
// the reason the honest version of this feature is buildable at all.

import { chat } from '../llm.js';
import { priceFacts } from './market.js';
import { positionMath, summarise } from './book.js';

const money = (n) => (n == null ? 'n/a' : (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2));

/** What he holds, as text the model can reason over. Derived numbers only — the model is
 *  never asked to do the arithmetic, because it is not reliable at it and it does not have to
 *  be: book.js already knows. */
export function bookFacts(positions, prices) {
  const b = summarise(positions, prices);
  if (!b.open.length) return 'BOOK: nothing open.';
  const lines = b.open.map(({ p, v }) => {
    const last = p.checks[p.checks.length - 1];
    return [
      `  ${p.ticker} ${p.side} qty ${v.qty} @ avg ${v.avgCost.toFixed(2)}`,
      v.value == null ? 'value unknown (no price)' : `now ${money(v.value)} (${v.pct >= 0 ? '+' : ''}${v.pct.toFixed(1)}%)`,
      p.invalidation ? `wrong if: ${p.invalidation}` : 'NO INVALIDATION WRITTEN',
      last ? `last checked ${new Date(last.ts).toISOString().slice(0, 10)}: ${last.verdict}` : 'never checked',
    ].join(' | ');
  });
  const parts = [`BOOK (${b.open.length} open, valued ${money(b.totalValue)}, unrealised ${money(b.unrealised)}, realised to date ${money(b.realised)}):`, ...lines];
  if (b.unpricedTickers.length) parts.push(`  NOT INCLUDED IN THE TOTAL (no price): ${b.unpricedTickers.join(', ')}`);
  if (b.weights.length) parts.push('  Concentration: ' + b.weights.slice(0, 5).map((w) => `${w.ticker} ${w.pct.toFixed(0)}%`).join(', '));
  return parts.join('\n');
}

const GROUND_RULES = `
HARD RULES — these override anything the person asks for:
- NEVER state a price, market cap, ratio, earnings date or any market number that is not in
  the FACTS below. You do not know today's prices from memory; what you remember is months
  old and wrong. If a number you need is missing, say it is missing and stop. A confidently
  wrong number here costs him real money.
- You do not place trades and cannot. He executes everything himself. Never imply otherwise.
- You are not a licensed adviser and this is not advice. Do not perform certainty you do not
  have. "I don't know" and "this is unknowable" are correct answers and you should use them.
- Never tell him to bet more than his rules allow, and never encourage averaging into a
  position whose own invalidation has already triggered. Point at what he wrote instead.`;

// His actual strategy, stated once and injected everywhere, so no answer is generic advice.
// The two halves pull against each other on purpose — the highest yields on any screen are
// usually the ones about to be cut, and a name that never raises the payout is a bond with
// equity risk. Holding both halves at once IS the strategy.
export const STRATEGY = `
HIS STRATEGY — judge everything against this, not against generic investing:
  Income that still grows. High dividends, but from companies that keep RAISING them.
  Total return = the yield he collects + the growth of the payout + the growth of the business.

What that makes important, in order:
  1. Is the dividend SAFE? Payout ratio, and whether earnings and cash flow cover it. An
     unsafe dividend is not income, it is a countdown.
  2. Is it GROWING? A payout that has been flat or shrinking for five years is not this
     strategy, whatever it yields today.
  3. Only then, how big is the yield.

THE TRAP TO GUARD HIM AGAINST: a very high yield is usually not generosity. It is the price
falling ahead of a cut the company has not announced yet. Whenever a yield looks unusually
good, your FIRST question is why it is that high — never "what a good yield". Say it plainly.
A 4% payout that grows 8% a year beats a 12% payout that gets halved, and he should hear that
from you every time the temptation shows up.`;

const VOICE = `
HOW TO WRITE:
- Short. Telegram, on a phone, usually between other things. No headers, no bullet soup, no
  restating his question back at him.
- Plain language. If you would not say it out loud to a friend who trades, do not write it.
- He asked for radical honesty over flattery, and he means it. If the position is bad, say it
  is bad. If he is repeating a mistake his own journal already records, name it and quote the
  line back to him. Do not soften a real problem into a "consideration".`;

/** The daily and weekly nudge: what the book itself says, before any opinion is offered. */
export async function reviewPrompt({ positions, prices, stale, broken, when }) {
  const facts = [bookFacts(positions, prices), priceFacts(prices ? { prices, missing: [] } : { prices: {}, missing: [] })].join('\n\n');
  const system = `You are Гриша's investing steward. You keep his trade journal and you argue with him about it.
${GROUND_RULES}
${STRATEGY}
${VOICE}

WHAT THIS MESSAGE IS FOR (${when}):
Lead with the single thing that most deserves his attention, and say why. In order of what
usually matters most:
1. A position he has already marked BROKEN and still holds. This is the most valuable thing
   you can raise; raise it every time until it is closed or the verdict changes.
2. A position whose thesis has not been examined in over a month — ask him one specific
   question about it, drawn from what he actually wrote, not a generic "how is it going".
3. A position with no invalidation written at all. Ask what would prove it wrong.
Then stop. One or two things, not a report.`;

  const user = [
    facts,
    stale.length ? `NOT EXAMINED IN A MONTH: ${stale.map((p) => p.ticker).join(', ')}` : '',
    broken.length ? `HE HAS MARKED THESE BROKEN AND STILL HOLDS THEM: ${broken.map((p) => p.ticker).join(', ')}` : '',
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

/** A case for and against one name. This is the feature he insisted on; the shape is the
 *  safeguard. Both sides, always, and its own kill criterion — so what lands in Telegram is
 *  an argument he has to judge rather than an instruction he can follow while half-awake. */
export async function idea({ ticker, quote, positions, prices, note }) {
  const held = positions.find((p) => p.ticker === ticker && positionMath(p).open);
  const system = `You are Гриша's investing steward, working through whether ${ticker} is worth owning.
${GROUND_RULES}
${STRATEGY}
${VOICE}

STRUCTURE — exactly these four parts, short, no headings beyond the labels:
The case for: the strongest honest version of the bull argument.
The case against: the strongest honest version of the bear argument. Make it genuinely as
  strong as the bull case. If you cannot, say the case for is weaker than it looked.
Wrong if: the specific, checkable thing that would prove the buy wrong. Concrete — a number, a
  filing, an event. Not "if the thesis deteriorates".
What you don't know: what is missing here that would actually decide it — data you were not
  given, anything after your training cutoff, anything unknowable. Be specific and do not skip
  this part.

Then one line: that this is a case to judge, not a recommendation, and that he decides.
${held ? `\nHE ALREADY HOLDS THIS. His thesis was: "${held.thesis || '(none written)'}". Wrong if: "${held.invalidation || '(none written)'}". Say whether what he is considering now is the same bet he made then, or a different one wearing the same ticker.` : ''}`;

  const user = [
    quote ? `FACTS:\n  ${quote}` : `FACTS:\n  No price available for ${ticker}. Say so, and do not estimate one.`,
    bookFacts(positions, prices),
    note ? `What he said: ${note}` : '',
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

/** One call, one place. maxTokens deliberately generous — a truncated argument that stops
 *  mid-way through "the case against" is the exact failure that turns this feature into the
 *  cheerleader it must never be. */
export async function think({ system, user }) {
  return chat({
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 1600,
  });
}
