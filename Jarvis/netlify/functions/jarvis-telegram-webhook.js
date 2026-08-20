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

    if (decision.isReminder) {
      try {
        const url = process.env.REMINDERS_APPS_SCRIPT_URL;
        if (url) {
          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "add", message: decision.reminderMessage, dueAt: decision.reminderDueAt })
          });
          await sendTelegram(`Got it - I'll remind you: "${decision.reminderMessage}" at ${new Date(decision.reminderDueAt).toLocaleString("en-US", { timeZone: "America/New_York" })}.`);
        } else {
          await sendTelegram("Reminders aren't set up yet - the reminders sheet isn't configured.");
        }
      } catch (err) {
        console.error("Failed to save reminder", err);
        await sendTelegram("Sorry, I had trouble saving that reminder.");
      }
      return { statusCode: 200, body: "ok" };
    }

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
  const now = new Date();
  const nowEastern = now.toLocaleString("en-US", { timeZone: "America/New_York" });

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
      system: `You are Jarvis, Paul's personal assistant, chatting with him over Telegram. The current date/time (Eastern) is: ${nowEastern}.

Decide what this message is:
1. A reminder request ("remind me to X at/on Y") - figure out the exact future date/time they mean based on the current time above.
2. A request to call a business or personal contact and do something (order, book, ask, deliver a message) - there can be more than one task.
3. A direct question, research request, or general chat you can just answer yourself (using web search if it'd help).

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"isReminder": true or false, "reminderMessage": "what to remind him of, if isReminder is true", "reminderDueAt": "ISO 8601 datetime with timezone offset for when to send it, if isReminder is true, e.g. 2026-08-20T09:00:00-04:00", "needsCall": true or false, "tasks": [{"task": "...", "businessNumber": "E.164 format or null", "businessSummary": "...", "isPersonal": true/false, "location": "... or null"}], "followupQuestion": "if needsCall is true and something's missing, ask for it here - otherwise empty string", "directAnswer": "if neither isReminder nor needsCall, your actual answer to Paul, written naturally as a Telegram message - otherwise empty string"}`,
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
  console.log("classify raw response", { message: text, allTextBlocks: textBlocks.map(b => b.text), lastText });

  try {
    return JSON.parse(lastText.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("classify JSON parse failed", { lastText, error: e.message });
    return { isReminder: false, needsCall: false, tasks: [], followupQuestion: "", directAnswer: "Sorry, I had trouble understanding that - could you rephrase?" };
  }
}

async function tryAutoLookup(extraction) {
  const searchArea = extraction.location || "Paintsville, Kentucky";
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    return extraction;
  }

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.primaryType"
      },
      body: JSON.stringify({
        textQuery: `${extraction.businessSummary} near ${searchArea}`,
        locationBias: {
          circle: {
            center: { latitude: 37.8137, longitude: -82.8107 },
            radius: 80000.0
          }
        }
      })
    });

    const data = await res.json();
    console.log("Places API lookup", { query: `${extraction.businessSummary} near ${searchArea}`, resultCount: data?.places?.length || 0, allPlaces: data?.places });

    const place = pickBestPlace(data?.places || []);

    if (place?.internationalPhoneNumber) {
      return {
        ...extraction,
        businessNumber: place.internationalPhoneNumber.replace(/[^\d+]/g, ""),
        businessSummary: place.displayName?.text
          ? `${place.displayName.text}${place.formattedAddress ? ", " + place.formattedAddress : ""}`
          : extraction.businessSummary
      };
    }
  } catch (err) {
    console.error("Places API lookup failed", err);
  }

  return extraction;
}

function pickBestPlace(places) {
  const badWords = /customer (care|service)|corporate|headquarters|help ?desk|support center|national (office|line)/i;
  const good = places.filter(p => !badWords.test(p.displayName?.text || ""));
  return (good.length ? good : places)[0];
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
