// Handles the live conversation once the outbound call connects to the
// business. Loops: business speaks -> Claude decides the reply -> speak it ->
// listen again, until the task is done, then hangs up and calls Paul back.
//
// State travels in the URL as a base64-encoded JSON blob (task, caller
// number, conversation history so far) - no server-side storage needed.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const VOICE = "Polly.Matthew-Neural";

exports.handler = async function (event) {
  const encodedState = event.queryStringParameters?.state;
  const state = decodeState(encodedState);
  const params = new URLSearchParams(event.body || "");
  const speechResult = params.get("SpeechResult");

  if (!state) {
    return laml(`<Say voice="${VOICE}">Sorry, something went wrong on my end.</Say><Hangup/>`);
  }

  if (!speechResult && state.history.length === 0) {
    const opening = `Hi, I'm Jarvis, Paul's personal assistant. I'd like to ${state.task}.`;
    state.history.push({ role: "assistant", content: opening });
    const nextUrl = buildUrl(event, state);
    return laml(`
      <Say voice="${VOICE}">${escapeXml(opening)}</Say>
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="auto" language="en-US"></Gather>
    `);
  }

  if (!speechResult) {
    // Gather timed out with no speech - ask them to repeat rather than
    // restarting the greeting.
    const nextUrl = buildUrl(event, state);
    return laml(`
      <Say voice="${VOICE}">Sorry, I didn't catch that - could you repeat it?</Say>
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="auto" language="en-US"></Gather>
    `);
  }

  state.history.push({ role: "user", content: speechResult });

  const reply = await generateReply(state);
  state.history.push({ role: "assistant", content: reply.say });

  if (reply.done) {
    placeCallback(event, state.callerNumber, reply.summary).catch(err => {
      console.error("Callback call failed", err);
    });
    return laml(`<Say voice="${VOICE}">${escapeXml(reply.say)}</Say><Hangup/>`);
  }

  const nextUrl = buildUrl(event, state);
  return laml(`
    <Say voice="${VOICE}">${escapeXml(reply.say)}</Say>
    <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="auto" language="en-US"></Gather>
  `);
};

async function generateReply(state) {
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
      system: `You are Jarvis, Paul's AI assistant, currently on a live phone call with a business to: ${state.task}.

You're talking to a real person. Keep replies short and natural, like a real phone conversation - no long sentences, no lists.

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"say": "what to say next", "done": true or false, "summary": "one short sentence summarizing the outcome for Paul, only if done is true, otherwise empty string"}

Set done to true once the task is confirmed complete (order taken and total given, appointment time confirmed, etc) and "say" contains a polite goodbye.`,
      messages: state.history.map(h => ({ role: h.role, content: h.content }))
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
    return { say: "Sorry, could you say that again?", done: false, summary: "" };
  }
}

async function placeCallback(event, callerNumber, summary) {
  const space = process.env.SIGNALWIRE_SPACE_URL;
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const token = process.env.SIGNALWIRE_API_TOKEN;
  const fromNumber = process.env.SIGNALWIRE_NUMBER;

  const encodedSummary = Buffer.from(summary || "").toString("base64");
  const webhookUrl = `${baseUrl(event)}/.netlify/functions/jarvis-callback?summary=${encodeURIComponent(encodedSummary)}`;
  const auth = Buffer.from(`${projectId}:${token}`).toString("base64");
  const body = new URLSearchParams({
    To: callerNumber,
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
    throw new Error(`Callback call failed: ${errText}`);
  }
}

function buildUrl(event, state) {
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
  return `${baseUrl(event)}/.netlify/functions/jarvis-outbound-voice?state=${encodeURIComponent(encoded)}`;
}

function decodeState(encoded) {
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (e) {
    return null;
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
