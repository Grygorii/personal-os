import * as water from './agents/water.js';
import * as bookCoach from './agents/bookCoach.js';
import * as coach from './coach.js';
import * as system from './system.js';
import { send } from './telegram.js';

// Slash-commands are quick shortcuts. Everything else goes to the coach.
const shortcuts = [water, bookCoach];

export async function route({ chatId, text }) {
  if (/^\/(start|help)\b/i.test(text)) {
    await send(
      '*Personal OS* 🧠\n' +
        `Your chat id: \`${chatId}\`  ← put this in TELEGRAM_CHAT_ID\n\n` +
        'Just talk to me — how you slept, what you drank, what you\'re reading, ' +
        'what you shipped, what\'s on your mind. I\'ll coach you and the System ' +
        'tracks the growth.\n\n' +
        '`/status` — your status window   `/ranks` — the rank ladder\n' +
        'Shortcuts: `/water 0.5`, `/read <title>`, `/suggest`, `/progress <note>`, `/finished`.',
      chatId
    );
    return;
  }

  if (/^\/status\b/i.test(text)) {
    await send('```\n' + (await system.statusWindow()) + '\n```');
    return;
  }

  if (/^\/ranks?\b/i.test(text)) {
    const st = await system.currentState();
    await send('```\n' + system.renderLadder(st.level) + '\n```');
    return;
  }

  // Explicit slash shortcuts (fast path)
  if (text.startsWith('/')) {
    for (const h of shortcuts) {
      if (h.command && (await h.command(text))) return;
    }
    // Unknown command → let the coach handle it as plain talk.
  }

  // Everything else → the coach.
  await coach.handle(text);
}
