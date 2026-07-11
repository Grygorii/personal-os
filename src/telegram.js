import { config } from './config.js';

const API = `https://api.telegram.org/bot${config.telegramToken}`;

export async function send(text, chatId = config.telegramChatId) {
  if (!chatId) {
    console.warn('[telegram] no chatId set; message not sent:', text.slice(0, 60));
    return;
  }
  const post = (body) =>
    fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });

  // Try Markdown first; if the text trips Telegram's parser, resend as plain
  // text so a stray * or _ can never silently swallow a coach reply.
  let res = await post({ text, parse_mode: 'Markdown' });
  if (!res.ok) res = await post({ text });
  if (!res.ok) {
    console.error('[telegram] send failed:', await res.text());
    return;
  }
  return res.json();
}

// Send a batch of System "ping" lines as a monospaced block (no-op if empty).
export async function sendPings(pings, chatId = config.telegramChatId) {
  if (!pings || !pings.length) return;
  await send('```\n' + pings.join('\n') + '\n```', chatId);
}

// Send a long message, split on line breaks into <4k chunks (Telegram's per-message cap).
export async function sendLong(text, chatId = config.telegramChatId) {
  const MAX = 3800;
  if ((text || '').length <= MAX) return send(text, chatId);
  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > MAX) {
      if (buf) parts.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) parts.push(buf);
  for (const p of parts) await send(p, chatId);
}

// Send a message with tappable inline buttons that open a URL inside Telegram.
// buttons: [{ text, url }] (one row). Falls back to plain text if Markdown trips the parser.
export async function sendButtons(text, buttons, chatId = config.telegramChatId) {
  if (!chatId) {
    console.warn('[telegram] no chatId set; button message not sent:', text.slice(0, 60));
    return;
  }
  const reply_markup = { inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))] };
  const post = (body) =>
    fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, reply_markup, ...body }),
    });
  let res = await post({ text, parse_mode: 'Markdown' });
  if (!res.ok) res = await post({ text });
  if (!res.ok) {
    console.error('[telegram] sendButtons failed:', await res.text());
    return;
  }
  return res.json();
}

/**
 * Long-poll for incoming messages. Calls onMessage({ chatId, text }) per message.
 * Runs forever.
 */
// Download a Telegram photo (largest size) as base64 for the vision model.
async function fetchPhotoBase64(fileId) {
  const r = await fetch(`${API}/getFile?file_id=${fileId}`);
  const path = (await r.json())?.result?.file_path;
  if (!path) return null;
  const fr = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${path}`);
  if (!fr.ok) return null;
  const buf = Buffer.from(await fr.arrayBuffer());
  return { base64: buf.toString('base64'), mediaType: 'image/jpeg' };
}

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
        if (msg?.photo?.length) {
          let image = null;
          try {
            image = await fetchPhotoBase64(msg.photo[msg.photo.length - 1].file_id);
          } catch (e) {
            console.error('[telegram] photo download failed:', e.message);
          }
          await onMessage({ chatId: msg.chat.id, text: (msg.caption || '').trim(), image });
        } else if (msg?.text) {
          await onMessage({ chatId: msg.chat.id, text: msg.text.trim() });
        }
      }
    } catch (err) {
      console.error('[telegram] poll error:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
