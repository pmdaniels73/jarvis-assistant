// Handles the live conversation once the outbound call connects to the
// business. Loops: business speaks -> Claude decides the reply -> speak it ->
// listen again, until the task is done, then hangs up and calls Paul back.
//
// State travels in the URL as a base64-encoded JSON blob (task, caller
// number, conversation history so far) - no server-side storage needed.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const VOICE = "Polly.Brian-Neural";

exports.handler = async function (event) {
  const encodedState = event.queryStringParameters?.state;
  const state = decodeState(encodedState);
  const params = new URLSearchParams(event.body || "");
  const speechResult = params.get("SpeechResult");
  const answeredBy = params.get("AnsweredBy");

  if (!state) {
    console.error("Failed to decode state", { encodedStatePresent: !!encodedState, encodedStateLength: encodedState ? encodedState.length : 0 });
    return laml(`<Say voice="${VOICE}">Sorry, something went wrong on my end.</Say><Hangup/>`);
  }

  // Only a beep-confirmed voicemail is reliable enough to act on - other
  // "machine" signals (machine_end_silence, machine_end_other) frequently
  // false-positive on automated hold messages or IVR greetings, so those
  // just proceed into the normal conversation flow instead.
  if (answeredBy === "machine_end_beep") {
    const message = `Hi, this is Jarvis, calling on behalf of Paul. I was trying to ${state.task}. Please give him a call back when you get a chance. Thanks!`;
    try {
      await placeCallback(event, state.callerNumber, `I got voicemail when I called - I left a message, but you may want to follow up directly since I couldn't complete this over voicemail.`);
    } catch (err) {
      console.error("Callback call failed", err);
    }
    return laml(`<Say voice="${VOICE}">${escapeXml(message)}</Say><Hangup/>`);
  }

  if (!speechResult && state.history.length === 0) {
    const opening = await generateOpening(state.task);
    state.history.push({ role: "assistant", content: opening });
    const nextUrl = buildUrl(event, state);
    return laml(`
      <Pause length="4"/>
      <Say voice="${VOICE}">${escapeXml(opening)}</Say>
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="8" actionOnEmptyResult="true" language="en-US"></Gather>
    `);
  }

  if (!speechResult) {
    // Gather timed out with no speech - ask them to repeat rather than
    // restarting the greeting. Count this as a turn toward the safety cap.
    state.emptyTurns = (state.emptyTurns || 0) + 1;
    if (state.emptyTurns >= 3) {
      return await bailOut(event, state, "I couldn't get a response after a few tries - the line may have gone quiet.");
    }
    const nextUrl = buildUrl(event, state);
    return laml(`
      <Say voice="${VOICE}">Sorry, I didn't catch that - could you repeat it?</Say>
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="8" actionOnEmptyResult="true" language="en-US"></Gather>
    `);
  }

  state.history.push({ role: "user", content: speechResult });
  state.turnCount = (state.turnCount || 0) + 1;

  if (state.turnCount > 8) {
    return await bailOut(event, state, "The call went on longer than expected without wrapping up, so I stopped rather than keep going in circles.");
  }

  const reply = await generateReply(state);
  state.history.push({ role: "assistant", content: reply.say });

  if (reply.done) {
    try {
      await placeCallback(event, state.callerNumber, reply.summary);
    } catch (err) {
      console.error("Callback call failed", err);
    }
    return laml(`<Say voice="${VOICE}">${escapeXml(reply.say)}</Say><Hangup/>`);
  }

  const nextUrl = buildUrl(event, state);
  return laml(`
    <Say voice="${VOICE}">${escapeXml(reply.say)}</Say>
    <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="8" actionOnEmptyResult="true" language="en-US"></Gather>
  `);
};

async function bailOut(event, state, reason) {
  try {
    await placeCallback(event, state.callerNumber, reason);
  } catch (err) {
    console.error("Callback call failed", err);
  }
  return laml(`<Say voice="${VOICE}">Sorry, I'm having trouble completing this. I'll let Paul know. Have a good day.</Say><Hangup/>`);
}

async function generateOpening(task) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 100,
      system: `You are Jarvis, calling a business on behalf of Paul. Write the opening line for this phone call, given what Paul needs: "${task}".

Sound like a real, friendly person on the phone - brief, warm, natural. Identify yourself quickly ("Hi, this is Jarvis, I'm calling for Paul") then get to the point in one short, natural sentence - phrase it as a question if it's an inquiry, or a request if it's an order/booking, whatever fits naturally. Use contractions. No corporate or robotic phrasing. Respond with ONLY the line to say, nothing else - no quotes, no explanation.`,
      messages: [{ role: "user", content: "Write the opening line." }]
    })
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  const text = data?.content?.find(b => b.type === "text")?.text;
  return (text || `Hi, this is Jarvis, calling for Paul - ${task}.`).trim();
}

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

You're talking to a real person. Sound like a friendly, casual human on the phone - not a script. Use contractions (I'm, that's, sounds good). Keep it short - one or two sentences at a time, the way real phone conversations actually go. React naturally to what they say (a quick "great" or "perfect" or "got it" before moving on feels human; jumping straight to the next question feels robotic). Avoid corporate phrasing, avoid lists, avoid repeating their words back formally.

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"say": "what to say next", "done": true or false, "summary": "one short sentence summarizing the outcome for Paul, only if done is true, otherwise empty string"}

Set done to true once the task is confirmed complete (order taken and total given, appointment time confirmed, question answered, etc) and "say" contains a brief, warm goodbye.`,
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
