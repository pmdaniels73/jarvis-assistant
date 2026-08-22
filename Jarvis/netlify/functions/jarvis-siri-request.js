// Lets Siri Shortcuts (or any external trigger) send a spoken/typed request
// straight into the exact same classifier and routing logic Telegram uses -
// by constructing a fake Telegram update and calling that handler directly,
// so there's zero duplicated logic to keep in sync.
//
// Trigger with a POST request, JSON body: { "text": "call pizza hut and
// ask what a large pepperoni costs" }

const telegramWebhook = require("./jarvis-telegram-webhook.js");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Use POST" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON body" };
  }

  const text = body.text;
  if (!text || !text.trim()) {
    return { statusCode: 400, body: "Missing 'text' in request body" };
  }

  const chatId = process.env.TELEGRAM_CHAT_ID;
  const fakeTelegramUpdate = {
    message: {
      text: text.trim(),
      chat: { id: chatId }
    }
  };

  const fakeEvent = {
    httpMethod: "POST",
    body: JSON.stringify(fakeTelegramUpdate)
  };

  try {
    await telegramWebhook.handler(fakeEvent);
    return { statusCode: 200, body: "Request received - check Telegram for the response." };
  } catch (err) {
    console.error("Failed to process Siri request", err);
    return { statusCode: 500, body: "Something went wrong processing that request." };
  }
};
