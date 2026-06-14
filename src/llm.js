import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

/**
 * Ask Claude. Returns plain text.
 * @param {{system: string, user: string, maxTokens?: number}} opts
 */
export async function ask({ system, user, maxTokens = 800 }) {
  const res = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Multi-turn chat. Pass a system string and an array of {role, content} messages.
 * @param {{system: string, messages: Array<{role:string, content:string}>, maxTokens?: number}} opts
 */
export async function chat({ system, messages, maxTokens = 600 }) {
  const res = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    system,
    messages,
  });
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
