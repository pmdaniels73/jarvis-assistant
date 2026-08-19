// Answers Paul's call to the Jarvis number. Listens to what he wants done,
// figures out the task and the business's phone number, confirms, then
// places an outbound call to actually get it done.

const { getStore } = require("@netlify/blobs");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const VOICE = "Polly.Matthew-Neural";

exports.handler = async function (event) {
  const params = new URLSearchParams(event.body || "");
  const speechResult = params.get("SpeechResult");
  const callerNumber = params.get("From");
  const callSid = params.get("CallSid");
  const actionUrl = `${baseUrl(event)}/.netlify/functions/jarvis-inbound`;

  if (!speechResult) {
    return laml(`
      <Say voice="${VOICE}">Hey Paul, what do you need me to take care of?</Say>
      <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"></Gather>
    `);
  }

  const extraction = await extractTask(speechResult);

  if (!extraction.businessNumber) {
    return laml(`
      <Say voice="${VOICE}">${escapeXml(extraction.followupQuestion || "What's the phone number for that business?")}</Say>
      <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"></Gather>
    `);
  }

  const taskId = callSid || `task-${Date.now()}`;
  const store = getStore("jarvis-tasks");
  await store.setJSON(taskId, {
    task: extraction.task,
    businessNumber: extraction.businessNumber,
    callerNumber: callerNumber,
    history: [],
    status: "pending"
  });

  placeOutboundCall(event, taskId, extraction.businessNumber).catch(err => {
    console.error("Outbound call failed", err);
  });

  return laml(`
    <Say voice="${VOICE}">Got it. I'll call ${escapeXml(extraction.businessSummary || "them")} now and call you back when it's done.</Say>
    <Hangup/>
  `);
};

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
{"task": "short natural-language description of what to do, phrased as a request, e.g. 'order a large pepperoni pizza'", "businessNumber": "phone number in E.164 format like +16065551234, or null if not mentioned", "businessSummary": "short name of the business, e.g. Pizza Hut", "followupQuestion": "a natural question to ask if businessNumber is null, otherwise empty string"}

If they didn't give a phone number for the business, set businessNumber to null and write a natural followupQuestion asking for their phone number.`,
      messages: [{ role: "user", content: speechText }]
    })
  });
  const data = await res.json();
  const text = data?.content?.find(b => b.type === "text")?.text || "{}";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (e) {
    return { task: speechText, businessNumber: null, businessSummary: "", followupQuestion: "What's the phone number for that business?" };
  }
}

async function placeOutboundCall(event, taskId, toNumber) {
  const space = process.env.SIGNALWIRE_SPACE_URL;
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const token = process.env.SIGNALWIRE_API_TOKEN;
  const fromNumber = process.env.SIGNALWIRE_NUMBER;

  const webhookUrl = `${baseUrl(event)}/.netlify/functions/jarvis-outbound-voice?taskId=${encodeURIComponent(taskId)}`;
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
