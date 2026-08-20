// Runs automatically every morning (see netlify.toml for the schedule) and
// sends Paul a brief good-morning message via Telegram. Kept simple for now
// since there's no connected business data source yet - can be expanded
// later to pull in real numbers if that gets wired up.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

exports.handler = async function () {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York"
  });

  const message = await generateBriefing(today);
  await sendTelegram(message);

  return { statusCode: 200, body: "ok" };
};

async function generateBriefing(today) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 150,
      system: `You are Jarvis, Paul's personal assistant, writing his morning briefing message for Telegram. Today is ${today}. Keep it brief - a couple sentences, warm and personable in the Jarvis-from-Iron-Man style (composed, a bit dry-witted, calls him "sir"). Mention the date, then remind him he can message you here or call the Jarvis line for anything he needs handled today. No business data is connected yet, so don't make up numbers or reports.`,
      messages: [{ role: "user", content: "Write today's briefing." }]
    })
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  const text = data?.content?.find(b => b.type === "text")?.text;
  return text || `Good morning, sir. Today is ${today}. Let me know if there's anything you'd like taken care of.`;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("Telegram not configured - briefing not sent");
    return;
  }
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
