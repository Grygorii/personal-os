import { sendButtons } from '../telegram.js';

// The Routine — a Telegram button that opens your day, pre-decided: today's 3, the daily
// recovery-encoded checklist, weekly rhythm, and your pre-decided defaults. The point is to
// stop spending fuel on decisions that don't matter.
const ROUTINE_URL = 'https://personal-os-production-052d.up.railway.app/routine';

export async function command(text) {
  if (!/^\/(routine|today)\b/i.test(text)) return false;
  await sendButtons(
    '✅ *Your routine* — the day, pre-decided. Today\'s 3, your daily rhythm (recovery ' +
      'built in), and your defaults. Follow it; don\'t re-decide it.',
    [{ text: 'Open routine', url: ROUTINE_URL }]
  );
  return true;
}
