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
    message = `That call about "${state.task}" has ended. If I already messaged you with the result, disregard this - otherwise, you may want to follow up directly.`;
  }

  await sendTelegram(message);

  return { statusCode: 200, body: "ok" };
};

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
