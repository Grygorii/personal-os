// ---- Prices ----
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: a price the model wrote down is not a price.
// Every number that reaches a decision comes from here, carrying where it came from and how
// old it is. A language model asked "what is MSTR trading at" will answer confidently from
// training data months stale, and in this application that is not a wrong answer, it is a
// wrong position. So the brain is never asked for a price — it is handed one, or told there
// isn't one.
//
// Everything returns { ticker, price, currency, at, source, delayed } or throws. There is no
// third state, and in particular there is no "0" — a failed fetch that returned zero once
// showed a portfolio as a total loss.

import { config } from '../config.js';

const TICKER = /^[A-Z][A-Z0-9.\-]{0,11}$/;
/** Uppercased and validated. Anything that isn't a plausible symbol is refused rather than
 *  concatenated into a URL — this string comes from chat messages and model output. */
export function cleanTicker(raw) {
  // Trim the ends only. Stripping INTERNAL whitespace first turned the sentence "not a
  // ticker" into the symbol NOTATICKER, which is eleven valid characters and sails through
  // the pattern below — so an ordinary chat message became a live price lookup, and whatever
  // came back got treated as a real quote. A symbol has no spaces in it; anything that does
  // is prose, and prose is not a ticker.
  const t = String(raw || '').trim().toUpperCase();
  return TICKER.test(t) ? t : '';
}

const FRESH_MS = 15 * 60 * 1000;   // a quote older than this is called stale, out loud
const cache = new Map();           // ticker -> {quote, at}. Per-process, tiny, never persisted.

/** Stooq: end-of-day CSV, no key, no signup. The honest default — it is genuinely delayed,
 *  and saying so is the whole point. US symbols take a `.us` suffix there. */
async function fromStooq(ticker) {
  const sym = encodeURIComponent(ticker.toLowerCase() + '.us');
  const res = await fetch(`https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`, {
    headers: { 'User-Agent': 'personal-os-steward' },
  });
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const text = await res.text();
  const rows = text.trim().split('\n');
  if (rows.length < 2) throw new Error('stooq returned no rows');
  const cols = rows[0].split(',').map((c) => c.trim().toLowerCase());
  const vals = rows[1].split(',').map((c) => c.trim());
  const get = (name) => vals[cols.indexOf(name)];
  const close = Number(get('close'));
  // Stooq answers an unknown symbol with the literal string "N/D" rather than an error.
  if (!Number.isFinite(close) || close <= 0) throw new Error(`no price for ${ticker}`);
  const stamp = `${get('date')}T${get('time') || '00:00:00'}Z`;
  const at = Number.isFinite(Date.parse(stamp)) ? Date.parse(stamp) : Date.now();
  return { ticker, price: close, currency: 'USD', at, source: 'stooq', delayed: true };
}

/** Finnhub: real-time-ish, free key, 60 calls/minute. The one to use once a key exists. */
async function fromFinnhub(ticker) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(config.marketKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`finnhub ${res.status}`);
  const d = await res.json();
  const price = Number(d?.c);
  // Finnhub returns c:0 for a symbol it does not know — a 200 response that means "no".
  if (!Number.isFinite(price) || price <= 0) throw new Error(`no price for ${ticker}`);
  return {
    ticker, price, currency: 'USD',
    at: Number(d.t) ? Number(d.t) * 1000 : Date.now(),
    source: 'finnhub', delayed: false,
  };
}

const PROVIDERS = { stooq: fromStooq, finnhub: fromFinnhub };

export function providerName() {
  const want = (config.marketProvider || '').toLowerCase();
  if (want && PROVIDERS[want]) return want;
  return config.marketKey ? 'finnhub' : 'stooq';
}

/** One quote. Cached briefly so a review that mentions a holding six times costs one call. */
export async function quote(rawTicker) {
  const ticker = cleanTicker(rawTicker);
  if (!ticker) throw new Error('not a ticker');
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < 60_000) return hit.quote;
  const q = await PROVIDERS[providerName()](ticker);
  cache.set(ticker, { quote: q, at: Date.now() });
  return q;
}

/** Many quotes, with failures kept rather than thrown. A portfolio review must still run when
 *  one symbol is delisted, misspelled or simply unknown to the provider — the missing one is
 *  reported as missing, and the model is told not to guess it. */
export async function quotes(tickers) {
  const unique = [...new Set((tickers || []).map(cleanTicker).filter(Boolean))];
  const out = { prices: {}, missing: [] };
  await Promise.all(unique.map(async (t) => {
    try { out.prices[t] = await quote(t); } catch (e) { out.missing.push(t); }
  }));
  return out;
}

// ---- Dividends ----
// His strategy is income that still grows, so yield, payout ratio and dividend growth are not
// extras here — they are the numbers the whole book is judged on. They need a data key;
// without one the bot says it cannot see them rather than reasoning about numbers it doesn't
// have. Never stored: a fundamentals row per symbol per day is how a 512 MB free tier dies.
const fundCache = new Map();

export async function fundamentals(rawTicker) {
  const ticker = cleanTicker(rawTicker);
  if (!ticker) throw new Error('not a ticker');
  if (providerName() !== 'finnhub') throw new Error('no fundamentals without a market key');
  const hit = fundCache.get(ticker);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.data;

  const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${encodeURIComponent(config.marketKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`finnhub metrics ${res.status}`);
  const m = (await res.json())?.metric || {};
  const pick = (...keys) => {
    for (const k of keys) { const v = Number(m[k]); if (Number.isFinite(v)) return v; }
    return null;
  };
  const data = {
    ticker,
    // Finnhub names these inconsistently across plans, so take the first that is a number
    // rather than assuming one key exists.
    yieldPct: pick('currentDividendYieldTTM', 'dividendYieldIndicatedAnnual'),
    payoutRatio: pick('payoutRatioTTM', 'payoutRatioAnnual'),
    divGrowth5y: pick('dividendGrowthRate5Y'),
    divPerShare: pick('dividendPerShareTTM', 'dividendPerShareAnnual'),
    at: Date.now(),
  };
  fundCache.set(ticker, { data, at: Date.now() });
  return data;
}

export async function fundamentalsFor(tickers) {
  const unique = [...new Set((tickers || []).map(cleanTicker).filter(Boolean))];
  const out = { funds: {}, missing: [] };
  await Promise.all(unique.map(async (t) => {
    try { out.funds[t] = await fundamentals(t); } catch (e) { out.missing.push(t); }
  }));
  return out;
}

/** How a quote is written wherever a person will read it: never a bare number. A price with
 *  no time on it is the same trap as a price from memory — it looks current. */
export function describeQuote(q) {
  const age = Date.now() - q.at;
  const when = age < FRESH_MS
    ? 'just now'
    : new Date(q.at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return `${q.ticker} ${q.price.toFixed(2)} ${q.currency} (${q.source}${q.delayed ? ', delayed' : ''}, ${when})`;
}

/** The facts block handed to the brain. Everything it is allowed to treat as a real price,
 *  plus the explicit list of what it must NOT invent. */
export function priceFacts({ prices, missing }) {
  const lines = Object.values(prices).map((q) => '  ' + describeQuote(q));
  const parts = [];
  parts.push(lines.length ? 'PRICES (the only prices that exist for you):\n' + lines.join('\n') : 'PRICES: none available.');
  if (missing.length) parts.push(`NO PRICE AVAILABLE for: ${missing.join(', ')}. Say so. Do not estimate these.`);
  return parts.join('\n');
}
