// Minimal Telegram Bot API client for server-side notifications.
// Keep TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID only in Render environment variables.

function required(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`Missing ${name} environment variable`);
    err.code = 'TELEGRAM_CONFIG_MISSING';
    throw err;
  }
  return value;
}

async function telegramRequest(method, body) {
  const token = required('TELEGRAM_BOT_TOKEN');
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    const err = new Error(`Telegram ${method} failed: ${payload.description || res.statusText || res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload.result;
}

async function sendTelegramMessage(text, extra = {}) {
  const chatId = required('TELEGRAM_CHAT_ID');
  const source = String(text || '');
  // Telegram sendMessage accepts up to 4096 chars. Use conservative chunks so
  // long accumulator lists are still delivered without truncation.
  const chunks = [];
  let remaining = source;
  while (remaining.length > 3900) {
    let cut = remaining.lastIndexOf('\n', 3900);
    if (cut < 1000) cut = 3900;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);

  const results = [];
  for (const chunk of chunks) {
    results.push(await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
      ...extra,
    }));
  }
  return results;
}

module.exports = { sendTelegramMessage, telegramRequest };
