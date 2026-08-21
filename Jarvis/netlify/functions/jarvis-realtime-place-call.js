// Places a real outbound call through the realtime engine, with proper
// answering machine detection enabled. Kept separate from the live
// Telegram flow so it can be tested independently without any risk to
// what you actually rely on day to day.
//
// Trigger with a GET request, e.g.:
//   https://.../jarvis-realtime-place-call?to=+16065551234&task=Ask+what+time+they+close+tonight

exports.handler = async function (event) {
  const to = event.queryStringParameters?.to;
  const task = event.queryStringParameters?.task || "Have a brief, friendly conversation and help with whatever comes up.";

  if (!to) {
    return { statusCode: 400, body: "Missing 'to' query parameter (E.164 format, e.g. +16065551234)" };
  }

  const space = process.env.SIGNALWIRE_SPACE_URL;
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const token = process.env.SIGNALWIRE_API_TOKEN;
  const fromNumber = process.env.SIGNALWIRE_NUMBER;

  const webhookUrl = `${baseUrl(event)}/.netlify/functions/jarvis-realtime-outbound?task=${encodeURIComponent(task)}`;
  const auth = Buffer.from(`${projectId}:${token}`).toString("base64");

  const body = new URLSearchParams({
    To: to,
    From: fromNumber,
    Url: webhookUrl,
    Method: "POST",
    MachineDetection: "Enable",
    MachineDetectionTimeout: "10",
    Record: "true"
  });

  try {
    const res = await fetch(`https://${space}/api/laml/2010-04-01/Accounts/${projectId}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    const data = await res.json();
    console.log("Placed realtime test call", { to, task, status: res.status, callSid: data.sid });

    if (!res.ok) {
      return { statusCode: 500, body: `SignalWire call failed: ${JSON.stringify(data)}` };
    }

    return { statusCode: 200, body: `Call placed to ${to}. CallSid: ${data.sid}` };
  } catch (err) {
    console.error("Failed to place realtime test call", err);
    return { statusCode: 500, body: `Error: ${err.message}` };
  }
};

function baseUrl(event) {
  return process.env.SITE_URL || `https://${event?.headers?.host}`;
}
