// Receives incoming Telegram messages (webhook, not polling). One Claude
// call decides: does this need an actual phone call (business/personal
// contact task), or can it just be answered directly (research, quick
// questions, general chat)? Reuses the same extraction/lookup/calling
// logic as the phone and web flows.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "ok" };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 200, body: "ok" };
  }

  const message = update?.message;
  const text = message?.text;
  const chatId = message?.chat?.id;

  if (!text || !chatId) {
    return { statusCode: 200, body: "ok" };
  }

  // Only respond to Paul - ignore anyone else who messages the bot.
  const allowedChatId = process.env.TELEGRAM_CHAT_ID;
  if (String(chatId) !== String(allowedChatId)) {
    return { statusCode: 200, body: "ok" };
  }

  try {
    const decision = await classify(text);

    if (!decision.needsCall) {
      await sendTelegram(decision.directAnswer || "I'm not sure how to help with that.");
      return { statusCode: 200, body: "ok" };
    }

    let tasks = decision.tasks || [];
    tasks = await Promise.all(tasks.map(async (t) => {
      if (!t.businessNumber && t.businessSummary && !t.isPersonal) {
        return await tryAutoLookup(t);
      }
      return t;
    }));

    const missing = tasks.filter(t => !t.businessNumber);
    if (missing.length > 0) {
      await sendTelegram(decision.followupQuestion ||
        `I still need a phone number for ${missing.map(t => t.businessSummary || "one of those").join(" and ")}.`);
      return { statusCode: 200, body: "ok" };
    }

    const callerNumber = process.env.PAUL_PHONE_NUMBER;
    const results = await Promise.allSettled(
      tasks.map(t => placeOutboundCall(event, { task: t.task, callerNumber, history: [] }, t.businessNumber))
    );

    const failed = results.filter(r => r.status === "rejected");
    if (failed.length > 0) {
      failed.forEach(f => console.error("Outbound call failed", f.reason));
    }

    if (failed.length === tasks.length) {
      await sendTelegram("Couldn't reach the phone system for that - try again in a moment.");
      return { statusCode: 200, body: "ok" };
    }

    const names = tasks.map(t => t.businessSummary || "them").join(" and ");
    const plural = tasks.length > 1 ? "those" : "that";
    await sendTelegram(`On it - I'll take care of ${plural} (ringing ${names}) and let you know how it goes.`);
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("jarvis-telegram-webhook error", err);
    await sendTelegram("Something went wrong on my end handling that - mind trying again?");
    return { statusCode: 200, body: "ok" };
  }
};

async function classify(text) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      system: `You are Jarvis, Paul's personal assistant, chatting with him over Telegram.

Decide: does this message ask you to call a business or a personal contact and do something (order, book, ask, deliver a message)? Or is it a direct question, research request, or general chat you can just answer yourself (using web search if it'd help)?

If it needs a call, extract the task(s) the same way you would for a phone request - there can be more than one.

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"needsCall": true or false, "tasks": [{"task": "...", "businessNumber": "E.164 format or null", "businessSummary": "...", "isPersonal": true/false, "location": "... or null"}], "followupQuestion": "if needsCall is true and something's missing (e.g. a personal contact's number), ask for it here - otherwise empty string", "directAnswer": "if needsCall is false, your actual answer/response to Paul, written naturally as a Telegram message - otherwise empty string"}`,
      messages: [{ role: "user", content: text }]
    })
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  const textBlocks = (data?.content || []).filter(b => b.type === "text");
  const lastText = textBlocks.length ? textBlocks[textBlocks.length - 1].text : "{}";

  try {
    return JSON.parse(lastText.replace(/```json|```/g, "").trim());
  } catch (e) {
    return { needsCall: false, tasks: [], followupQuestion: "", directAnswer: "Sorry, I had trouble understanding that - could you rephrase?" };
  }
}

async function tryAutoLookup(extraction) {
  const searchArea = extraction.location || "Paintsville, Kentucky";

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      system: `Find the current phone number for a specific business location. Search the web to find it.

After searching, respond with ONLY a JSON object as your final message, no other text, in exactly this shape:
{"businessNumber": "phone number in E.164 format like +16065551234, or null if you couldn't find a confident match", "businessSummary": "the business name and city you found"}`,
      messages: [{ role: "user", content: `Find the phone number for: ${extraction.businessSummary}, near ${searchArea}` }]
    })
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  const textBlocks = (data?.content || []).filter(b => b.type === "text");
  const lastText = textBlocks.length ? textBlocks[textBlocks.length - 1].text : "{}";

  try {
    const result = JSON.parse(lastText.replace(/```json|```/g, "").trim());
    if (result.businessNumber) {
      return { ...extraction, businessNumber: result.businessNumber, businessSummary: result.businessSummary || extraction.businessSummary };
    }
  } catch (e) {
    // fall through
  }
  return extraction;
}

async function placeOutboundCall(event, state, toNumber) {
  const space = process.env.SIGNALWIRE_SPACE_URL;
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const token = process.env.SIGNALWIRE_API_TOKEN;
  const fromNumber = process.env.SIGNALWIRE_NUMBER;

  const encodedState = Buffer.from(JSON.stringify(state)).toString("base64");
  const webhookUrl = `${baseUrl(event)}/.netlify/functions/jarvis-outbound-voice?state=${encodeURIComponent(encodedState)}`;
  const statusCallbackUrl = `${baseUrl(event)}/.netlify/functions/jarvis-call-status?state=${encodeURIComponent(encodedState)}`;
  const auth = Buffer.from(`${projectId}:${token}`).toString("base64");
  const body = new URLSearchParams({
    To: toNumber,
    From: fromNumber,
    Url: webhookUrl,
    Method: "POST",
    MachineDetection: "Enable",
    MachineDetectionTimeout: "10",
    Record: "true",
    StatusCallback: statusCallbackUrl,
    StatusCallbackEvent: "completed",
    StatusCallbackMethod: "POST"
  });

  const res = await fetch(`https://${space}/api/laml/2010-04-01/Accounts/${projectId}/Calls.json`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`SignalWire outbound call failed: ${errText}`);
  }
}

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

function baseUrl(event) {
  return process.env.SITE_URL || `https://${event.headers.host}`;
}
