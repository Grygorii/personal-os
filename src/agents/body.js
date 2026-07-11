import { sendButtons } from '../telegram.js';

// The Body map — a Telegram button that opens the interactive map. Tap a spot, log
// what you feel, then paste the summary back and the coach discusses it (wellbeing and
// recovery ideas only — never medical treatment).
const MAP_URL = 'https://claude.ai/code/artifact/b6ebf2aa-65a9-4bab-9700-2e94d5a66d44';

export async function command(text) {
  if (!/^\/body\b/i.test(text)) return false;
  await sendButtons(
    '🧍 *Body map* — tap where something hurts or feels off (front or back), log it, ' +
      "then paste the result back here and we'll talk it through.\n\n" +
      '_Not medical advice — anything sharp, sudden, or lasting, see a doctor._',
    [{ text: 'Open body map', url: MAP_URL }]
  );
  return true;
}
