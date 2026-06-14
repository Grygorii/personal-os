import { ask } from '../llm.js';
import { getProfile, logEvent, col } from '../db.js';
import { send } from '../telegram.js';

// Personal target in litres. Adjust to taste — this is a habit nudge, not medical advice.
const TARGET_LITRES = 2.0;

// Scheduled trigger: sum today's water and nudge if below target.
export async function run() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const todays = await col('logs')
    .find({ type: 'water', ts: { $gte: start } })
    .toArray();
  const total = todays.reduce((sum, e) => sum + (e.value || 0), 0);

  if (total >= TARGET_LITRES) {
    await send(`💧 ${total.toFixed(1)}L logged today — on target. Nice.`);
    return;
  }

  const profile = await getProfile();
  const text = await ask({
    system:
      'You write a brief, warm hydration nudge for Гриша — one or two sentences. ' +
      'State his actual intake vs target, note he is a bit low, and give one light ' +
      'reason to top up before bed. No medical claims, no lecturing.',
    user:
      `Profile notes: ${JSON.stringify(profile.health || {})}. ` +
      `Today so far: ${total.toFixed(1)}L of a ${TARGET_LITRES}L target.`,
    maxTokens: 150,
  });
  await send(text);
}

// Command handler: "/water 0.5"
export async function command(text) {
  const m = text.match(/^\/water\s+([\d.]+)/i);
  if (!m) return false;
  const litres = parseFloat(m[1]);
  await logEvent('water', { value: litres });
  await send(`Logged ${litres}L 💧`);
  return true;
}
