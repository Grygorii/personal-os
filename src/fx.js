// ---- Currency ----
//
// He earns and spends in EUR, holds a portfolio in USD, and has deposits and an apartment in
// EGP. Three currencies, one household, and one question: what is all of it worth in euro?
//
// THE RULE, and it is the same rule as market.js: an amount without a currency is not an
// amount, and a rate the model remembered is not a rate. Every figure is stored in the
// currency it actually exists in, and converted only at the moment it is shown, at a rate that
// is fetched and dated. Nothing is ever stored converted — a stored conversion is a lie the
// moment the rate moves, and it cannot be undone because the original is gone.
//
// There is deliberately NO 1:1 fallback anywhere in this file. A missing rate produces null,
// and null is reported as "not converted". A silent 1:1 would value 50,000 EGP as 50,000 EUR
// and put a household's net worth out by a factor of fifty.

import { config } from './config.js';

const CODE = /^[A-Z]{3}$/;
export function cleanCurrency(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return CODE.test(c) ? c : '';
}

let cache = null;   // { base, rates, at }

/** Rates against a base. open.er-api.com is free, needs no key, and states its own update
 *  time — which we keep, because a rate without a date is the same trap as a price without
 *  one: it looks current. */
export async function rates(base = 'EUR') {
  const b = cleanCurrency(base) || 'EUR';
  if (cache && cache.base === b && Date.now() - cache.at < 6 * 3600_000) return cache;
  const url = config.fxUrl || `https://open.er-api.com/v6/latest/${b}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fx ${res.status}`);
  const d = await res.json();
  const table = d?.rates;
  if (!table || typeof table !== 'object') throw new Error('fx returned no rates');
  // The API quotes "1 base = N foreign". Keep it in exactly that direction and do the
  // inversion in one place below, rather than in every caller.
  cache = {
    base: b,
    rates: table,
    at: Number(d.time_last_update_unix) ? Number(d.time_last_update_unix) * 1000 : Date.now(),
    source: 'open.er-api.com',
  };
  return cache;
}

/** Amount in `from`, expressed in the table's base. Null when the rate is unknown — never a
 *  guess, and never the original number passed through unconverted. */
export function toBase(amount, from, table) {
  const n = Number(amount);
  const cur = cleanCurrency(from);
  if (!Number.isFinite(n) || !cur || !table?.rates) return null;
  if (cur === table.base) return n;
  const perBase = Number(table.rates[cur]);   // 1 base = perBase of `cur`
  if (!Number.isFinite(perBase) || perBase <= 0) return null;
  return n / perBase;
}

/** How a converted figure is written wherever a person reads it: the original never
 *  disappears. Seeing "1,200,000 EGP" next to "€22,140" is what keeps a devaluation visible;
 *  the euro figure alone hides it. */
export function describeAmount(amount, currency, table, base = 'EUR') {
  const cur = cleanCurrency(currency);
  const n = Number(amount);
  const nice = (v, c) => `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${c}`;
  if (!Number.isFinite(n) || !cur) return '—';
  if (cur === base) return nice(n, cur);
  const conv = toBase(n, cur, table);
  return conv == null ? `${nice(n, cur)} (no rate — not converted)` : `${nice(n, cur)} ≈ ${nice(conv, base)}`;
}

export function rateAge(table) {
  if (!table?.at) return 'unknown age';
  const hours = (Date.now() - table.at) / 3600_000;
  if (hours < 26) return 'today';
  return `${Math.round(hours / 24)} days old`;
}

// ---- The thing that actually matters for money held in Egypt ----
//
// A deposit paying 20% a year in EGP is not a 20% return to a household that spends euro. If
// the pound falls 25% against the euro over that year, the deposit LOST money in the only
// currency he buys groceries in. High local interest rates and currency devaluation are not
// two separate facts; the first is largely compensation for the second.
//
// This is the same question the dividend side asks — "why is this yield so high?" — and it
// deserves the same treatment: arithmetic, stated plainly, not left to be felt.
export function realReturn({ nominalPct, rateThen, rateNow }) {
  const nom = Number(nominalPct);
  const then = Number(rateThen);   // units of foreign currency per 1 EUR, at the start
  const now = Number(rateNow);     // and now
  if (!Number.isFinite(nom) || !Number.isFinite(then) || !Number.isFinite(now) || then <= 0 || now <= 0) return null;
  // 1 unit grows to (1 + nom). Converting back costs more units per euro if the currency fell.
  const inBase = (1 + nom / 100) * (then / now) - 1;
  return {
    nominalPct: nom,
    currencyMovePct: (then / now - 1) * 100,   // negative when the local currency weakened
    realPct: inBase * 100,
  };
}

// The codes a currency token is allowed to be. A whitelist rather than a shape test, because
// "3 letters" is not a currency: it also matches the first three letters of "salary", "food"
// and "gas". Without this, "in 3200 salary" records 3,200 SAL — a currency with no rate, so
// the amount silently vanishes from every total. Caught before shipping; it would have been
// the most common thing he types.
export const KNOWN_CURRENCIES = new Set([
  'EUR', 'USD', 'GBP', 'EGP', 'CHF', 'PLN', 'UAH', 'CZK', 'SEK', 'NOK', 'DKK', 'HUF', 'RON',
  'TRY', 'RUB', 'AED', 'SAR', 'QAR', 'KWD', 'ILS', 'JPY', 'CNY', 'HKD', 'SGD', 'INR', 'PKR',
  'AUD', 'NZD', 'CAD', 'MXN', 'BRL', 'ARS', 'ZAR', 'NGN', 'KES', 'MAD', 'TND', 'THB', 'VND',
  'PHP', 'IDR', 'MYR', 'KRW', 'BGN', 'HRK', 'ISK',
]);

export const isKnownCurrency = (v) => KNOWN_CURRENCIES.has(cleanCurrency(v));
