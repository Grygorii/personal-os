// ---- Reading the filing ----
//
// His whole strategy rests on one question: IS THE DIVIDEND SAFE? The payout ratio in
// market.js approximates it from a single vendor metric, and that metric hides the thing that
// actually matters — a company can pay a dividend its earnings cover on paper while funding it
// out of borrowings. The answer lives in the cash flow statement, in a document, in prose.
//
// Reading a long document and pulling the right figures out of it is what a language model is
// genuinely good at. Deciding whether 4,182 divided by 3,910 clears 1.2 is what it is bad at.
// So the split here is strict:
//
//     THE MODEL EXTRACTS. THE CODE DECIDES.
//
// Every ratio below is computed in JavaScript from figures the model copied out of the filing,
// and never asked of the model itself. That is the same rule as market.js — a number that
// decides something must come from somewhere that cannot be talked out of it.
//
// This runs on Railway, which has ordinary internet access, so the bot can fetch a filing
// itself. (The sandbox this was written in cannot reach most of the web, so the fetch path is
// untested end to end — see docs/steward.md.)

import { chat } from '../llm.js';

const num = (v) => {
  if (v == null || v === '') return null;
  // Filings write negatives as "(1,234)" and scale as "1,234.5 million".
  const s = String(v).trim().replace(/,/g, '');
  const neg = /^\(.*\)$/.test(s);
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  if (/billion|bn\b/i.test(s)) n *= 1e9;
  else if (/million|mm?\b/i.test(s)) n *= 1e6;
  else if (/thousand|\bk\b/i.test(s)) n *= 1e3;
  return neg ? -Math.abs(n) : n;
};
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

const MAX_DOC = 400_000;   // characters. Roughly a 10-K; beyond this we say so rather than trim silently.

/** HTML to something readable. Deliberately crude — the model does not need the layout, and a
 *  real parser is a dependency for no gain. Script and style go first, or their contents end
 *  up in the text as though they were prose. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function fetchDocument(url) {
  const u = new URL(url);
  // http(s) only. A file: or data: URL here would read the bot's own disk or smuggle content
  // past the fetch entirely.
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s) URLs');
  const res = await fetch(u.toString(), {
    headers: { 'User-Agent': 'personal-os-steward/1.0', Accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${res.status} fetching that page`);
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  const text = /html|xml/i.test(type) ? htmlToText(body) : body;
  return {
    text: text.slice(0, MAX_DOC),
    // Truncation is REPORTED, never silent. A coverage ratio computed from the first third of
    // a filing is worse than no ratio, because it looks like an answer.
    truncated: text.length > MAX_DOC,
    chars: text.length,
    url: u.toString(),
  };
}

/** The figures that decide whether a dividend survives. Everything is nullable on purpose —
 *  a filing that does not state capex must produce "unknown", not zero. */
export function cleanFigures(raw) {
  const f = raw || {};
  return {
    period: txt(f.period, 40),
    currency: txt(f.currency, 8).toUpperCase(),
    scale: txt(f.scale, 24),
    revenue: num(f.revenue),
    netIncome: num(f.netIncome),
    operatingCashFlow: num(f.operatingCashFlow),
    capex: num(f.capex) == null ? null : Math.abs(num(f.capex)),
    dividendsPaid: num(f.dividendsPaid) == null ? null : Math.abs(num(f.dividendsPaid)),
    buybacks: num(f.buybacks) == null ? null : Math.abs(num(f.buybacks)),
    totalDebt: num(f.totalDebt),
    cash: num(f.cash),
    sharesOutstanding: num(f.sharesOutstanding),
    dividendLanguage: txt(f.dividendLanguage, 600),
    concerns: (Array.isArray(f.concerns) ? f.concerns : []).slice(0, 6).map((c) => txt(c, 300)).filter(Boolean),
  };
}

/** The arithmetic. In code, from figures the model copied — never asked of the model.
 *
 *  FREE CASH FLOW COVER IS THE NUMBER. Earnings cover is easy to flatter with accounting;
 *  cash either came in or it did not, and the dividend is paid in cash. Below 1.0 the payout
 *  is being funded from somewhere other than the business. */
export function coverageOf(f) {
  const fcf = f.operatingCashFlow != null && f.capex != null ? f.operatingCashFlow - f.capex : null;
  const div = f.dividendsPaid;
  const has = (v) => v != null && Number.isFinite(v);
  return {
    freeCashFlow: fcf,
    netDebt: has(f.totalDebt) && has(f.cash) ? f.totalDebt - f.cash : null,
    fcfCover: has(fcf) && has(div) && div > 0 ? fcf / div : null,
    earningsCover: has(f.netIncome) && has(div) && div > 0 ? f.netIncome / div : null,
    // Buybacks compete with the dividend for the same cash. A company covering its dividend
    // 1.1x while also buying back stock is not covering both.
    fcfCoverWithBuybacks: has(fcf) && has(div) && div > 0 && has(f.buybacks)
      ? fcf / (div + f.buybacks) : null,
  };
}

export function digestFlags(f, c) {
  const flags = [];
  if (c.fcfCover != null) {
    if (c.fcfCover < 1) flags.push(`Free cash flow covers the dividend only ${c.fcfCover.toFixed(2)}x — the payout is NOT funded by the business.`);
    else if (c.fcfCover < 1.2) flags.push(`Free cash flow cover is ${c.fcfCover.toFixed(2)}x — barely covered, no room for a bad year.`);
  }
  if (c.fcfCover != null && c.fcfCoverWithBuybacks != null && c.fcfCoverWithBuybacks < 1 && c.fcfCover >= 1) {
    flags.push(`Covered on the dividend alone, but not once buybacks are counted (${c.fcfCoverWithBuybacks.toFixed(2)}x) — the two compete for the same cash.`);
  }
  if (c.earningsCover != null && c.fcfCover != null && c.earningsCover > 1.3 && c.fcfCover < 1) {
    flags.push('Earnings cover the dividend but cash does not — the gap between profit and cash is where a cut hides.');
  }
  if (c.netDebt != null && c.freeCashFlow != null && c.freeCashFlow > 0 && c.netDebt / c.freeCashFlow > 8) {
    flags.push(`Net debt is ${(c.netDebt / c.freeCashFlow).toFixed(0)}x free cash flow — the dividend competes with the lenders.`);
  }
  if (f.dividendsPaid == null) flags.push('Dividends paid not found in what I read — coverage is unknown, not fine.');
  if (f.operatingCashFlow == null || f.capex == null) flags.push('Cash flow figures incomplete — free cash flow could not be computed.');
  return flags;
}

/** The same company, last time. This is where it stops being a summary and starts being a
 *  watch: a single quarter's cover means little, and cover falling from 1.8x to 1.05x over
 *  three quarters is the whole story. */
export function compareDigests(now, prev) {
  if (!prev) return [];
  const out = [];
  const move = (label, a, b, unit = 'x', better = 'up') => {
    if (a == null || b == null) return;
    const delta = a - b;
    if (Math.abs(delta) < 1e-9) return;
    const dir = delta > 0 ? 'up' : 'down';
    const bad = (better === 'up' && delta < 0) || (better === 'down' && delta > 0);
    out.push(`${label} ${dir} from ${b.toFixed(2)}${unit} to ${a.toFixed(2)}${unit}${bad ? '  ⚠' : ''}`);
  };
  move('FCF cover', now.coverage?.fcfCover, prev.coverage?.fcfCover);
  move('Earnings cover', now.coverage?.earningsCover, prev.coverage?.earningsCover);
  if (now.figures?.dividendsPaid != null && prev.figures?.dividendsPaid != null) {
    const d = now.figures.dividendsPaid - prev.figures.dividendsPaid;
    if (d < 0) out.push(`Dividends paid FELL from ${prev.figures.dividendsPaid} to ${now.figures.dividendsPaid}  ⚠`);
  }
  return out;
}

const SYSTEM = `You are reading a company filing for someone whose strategy is high dividends that keep growing. His one question is whether the dividend is safe.

Reply with ONLY a JSON object, no fence and no commentary:
{
  "period": "the period this covers, e.g. FY2025 or Q3 2026",
  "currency": "reporting currency, e.g. USD",
  "scale": "the units the statements are in, e.g. 'thousands' or 'millions' — say exactly what the document says",
  "revenue": number or null,
  "netIncome": number or null,
  "operatingCashFlow": number or null,
  "capex": number or null,
  "dividendsPaid": number or null,
  "buybacks": number or null,
  "totalDebt": number or null,
  "cash": number or null,
  "sharesOutstanding": number or null,
  "dividendLanguage": "the most important sentence management wrote about the dividend, quoted",
  "concerns": ["specific things in THIS document that threaten the payout"]
}

RULES:
- COPY figures out of the document. Do not compute anything, do not convert units, do not
  annualise, do not sum quarters. Report each number exactly as the statements give it, and
  put the units in "scale". Ratios are calculated elsewhere; your arithmetic is not needed and
  is not wanted.
- A figure you cannot find is null. NEVER estimate one, and never carry one over from memory
  of this company — what you remember is out of date and this document is not.
- Use the CASH FLOW STATEMENT for operatingCashFlow, capex, dividendsPaid and buybacks. The
  dividend is paid in cash; the income statement can flatter it.
- "concerns" must be things this document actually says — a covenant, a maturity wall, a
  segment losing money, a payout language change. Not general observations about the industry.`;

/** One call. The document is the user turn, so a huge filing does not sit in the system prompt
 *  where it would be re-sent on every subsequent request. */
export async function extract({ text, ticker }) {
  const out = await chat({
    system: SYSTEM,
    messages: [{ role: 'user', content: `Company: ${ticker}\n\nDocument:\n${text}` }],
    maxTokens: 2000,
  });
  const raw = String(out || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('nothing readable came back from that document');
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (e) { throw new Error('the extraction was not valid JSON'); }
  const figures = cleanFigures(parsed);
  return { figures, coverage: coverageOf(figures) };
}
