import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

// Provider-agnostic LLM layer. Everyday coaching can run on a cheap model (Gemini Flash,
// which has a permanent free tier) while DEEP work — portraits, exam writing and grading —
// uses the strongest model available. Callers only ever use ask()/chat(), so switching
// providers is a config change, and a future tenant can bring whichever provider they
// already have. Gemini goes over REST so we add no new dependency.

const anthropic = config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null;

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

async function geminiChat({ system, messages, maxTokens, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.geminiKey)}`;
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

async function anthropicChat({ system, messages, maxTokens, model }) {
  const res = await anthropic.messages.create({ model, max_tokens: maxTokens, system, messages });
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
  const hasGemini = !!config.geminiKey;
  if (tier === 'deep' && anthropic) return { provider: 'anthropic', model: config.deepModel || config.model };
  if (config.provider === 'gemini' && hasGemini) return { provider: 'gemini', model: config.geminiModel };
  if (anthropic) return { provider: 'anthropic', model: config.model };
  if (hasGemini) return { provider: 'gemini', model: config.geminiModel };
  throw new Error('No LLM provider configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY)');
}

async function run({ system, messages, maxTokens, tier }) {
  const { provider, model } = route(tier);
  const call = (p, m) =>
    p === 'gemini'
      ? geminiChat({ system, messages, maxTokens, model: m })
      : anthropicChat({ system, messages, maxTokens, model: m });
  try {
    return await call(provider, model);
  } catch (err) {
    // Free tiers hand out 429s. Rather than fail the user's message, fall back to the
    // other configured provider once — loudly, so the logs show it happened.
    const alt = provider === 'gemini' && anthropic
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
