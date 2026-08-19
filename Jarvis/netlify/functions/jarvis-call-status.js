// SignalWire hits this whenever the outbound business call ends, for ANY
// reason - completed, no-answer, busy, failed, canceled. This is a safety
// net: if the call ended abnormally (short duration, never answered, etc),
// Paul gets notified even though the main conversation flow in
// jarvis-outbound-voice.js never got a chance to call him back itself.
//
// To avoid double-notifying on calls that completed normally (which already
// get a proper callback from jarvis-outbound-voice.js), this only fires a
// fallback message when the call looks like it didn't go well: short
// duration or a non-"completed" status.

const VOICE = "Polly.Brian-Neural";

exports.handler = async function (event) {
  const encodedState = event.queryStringParameters?.state;
  const state = decodeState(encodedState);
  const params = new URLSearchParams(event.body || "");
  const callStatus = params.get("CallStatus");

  if (!state || !state.callerNumber) {
    return { statusCode: 200, body: "ok" };
  }

  let message;
  if (callStatus === "no-answer") {
    message = `I called about "${state.task}" but nobody picked up.`;
  } else if (callStatus === "busy") {
    message = `I tried calling about "${state.task}" but the line was busy.`;
  } else if (callStatus === "failed" || callStatus === "canceled") {
    message = `I wasn't able to complete the call about "${state.task}" - something went wrong connecting.`;
  } else {
    message = `That call about "${state.task}" has ended, sir. If I already rang you with the result, you can disregard this - otherwise, you may want to follow up directly.`;
  }

  try {
    await placeCallback(event, state.callerNumber, message);
  } catch (err) {
    console.error("Status callback notify failed", err);
  }

  return { statusCode: 200, body: "ok" };
};

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
