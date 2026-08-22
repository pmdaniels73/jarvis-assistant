// Handles requests submitted from the web UI. Same extraction + business
// lookup + outbound calling logic as the phone flow (jarvis-inbound.js),
// just triggered by a typed/spoken message instead of a phone call.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
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
    const extraction = await extractTask(message);
    let tasks = extraction.tasks || [];

    tasks = await Promise.all(tasks.map(async (t) => {
      if (!t.businessNumber && t.businessSummary && !t.isPersonal) {
        return await tryAutoLookup(t);
      }
      return t;
    }));

    const missing = tasks.filter(t => !t.businessNumber);
    if (missing.length > 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          confirmation: extraction.followupQuestion ||
            `I still need a phone number for ${missing.map(t => t.businessSummary || "one of those").join(" and ")}.`
        })
      };
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
      return {
        statusCode: 200,
        body: JSON.stringify({ error: "Couldn't reach the phone system for any of those - try again in a moment." })
      };
    }

    const names = tasks.map(t => t.businessSummary || "them").join(" and ");
    const plural = tasks.length > 1 ? "those" : "that";
    return {
      statusCode: 200,
      body: JSON.stringify({
        confirmation: `Certainly. I'll take care of ${plural} - ringing ${names} - and report back as each one's sorted.`
      })
    };
  } catch (err) {
    console.error("jarvis-web-request error", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Something went wrong" }) };
  }
};

async function tryAutoLookup(extraction) {
  const searchArea = extraction.location || "Paintsville, Kentucky";
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    return {
      ...extraction,
      followupQuestion: `I don't have a way to look that up right now - what's the phone number for ${extraction.businessSummary}?`
    };
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
    console.log("Places API lookup", { query: `${extraction.businessSummary} near ${searchArea}`, resultCount: data?.places?.length || 0, allPlaces: data?.places });

    const place = pickBestPlace(data?.places || []);

    if (place?.internationalPhoneNumber) {
      return {
        ...extraction,
        businessNumber: place.internationalPhoneNumber.replace(/[^\d+]/g, ""),
        businessSummary: place.displayName?.text
          ? `${place.displayName.text}${place.formattedAddress ? ", " + place.formattedAddress : ""}`
          : extraction.businessSummary,
        followupQuestion: ""
      };
    }
  } catch (err) {
    console.error("Places API lookup failed", err);
  }

  return {
    ...extraction,
    followupQuestion: `I couldn't find a number for ${extraction.businessSummary} near ${searchArea}. What's their phone number?`
  };
}

function pickBestPlace(places) {
  const badWords = /customer (care|service)|corporate|headquarters|help ?desk|support center|national (office|line)/i;
  const good = places.filter(p => !badWords.test(p.displayName?.text || ""));
  return (good.length ? good : places)[0];
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
      system: `You extract task info from what someone types to their AI assistant. They may ask for ONE thing, or SEVERAL separate things in the same request (e.g. "order a pizza from Pizza Hut, and call my sister to invite her"). Each thing they want done - whether it's a business or a personal contact - is a separate task, since each needs its own phone call.

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"tasks": [{"task": "short natural-language description of what to do, phrased as a request", "businessNumber": "phone number in E.164 format like +16065551234, or null if not mentioned", "businessSummary": "short name of the business or person", "isPersonal": true if this is a personal contact rather than a business, "location": "a city/area they mentioned for where the business is, or null"}], "followupQuestion": "a natural question covering anything still needed across ALL tasks. Empty string if every task has what it needs."}

For a business with a name but no number, leave businessNumber null - we'll look it up automatically. For a personal contact with no number, that task needs a number in the followupQuestion since we can't look up a private individual.`,
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

  state.targetNumber = toNumber;
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

function baseUrl(event) {
  return process.env.SITE_URL || `https://${event.headers.host}`;
}
