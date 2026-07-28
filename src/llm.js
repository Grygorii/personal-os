import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { currentUser } from './ctx.js';
import { llmFor } from './users.js';

// Provider-agnostic LLM layer. Everyday coaching can run on a cheap model (Gemini Flash,
// which has a permanent free tier) while DEEP work — portraits, exam writing and grading —
// uses the strongest model available. Callers only ever use ask()/chat(), so switching
// providers is a config change, and a future tenant can bring whichever provider they
// already have. Gemini goes over REST so we add no new dependency.

// One client per key (the server's, plus any tenant who brought their own).
const anthropicClients = new Map();
function anthropicFor(apiKey) {
  if (!apiKey) return null;
  if (!anthropicClients.has(apiKey)) anthropicClients.set(apiKey, new Anthropic({ apiKey }));
  return anthropicClients.get(apiKey);
}
const anthropic = anthropicFor(config.anthropicKey);

// ---------- Gemini ----------

// Our messages carry either a plain string or Anthropic-style content blocks (the coach
// sends an image block for photos). Translate both into Gemini's `parts` shape.
function toGeminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  return (content || []).map((b) =>
    b.type === 'image'
      ? { inline_data: { mime_type: b.source?.media_type || 'image/jpeg', data: b.source?.data } }
      : { text: b.text || '' }
  );
}

async function geminiChat({ system, messages, maxTokens, model, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey || config.geminiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: toGeminiParts(m.content),
      })),
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('\n').trim();
  if (!text) throw new Error('gemini returned no text');
  return text;
}

// ---------- Anthropic ----------

async function anthropicChat({ system, messages, maxTokens, model, apiKey }) {
  const client = apiKey ? anthropicFor(apiKey) : anthropic;
  if (!client) throw new Error('no anthropic key available');
  const res = await client.messages.create({ model, max_tokens: maxTokens, system, messages });
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ---------- routing ----------

// Which provider handles this call. `tier: 'deep'` prefers the strongest model we have
// (portraits, exams); everything else follows LLM_PROVIDER, defaulting to what's configured.
function route(tier) {
  // A tenant who brought their own key always uses it — their calls, their bill, and we
  // never silently spend the server's credit on their behalf.
  const own = llmFor(currentUser());
  if (own) {
    return {
      provider: own.provider,
      model: own.provider === 'gemini' ? config.geminiModel : config.model,
      apiKey: own.apiKey,
      byok: true,
    };
  }
  const hasGemini = !!config.geminiKey;
  if (tier === 'deep' && anthropic) return { provider: 'anthropic', model: config.deepModel || config.model };
  if (config.provider === 'gemini' && hasGemini) return { provider: 'gemini', model: config.geminiModel };
  if (anthropic) return { provider: 'anthropic', model: config.model };
  if (hasGemini) return { provider: 'gemini', model: config.geminiModel };
  throw new Error('No LLM provider configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY)');
}

async function run({ system, messages, maxTokens, tier }) {
  const { provider, model, apiKey, byok } = route(tier);
  const call = (p, m, k) =>
    p === 'gemini'
      ? geminiChat({ system, messages, maxTokens, model: m, apiKey: k })
      : anthropicChat({ system, messages, maxTokens, model: m, apiKey: k });
  try {
    return await call(provider, model, apiKey);
  } catch (err) {
    // Free tiers hand out 429s, so fall back between the SERVER's providers. A tenant's own
    // key never falls back to ours — that would spend money they didn't authorise and hide
    // a broken key from them.
    const alt = byok
      ? null
      : provider === 'gemini' && anthropic
        ? { provider: 'anthropic', model: config.model }
        : provider === 'anthropic' && config.geminiKey
          ? { provider: 'gemini', model: config.geminiModel }
          : null;
    if (!alt) throw err;
    console.warn(`[llm] ${provider} failed (${err.message}) — falling back to ${alt.provider}`);
    return call(alt.provider, alt.model);
  }
}

/**
 * Ask once. Returns plain text.
 * @param {{system: string, user: string, maxTokens?: number, tier?: 'deep'}} opts
 */
export async function ask({ system, user, maxTokens = 800, tier }) {
  return run({ system, messages: [{ role: 'user', content: user }], maxTokens, tier });
}

/**
 * Multi-turn chat. Pass a system string and an array of {role, content} messages.
 * @param {{system: string, messages: Array<{role:string, content:*}>, maxTokens?: number, tier?: 'deep'}} opts
 */
export async function chat({ system, messages, maxTokens = 600, tier }) {
  return run({ system, messages, maxTokens, tier });
}
