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

  // Fast, deterministic kill switch - checked before the AI classifier so
  // an urgent "stop the call" is never at the mercy of misclassification
  // or extra latency.
  if (/\b(stop|end|cancel)\s+(the\s+)?call\b|\bhang\s*up\b/i.test(text)) {
    try {
      const result = await stopActiveCall();
      if (result.stopped > 0) {
        await sendTelegram(`Ended ${result.stopped} active call${result.stopped > 1 ? "s" : ""}.`);
      } else {
        await sendTelegram("No active call found to end.");
      }
    } catch (err) {
      console.error("Failed to stop call", err);
      await sendTelegram("Couldn't reach the phone system to stop the call.");
    }
    return { statusCode: 200, body: "ok" };
  }

  try {
    const contacts = await getContacts();
    const decision = await classify(text, contacts);

    if (decision.isReminder) {
      // A reminder can be a simple "notify me" text, or a scheduled call
      // to someone else - if it's the latter, we need their number.
      if (decision.isScheduledCall && !decision.callTargetNumber) {
        await sendTelegram(decision.followupQuestion || "I'll need their phone number to schedule that call.");
        return { statusCode: 200, body: "ok" };
      }

      try {
        const url = process.env.REMINDERS_APPS_SCRIPT_URL;
        if (url) {
          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "add",
              message: decision.isScheduledCall ? decision.callTask : decision.reminderMessage,
              dueAt: decision.reminderDueAt,
              type: decision.isScheduledCall ? "call" : "notify",
              targetNumber: decision.isScheduledCall ? decision.callTargetNumber : "",
              recurrence: decision.recurrence || "none"
            })
          });
          const when = new Date(decision.reminderDueAt).toLocaleString("en-US", { timeZone: "America/New_York" });
          const recurrenceLabel = { daily: "every day", weekly: "every week", weekdays: "every weekday" }[decision.recurrence] || "";
          if (decision.isScheduledCall) {
            await sendTelegram(`Got it - I'll call ${decision.callTargetSummary || "them"} at ${when}${recurrenceLabel ? ` and ${recurrenceLabel} after that` : ""} to ${decision.callTask}.`);
          } else {
            await sendTelegram(`Got it - I'll remind you: "${decision.reminderMessage}" at ${when}${recurrenceLabel ? ` and ${recurrenceLabel} after that` : ""}.`);
          }
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

async function classify(text, contacts) {
  const now = new Date();
  const nowEastern = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const contactsList = contacts && contacts.length
    ? contacts.map(c => `${c.name}: ${c.phoneNumber}`).join("\n")
    : "(none saved)";

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

Paul's saved contacts (name: phone number):
${contactsList}

If a personal contact mentioned by name (Mom, Sister, Autumn, etc.) matches one of these - even loosely, allowing for nicknames or slightly different phrasing - use their saved number automatically. Don't ask Paul for a number you already have. Only ask for a number if the name isn't in this list at all.

Decide what this message is:
1. A reminder request ("remind me to X at/on Y") - figure out the exact future date/time they mean based on the current time above. This includes SCHEDULED CALLS TO OTHER PEOPLE ("call my mom tomorrow at 9am to remind her about her appointment") - that's still a reminder (isReminder true), but set isScheduledCall true too, since instead of texting Paul, you'll actually place a call at that time. A scheduled call needs the target person's phone number - check the saved contacts list above first; only ask for it in followupQuestion if they're genuinely not in there.

If the request implies repeating ("every day," "every weekday," "daily," "weekly," "every Monday," etc.), set recurrence to "daily", "weekly", or "weekdays" (weekdays = Monday through Friday only, skip weekends). Otherwise set recurrence to "none" for a one-time reminder or call. reminderDueAt should still be the very first occurrence - the system handles repeating it automatically after that.

CRITICAL DISAMBIGUATION: if the message mentions "call [someone]" together with ANY specific time or date ("at 8pm", "tomorrow", "in an hour", "on Friday"), that is ALWAYS case 1 (isReminder true, isScheduledCall true) - never case 2, even though it uses the word "call". Case 2 (immediate call, needsCall true) only applies when NO future time is mentioned at all - the call should happen right now. Example: "call 6064833352 at 8pm to remind of my appointment" -> isReminder: true, isScheduledCall: true, callTargetNumber: "+16064833352", reminderDueAt: <today or tomorrow at 8pm, whichever is the next upcoming 8pm>, callTask: "remind them of their appointment", recurrence: "none". Do NOT set needsCall true for this.
2. A request to call a business or personal contact and do something RIGHT NOW (order, book, ask, deliver a message) - there can be more than one task.
3. A direct question, research request, or general chat you can just answer yourself (using web search if it'd help).

IMPORTANT: For case 2, if it's a BUSINESS and Paul didn't give a phone number, leave businessNumber null - do NOT search the web for it yourself, even though search is available to you. There's a separate, more reliable lookup system for that specifically designed to avoid picking corporate/customer-service numbers over local ones - your job here is only to identify the task and business name. Only fill in businessNumber if Paul explicitly stated it in his message. For personal contacts, check the saved contacts list above first - if they're in there, use that number; only ask Paul directly if they're not saved.

If a business name is ambiguous (e.g. "Marriott in Lexington" could mean multiple actual hotels), do NOT ask about it in plain conversational text - that breaks the required format below. Instead, set needsCall true, leave businessSummary as the general name Paul gave, and put your clarifying question in followupQuestion. The lookup system will handle finding the specific closest match; only ask directly if you genuinely cannot proceed at all.

CRITICAL: No matter what - even if you want to ask a question, express uncertainty, or have a natural back-and-forth - your entire response must ALWAYS be the JSON object below and nothing else. Never write plain sentences outside the JSON structure, even for a clarifying question. Example of doing this correctly for an ambiguous business:
{"isReminder": false, "reminderMessage": "", "reminderDueAt": "", "isScheduledCall": false, "callTargetNumber": "", "callTargetSummary": "", "callTask": "", "recurrence": "none", "needsCall": true, "tasks": [{"task": "Ask for the room rate", "businessNumber": null, "businessSummary": "Marriott in Lexington, KY", "isPersonal": false, "location": "Lexington, KY"}], "followupQuestion": "", "directAnswer": ""}

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"isReminder": true or false, "reminderMessage": "what to remind him of via Telegram, if isReminder is true AND isScheduledCall is false", "reminderDueAt": "ISO 8601 datetime with timezone offset for the first/only occurrence, if isReminder is true, e.g. 2026-08-20T09:00:00-04:00", "isScheduledCall": true if this reminder is actually a scheduled call to someone else rather than a Telegram text to Paul, "callTargetNumber": "E.164 format phone number of who to call, required if isScheduledCall is true", "callTargetSummary": "short name of who's being called, e.g. Mom, if isScheduledCall is true", "callTask": "what Ava should say/discuss on that scheduled call, if isScheduledCall is true", "recurrence": "none", "daily", "weekly", or "weekdays" - whether this reminder/call repeats, "needsCall": true or false, "tasks": [{"task": "...", "businessNumber": "E.164 format only if Paul explicitly said it, otherwise null", "businessSummary": "...", "isPersonal": true/false, "location": "... or null"}], "followupQuestion": "if something's missing (a personal contact's number, or a scheduled call's target number), ask for it here - otherwise empty string", "directAnswer": "if none of the above apply, your actual answer to Paul, written naturally as a Telegram message - otherwise empty string"}`,
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
    return { isReminder: false, isScheduledCall: false, recurrence: "none", needsCall: false, tasks: [], followupQuestion: "", directAnswer: "Sorry, I had trouble understanding that - could you rephrase?" };
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
            radius: 48000.0
          }
        }
      })
    });

    const data = await res.json();
    console.log("Places API lookup", { query: `${extraction.businessSummary} near ${searchArea}`, httpStatus: res.status, ok: res.ok, resultCount: data?.places?.length || 0, allPlaces: data?.places, rawResponse: data });

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

async function getContacts() {
  const url = process.env.REMINDERS_APPS_SCRIPT_URL;
  if (!url) return [];

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "getContacts" })
    });
    const data = await res.json();
    return data?.contacts || [];
  } catch (err) {
    console.error("Failed to fetch contacts", err);
    return [];
  }
}

async function stopActiveCall() {
  const space = process.env.SIGNALWIRE_SPACE_URL;
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const token = process.env.SIGNALWIRE_API_TOKEN;
  const fromNumber = process.env.SIGNALWIRE_NUMBER;
  const auth = Buffer.from(`${projectId}:${token}`).toString("base64");

  const listRes = await fetch(
    `https://${space}/api/laml/2010-04-01/Accounts/${projectId}/Calls.json?Status=in-progress&From=${encodeURIComponent(fromNumber)}`,
    { headers: { "Authorization": `Basic ${auth}` } }
  );

  if (!listRes.ok) {
    const errText = await listRes.text();
    throw new Error(`Failed to list active calls: ${errText}`);
  }

  const listData = await listRes.json();
  const activeCalls = listData?.calls || [];

  let stopped = 0;
  for (const call of activeCalls) {
    const updateRes = await fetch(`https://${space}/api/laml/2010-04-01/Accounts/${projectId}/Calls/${call.sid}.json`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ Status: "completed" })
    });
    if (updateRes.ok) stopped++;
  }

  return { stopped };
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
