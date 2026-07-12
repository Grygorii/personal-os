import { sendButtons } from '../telegram.js';

// The Reading journal — a Telegram button that opens the journal (books + stats +
// thoughts you can tag to a page). Primary entry is the Mini App menu button; this is
// a convenience command. Points at the live in-app page on our own domain.
const READING_URL = 'https://personal-os-production-052d.up.railway.app/reading';

export async function command(text) {
  if (!/^\/reading\b/i.test(text)) return false;
  await sendButtons(
    '📚 *Reading journal* — your books with stats, and the thoughts they spark. ' +
      'Add a thought and tag the page it came from; paste it back here and we can pull ' +
      'the words and ideas into your study.',
    [{ text: 'Open reading journal', url: READING_URL }]
  );
  return true;
}
