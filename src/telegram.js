import { config } from './config.js';

const API = `https://api.telegram.org/bot${config.telegramToken}`;

export async function send(text, chatId = config.telegramChatId) {
  if (!chatId) {
    console.warn('[telegram] no chatId set; message not sent:', text.slice(0, 60));
    return;
  }
  const res = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) console.error('[telegram] send failed:', await res.text());
  return res.json();
}

/**
 * Long-poll for incoming messages. Calls onMessage({ chatId, text }) per message.
 * Runs forever.
 */
export async function poll(onMessage) {
  let offset = 0;
  console.log('[telegram] polling for messages...');
  for (;;) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
      const { result = [] } = await res.json();
      for (const update of result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (msg?.text) {
          await onMessage({ chatId: msg.chat.id, text: msg.text.trim() });
        }
      }
    } catch (err) {
      console.error('[telegram] poll error:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
