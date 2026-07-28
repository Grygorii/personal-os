import { config } from './config.js';
import { currentUser } from './ctx.js';

const API = `https://api.telegram.org/bot${config.telegramToken}`;

// Where does an un-addressed message go? To the person we're currently acting for — so a
// tenant's check-in reaches THEM, never the owner. Falls back to the owner outside a
// context (boot-time notices).
function defaultChat() {
  return currentUser()?.chatId || config.telegramChatId;
}

export async function send(text, chatId = defaultChat()) {
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
export async function sendPings(pings, chatId = defaultChat()) {
  if (!pings || !pings.length) return;
  await send('```\n' + pings.join('\n') + '\n```', chatId);
}

// Send a long message, split on line breaks into <4k chunks (Telegram's per-message cap).
export async function sendLong(text, chatId = defaultChat()) {
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
export async function sendButtons(text, buttons, chatId = defaultChat()) {
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

// A persistent reply keyboard: labeled buttons under the input box that send their text
// when tapped — so he taps instead of typing commands. Installed once (survives restarts).
export async function sendKeyboard(text, rows, chatId = defaultChat()) {
  if (!chatId) return;
  const res = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: { keyboard: rows.map((r) => r.map((label) => ({ text: label }))), resize_keyboard: true, is_persistent: true },
    }),
  });
  if (!res.ok) console.error('[telegram] sendKeyboard failed:', await res.text());
}

// Buttons that DO things. rows: [[{ text, data } | { text, url }]] — `data` is simply the
// command the button stands for, so a tap and a typed command take the same path.
export async function sendInline(text, rows, chatId = defaultChat()) {
  if (!chatId) return;
  const inline_keyboard = rows.map((r) =>
    r.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))
  );
  const post = (body) =>
    fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, reply_markup: { inline_keyboard }, ...body }),
    });
  let res = await post({ text, parse_mode: 'Markdown' });
  if (!res.ok) res = await post({ text });
  if (!res.ok) console.error('[telegram] sendInline failed:', await res.text());
}

// Stop the button's spinner. Telegram requires this for every callback.
export async function answerCallback(id, text = '') {
  if (!id) return;
  try {
    await fetch(`${API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id, ...(text ? { text } : {}) }),
    });
  } catch (e) {
    console.error('[telegram] answerCallback failed:', e.message);
  }
}

// Remove a message we've already handled — used the instant someone pastes an API key,
// so the secret doesn't sit in their chat history.
export async function deleteMessage(messageId, chatId = defaultChat()) {
  if (!chatId || !messageId) return false;
  try {
    const res = await fetch(`${API}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    return res.ok;
  } catch (e) {
    console.error('[telegram] deleteMessage failed:', e.message);
    return false;
  }
}

// Send a file (their data export).
export async function sendDocument(filename, content, caption = '', chatId = defaultChat()) {
  if (!chatId) return;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'application/json' }), filename);
  const res = await fetch(`${API}/sendDocument`, { method: 'POST', body: form });
  if (!res.ok) console.error('[telegram] sendDocument failed:', await res.text());
  return res.ok;
}

// The bot's own @username — needed to build the deep links that shared pages point back to.
export async function getMe() {
  try {
    const res = await fetch(`${API}/getMe`);
    const data = await res.json();
    return data?.result || null;
  } catch (e) {
    console.error('[telegram] getMe failed:', e.message);
    return null;
  }
}

// Register the tappable "/" command menu (idempotent — safe to call on every boot).
export async function setCommands(commands) {
  try {
    const res = await fetch(`${API}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    if (!res.ok) console.error('[telegram] setMyCommands failed:', await res.text());
  } catch (e) {
    console.error('[telegram] setMyCommands error:', e.message);
  }
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
        // A tapped inline button: its callback_data IS the command, so it flows through
        // exactly the same router path as typing would.
        const cb = update.callback_query;
        if (cb) {
          try {
            await onMessage({
              chatId: cb.message?.chat?.id,
              from: cb.from,
              text: String(cb.data || '').trim(),
              messageId: cb.message?.message_id,
              callbackId: cb.id,
            });
          } catch (e) {
            console.error(`[telegram] callback ${cb.id} failed:`, e.message);
            await answerCallback(cb.id);
          }
          continue;
        }
        const msg = update.message;
        // Each update is isolated: one user's failure must never skip the next person's
        // message or stall the whole bot. Errors are logged and the loop carries on.
        try {
          if (msg?.photo?.length) {
            let image = null;
            try {
              image = await fetchPhotoBase64(msg.photo[msg.photo.length - 1].file_id);
            } catch (e) {
              console.error('[telegram] photo download failed:', e.message);
            }
            await onMessage({ chatId: msg.chat.id, from: msg.from, messageId: msg.message_id, text: (msg.caption || '').trim(), image });
          } else if (msg?.text) {
            await onMessage({ chatId: msg.chat.id, from: msg.from, messageId: msg.message_id, text: msg.text.trim() });
          }
        } catch (e) {
          console.error(`[telegram] handling update ${update.update_id} failed:`, e.message);
        }
      }
    } catch (err) {
      console.error('[telegram] poll error:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
