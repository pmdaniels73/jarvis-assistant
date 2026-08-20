// Runs every 5 minutes (see netlify.toml) and checks the Reminders sheet
// for anything due, sending each one via Telegram.

exports.handler = async function () {
  const url = process.env.REMINDERS_APPS_SCRIPT_URL;
  if (!url) {
    console.error("REMINDERS_APPS_SCRIPT_URL not configured");
    return { statusCode: 200, body: "not configured" };
  }

  let data;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "checkDue" })
    });
    data = await res.json();
  } catch (err) {
    console.error("Failed to check reminders", err);
    return { statusCode: 200, body: "error" };
  }

  const due = data?.due || [];
  for (const reminder of due) {
    await sendTelegram(`⏰ Reminder: ${reminder.message}`);
  }

  return { statusCode: 200, body: `sent ${due.length}` };
};

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}
