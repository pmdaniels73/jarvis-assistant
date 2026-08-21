// Entry point for OUTBOUND calls using the realtime conversation engine.
// This is the "Url" webhook SignalWire calls when a call connects - it
// must be used together with MachineDetection: "Enable" set when the call
// was created (see placeRealtimeOutboundCall below), since answering
// machine detection only works when requested at call-creation time.
//
// If a machine answered, this leaves a proper voicemail message instead of
// connecting a live conversation engine to an answering machine. If a
// human (or an uncertain result) answered, it connects to the realtime
// server as normal, passing the task through.

exports.handler = async function (event) {
  const params = new URLSearchParams(event.body || "");
  const answeredBy = params.get("AnsweredBy"); // e.g. "human", "machine_start", "machine_end_beep", "unknown"
  const task = event.queryStringParameters?.task
    ? decodeURIComponent(event.queryStringParameters.task)
    : "Have a brief, friendly conversation and help with whatever comes up.";

  console.log("jarvis-realtime-outbound invoked", { answeredBy, task });

  // Only "machine_start" reliably means "definitely an answering machine,
  // before the beep" - other AMD results (silence, fax, etc) are less
  // certain, so we fall through to the normal live-conversation flow for
  // anything else rather than risk skipping a real person.
  if (answeredBy === "machine_start") {
    const message = `Hi, this is Ava, calling on behalf of Paul about: ${task}. Please give him a call back when you get a chance. Thanks!`;
    console.log("Machine detected - leaving voicemail instead of connecting to realtime engine", { message });
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`
    };
  }

  const renderUrl = process.env.REALTIME_SERVER_URL;
  if (!renderUrl) {
    console.error("REALTIME_SERVER_URL is not set");
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong on my end.</Say><Hangup/></Response>`
    };
  }

  const streamUrl = `wss://${renderUrl}/media-stream`;
  const laml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}"><Parameter name="task" value="${escapeXml(task)}" /></Stream></Connect></Response>`;
  console.log("Connecting to realtime engine", { streamUrl, task, laml });

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: laml
  };
};

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
  }[c]));
}
