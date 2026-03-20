const fetch = require('node-fetch');

async function sendTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) {
    console.log('[Telegram] Skipped — no token or chat ID configured');
    return;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Telegram error: ${JSON.stringify(err)}`);
  }

  return res.json();
}

module.exports = { sendTelegram };
