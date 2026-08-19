// Handles requests submitted from the web UI. Same extraction + business
// lookup + outbound calling logic as the phone flow (jarvis-inbound.js),
// just triggered by a typed/spoken message instead of a phone call.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const providedPassword = event.headers["x-access-password"] || "";
  if (providedPassword !== process.env.ACCESS_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request body" }) };
  }

  const message = body.message;
  if (!message) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing message" }) };
  }

  try {
    let extraction = await extractTask(message);

    if (!extraction.businessNumber && extraction.businessSummary) {
      extraction = await tryAutoLookup(extraction);
    }

    if (!extraction.businessNumber) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          confirmation: extraction.followupQuestion || "I need a bit more info - what's the phone number for that business?"
        })
      };
    }

    const callerNumber = process.env.PAUL_PHONE_NUMBER;
    try {
      await placeOutboundCall(event, {
        task: extraction.task,
        callerNumber,
        history: []
      }, extraction.businessNumber);
    } catch (err) {
      console.error("Outbound call failed", err);
      return {
        statusCode: 200,
        body: JSON.stringify({ error: `Couldn't reach the phone system: ${err.message}` })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        confirmation: `Certainly. I'll ring ${extraction.businessSummary || "them"} straight away and report back once it's sorted.`
      })
    };
  } catch (err) {
    console.error("jarvis-web-request error", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Something went wrong" }) };
  }
};

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
      system: `You extract task info from what someone types to their AI assistant. They're asking the assistant to call a business and do something on their behalf (order food, book an appointment, etc).

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"task": "short natural-language description of what to do, phrased as a request, e.g. 'order a large pepperoni pizza'", "businessNumber": "phone number in E.164 format like +16065551234, or null if not mentioned", "businessSummary": "short name of the business, e.g. Pizza Hut", "location": "a city/area they mentioned for where the business is, or null if not mentioned", "followupQuestion": "a natural question to ask if businessNumber is null AND businessSummary is also null or too vague to look up, otherwise empty string"}

If they didn't give a phone number but did name a specific business, leave businessNumber null and followupQuestion empty - we'll look the number up automatically. Only set followupQuestion if you truly don't have enough to find the business.`,
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

  const encodedState = Buffer.from(JSON.stringify(state)).toString("base64");
  const webhookUrl = `${baseUrl(event)}/.netlify/functions/jarvis-outbound-voice?state=${encodeURIComponent(encodedState)}`;
  const auth = Buffer.from(`${projectId}:${token}`).toString("base64");
  const body = new URLSearchParams({
    To: toNumber,
    From: fromNumber,
    Url: webhookUrl,
    Method: "POST",
    MachineDetection: "Enable",
    MachineDetectionTimeout: "10"
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

function baseUrl(event) {
  return process.env.SITE_URL || `https://${event.headers.host}`;
}
