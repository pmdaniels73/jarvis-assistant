// Answers Paul's call to the Jarvis number. Listens to what he wants done,
// figures out the task and the business's phone number, confirms, then
// places an outbound call to actually get it done.
//
// State (task, caller number, conversation history) is passed along as a
// base64-encoded JSON blob in the webhook URLs rather than stored server-side -
// this avoids Netlify Blobs' environment-injection issues entirely.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const VOICE = "Polly.Brian-Neural";

exports.handler = async function (event) {
  const params = new URLSearchParams(event.body || "");
  const speechResult = params.get("SpeechResult");
  const callerNumber = params.get("From");
  const actionUrl = `${baseUrl(event)}/.netlify/functions/jarvis-inbound`;
  const isProcessing = event.queryStringParameters?.process === "1";

  if (isProcessing) {
    const encodedSpeech = event.queryStringParameters?.speech;
    const speechToProcess = encodedSpeech ? Buffer.from(decodeURIComponent(encodedSpeech), "base64").toString("utf8") : "";
    return await processRequest(event, speechToProcess, callerNumber, actionUrl);
  }

  if (!speechResult) {
    return laml(`
      <Say voice="${VOICE}">Good day, sir. What can I take care of for you?</Say>
      <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="3" timeout="8" actionOnEmptyResult="true" language="en-US"></Gather>
    `);
  }

  // Respond instantly so SignalWire doesn't time out waiting on the lookup -
  // the actual (possibly slow) work happens on the next hop.
  const encodedSpeech = encodeURIComponent(Buffer.from(speechResult).toString("base64"));
  const redirectUrl = `${actionUrl}?process=1&speech=${encodedSpeech}`;
  return laml(`
    <Say voice="${VOICE}">One moment, let me check on that.</Say>
    <Redirect method="POST">${escapeXml(redirectUrl)}</Redirect>
  `);
};

async function processRequest(event, speechResult, callerNumber, actionUrl) {
  const extraction = await extractTask(speechResult);
  let tasks = extraction.tasks || [];

  // Resolve business numbers via lookup where needed - personal contacts
  // can't be looked up, so those just carry forward as-is.
  tasks = await Promise.all(tasks.map(async (t) => {
    if (!t.businessNumber && t.businessSummary && !t.isPersonal) {
      return await tryAutoLookup(t);
    }
    return t;
  }));

  const missing = tasks.filter(t => !t.businessNumber);
  if (missing.length > 0) {
    const question = extraction.followupQuestion ||
      `I still need a phone number for ${missing.map(t => t.businessSummary || "one of those").join(" and ")}.`;
    return laml(`
      <Say voice="${VOICE}">${escapeXml(question)}</Say>
      <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="3" timeout="8" actionOnEmptyResult="true" language="en-US"></Gather>
    `);
  }

  const results = await Promise.allSettled(
    tasks.map(t => placeOutboundCall(event, { task: t.task, callerNumber, history: [] }, t.businessNumber))
  );

  const failed = results.filter(r => r.status === "rejected");
  if (failed.length > 0) {
    failed.forEach(f => console.error("Outbound call failed", f.reason));
  }

  const names = tasks.map(t => t.businessSummary || "them").join(" and ");
  if (failed.length === tasks.length) {
    return laml(`<Say voice="${VOICE}">Sorry, I had trouble placing those calls. Try again in a moment.</Say><Hangup/>`);
  }

  const plural = tasks.length > 1 ? "those" : "that";
  return laml(`
    <Say voice="${VOICE}">Certainly, sir. I'll take care of ${plural} - ringing ${escapeXml(names)} - and report back as each one's sorted.</Say>
    <Hangup/>
  `);
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
{"businessNumber": "phone number in E.164 format like +16065551234, or null if you couldn't find a confident match", "businessSummary": "the business name and city you found, e.g. Pizza Hut, Paintsville KY"}`,
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
      return {
        ...extraction,
        businessNumber: result.businessNumber,
        businessSummary: result.businessSummary || extraction.businessSummary,
        followupQuestion: ""
      };
    }
  } catch (e) {
    // fall through to asking Paul
  }

  return {
    ...extraction,
    followupQuestion: `I couldn't find a number for ${extraction.businessSummary} near ${searchArea}. What's their phone number?`
  };
}

async function extractTask(speechText) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: `You extract task info from what someone says to their AI phone assistant. They may ask for ONE thing, or SEVERAL separate things in the same request (e.g. "order a pizza from Pizza Hut, and call my sister to invite her"). Each thing they want done - whether it's a business (order food, check a price, book an appointment) or a personal contact (deliver a message, ask a question) - is a separate task, since each needs its own phone call.

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"tasks": [{"task": "short natural-language description of what to do, phrased as a request", "businessNumber": "phone number in E.164 format like +16065551234, or null if not mentioned", "businessSummary": "short name of the business or person", "isPersonal": true if this is a personal contact rather than a business, "location": "a city/area they mentioned for where the business is, or null"}], "followupQuestion": "a natural question covering anything still needed across ALL tasks - e.g. missing phone numbers for personal contacts. Empty string if every task has what it needs (a business name to look up, or an explicit number)."}

For a business with a name but no number, leave businessNumber null - we'll look it up automatically, no followup needed for that one. For a personal contact with no number, that task needs a number in the followupQuestion since we can't look up a private individual.`,
      messages: [{ role: "user", content: speechText }]
    })
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  const text = data?.content?.find(b => b.type === "text")?.text || "{}";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (e) {
    return { tasks: [{ task: speechText, businessNumber: null, businessSummary: "", isPersonal: false, location: null }], followupQuestion: "What's the phone number for that business?" };
  }
}

async function placeOutboundCall(event, state, toNumber) {
  const space = process.env.SIGNALWIRE_SPACE_URL;
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const token = process.env.SIGNALWIRE_API_TOKEN;
  const fromNumber = process.env.SIGNALWIRE_NUMBER;

  const encodedState = encodeState(state);
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

function encodeState(state) {
  return Buffer.from(JSON.stringify(state)).toString("base64");
}

function baseUrl(event) {
  return process.env.SITE_URL || `https://${event.headers.host}`;
}

function laml(inner) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`
  };
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
  }[c]));
}
