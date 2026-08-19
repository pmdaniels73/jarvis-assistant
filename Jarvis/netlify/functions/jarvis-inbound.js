// Answers Paul's call to the Jarvis number. Listens to what he wants done,
// figures out the task and the business's phone number, confirms, then
// places an outbound call to actually get it done.
//
// State (task, caller number, conversation history) is passed along as a
// base64-encoded JSON blob in the webhook URLs rather than stored server-side -
// this avoids Netlify Blobs' environment-injection issues entirely.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const VOICE = "Polly.Matthew-Neural";

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
      <Say voice="${VOICE}">Hey Paul, what do you need me to take care of?</Say>
      <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="3" language="en-US"></Gather>
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
  let extraction = await extractTask(speechResult);

  if (!extraction.businessNumber && extraction.businessSummary) {
    extraction = await tryAutoLookup(extraction);
  }

  if (!extraction.businessNumber) {
    return laml(`
      <Say voice="${VOICE}">${escapeXml(extraction.followupQuestion || "What's the phone number for that business?")}</Say>
      <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="3" language="en-US"></Gather>
    `);
  }

  try {
    await placeOutboundCall(event, {
      task: extraction.task,
      callerNumber,
      history: []
    }, extraction.businessNumber);
  } catch (err) {
    console.error("Outbound call failed", err);
    return laml(`<Say voice="${VOICE}">Sorry, I had trouble placing that call. Try again in a moment.</Say><Hangup/>`);
  }

  return laml(`
    <Say voice="${VOICE}">Got it. I'll call ${escapeXml(extraction.businessSummary || "them")} now and call you back when it's done.</Say>
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
      system: `You extract task info from what someone says to their AI phone assistant. They're asking the assistant to call a business and do something on their behalf (order food, book an appointment, etc).

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"task": "short natural-language description of what to do, phrased as a request, e.g. 'order a large pepperoni pizza'", "businessNumber": "phone number in E.164 format like +16065551234, or null if not mentioned", "businessSummary": "short name of the business, e.g. Pizza Hut", "location": "a city/area they mentioned for where the business is, or null if not mentioned", "followupQuestion": "a natural question to ask if businessNumber is null AND businessSummary is also null or too vague to look up, otherwise empty string"}

If they didn't give a phone number but did name a specific business, leave businessNumber null and followupQuestion empty - we'll look the number up automatically. Only set followupQuestion if you truly don't have enough to find the business (e.g. they only said "order me food" with no business name at all).`,
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
    return { task: speechText, businessNumber: null, businessSummary: "", location: null, followupQuestion: "What's the phone number for that business?" };
  }
}

async function placeOutboundCall(event, state, toNumber) {
  const space = process.env.SIGNALWIRE_SPACE_URL;
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const token = process.env.SIGNALWIRE_API_TOKEN;
  const fromNumber = process.env.SIGNALWIRE_NUMBER;

  const encodedState = encodeState(state);
  const webhookUrl = `${baseUrl(event)}/.netlify/functions/jarvis-outbound-voice?state=${encodeURIComponent(encodedState)}`;
  const auth = Buffer.from(`${projectId}:${token}`).toString("base64");
  const body = new URLSearchParams({
    To: toNumber,
    From: fromNumber,
    Url: webhookUrl,
    Method: "POST"
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
