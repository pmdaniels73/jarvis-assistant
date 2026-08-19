// Handles the live conversation once the outbound call connects to the
// business. Loops: business speaks -> Claude decides the reply -> speak it ->
// listen again, until the task is done, then hangs up and calls Paul back.

const { getStore } = require("@netlify/blobs");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const VOICE = "Polly.Matthew-Neural";

exports.handler = async function (event) {
  const taskId = event.queryStringParameters?.taskId;
  const params = new URLSearchParams(event.body || "");
  const speechResult = params.get("SpeechResult");
  const actionUrl = `${baseUrl(event)}/.netlify/functions/jarvis-outbound-voice?taskId=${encodeURIComponent(taskId)}`;

  const store = getStore("jarvis-tasks");
  const taskData = await store.get(taskId, { type: "json" });

  if (!taskData) {
    return laml(`<Say voice="${VOICE}">Sorry, something went wrong on my end.</Say><Hangup/>`);
  }

  if (!speechResult) {
    const opening = `Hi, I'm Jarvis, Paul's personal assistant. I'd like to ${taskData.task}.`;
    taskData.history.push({ role: "assistant", content: opening });
    await store.setJSON(taskId, taskData);
    return laml(`
      <Say voice="${VOICE}">${escapeXml(opening)}</Say>
      <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"></Gather>
    `);
  }

  taskData.history.push({ role: "user", content: speechResult });

  const reply = await generateReply(taskData);
  taskData.history.push({ role: "assistant", content: reply.say });

  if (reply.done) {
    taskData.status = "complete";
    taskData.summary = reply.summary;
    await store.setJSON(taskId, taskData);
    placeCallback(event, taskId).catch(err => console.error("Callback call failed", err));
    return laml(`<Say voice="${VOICE}">${escapeXml(reply.say)}</Say><Hangup/>`);
  }

  await store.setJSON(taskId, taskData);
  return laml(`
    <Say voice="${VOICE}">${escapeXml(reply.say)}</Say>
    <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"></Gather>
  `);
};

async function generateReply(taskData) {
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
      system: `You are Jarvis, Paul's AI assistant, currently on a live phone call with a business to: ${taskData.task}.

You're talking to a real person. Keep replies short and natural, like a real phone conversation - no long sentences, no lists.

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"say": "what to say next", "done": true or false, "summary": "one short sentence summarizing the outcome for Paul, only if done is true, otherwise empty string"}

Set done to true once the task is confirmed complete (order taken and total given, appointment time confirmed, etc) and "say" contains a polite goodbye.`,
      messages: taskData.history.map(h => ({ role: h.role, content: h.content }))
    })
  });
  const data = await res.json();
  const text = data?.content?.find(b => b.type === "text")?.text || "{}";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (e) {
    return { say: "Sorry, could you say that again?", done: false, summary: "" };
  }
}

async function placeCallback(event, taskId) {
  const store = getStore("jarvis-tasks");
  const taskData = await store.get(taskId, { type: "json" });

  const space = process.env.SIGNALWIRE_SPACE_URL;
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const token = process.env.SIGNALWIRE_API_TOKEN;
  const fromNumber = process.env.SIGNALWIRE_NUMBER;

  const webhookUrl = `${baseUrl(event)}/.netlify/functions/jarvis-callback?taskId=${encodeURIComponent(taskId)}`;
  const auth = Buffer.from(`${projectId}:${token}`).toString("base64");
  const body = new URLSearchParams({
    To: taskData.callerNumber,
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
