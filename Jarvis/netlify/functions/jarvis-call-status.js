// SignalWire hits this whenever the outbound business call ends, for ANY
// reason - completed, no-answer, busy, failed, canceled. This is a safety
// net: if the call ended abnormally, Paul gets a Telegram message even
// though the main conversation flow in jarvis-outbound-voice.js never got
// a chance to notify him itself.

exports.handler = async function (event) {
  const encodedState = event.queryStringParameters?.state;
  const state = decodeState(encodedState);
  const params = new URLSearchParams(event.body || "");
  const callStatus = params.get("CallStatus");

  if (!state) {
    return { statusCode: 200, body: "ok" };
  }

  let message;
  if (callStatus === "no-answer") {
    message = `I called about "${state.task}" but nobody picked up.`;
  } else if (callStatus === "busy") {
    message = `I tried calling about "${state.task}" but the line was busy.`;
  } else if (callStatus === "failed" || callStatus === "canceled") {
    message = `I wasn't able to complete the call about "${state.task}" - something went wrong connecting.`;
  } else {
    // The call connected and ended normally - check whether the main
    // conversation flow already logged and reported it, instead of
    // guessing. If it did, skip this to avoid a duplicate notification.
    // If nothing was logged, that itself tells us something concrete: the
    // call ended before Ava ever reached a proper wrap-up.
    const logEntry = await getRecentCallLog();
    if (logEntry?.found) {
      console.log("Skipping fallback message - already reported via CallLog", logEntry);
      return { statusCode: 200, body: "ok" };
    }
    message = `The call about "${state.task}" ended, but nothing was recorded from the conversation - Ava likely never got to speak with anyone before it disconnected (dead air, someone picked up without engaging, or a very early hangup).`;
  }

  await sendTelegram(message);

  return { statusCode: 200, body: "ok" };
};

async function getRecentCallLog() {
  const url = process.env.REMINDERS_APPS_SCRIPT_URL;
  if (!url) return null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "getRecentCallLog" })
    });
    return await res.json();
  } catch (err) {
    console.error("Failed to check CallLog", err);
    return null;
  }
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("Telegram not configured - message not sent:", message);
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `🤵 Jarvis: ${message}` })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Telegram send failed:", errText);
    }
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}

function decodeState(encoded) {
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (e) {
    return null;
  }
}
