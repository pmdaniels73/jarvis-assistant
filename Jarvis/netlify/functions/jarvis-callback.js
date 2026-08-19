// Calls Paul back once the outbound task is done and speaks a summary.
// The summary travels in the URL as base64 - no server-side storage needed.

const VOICE = "Polly.Brian-Neural";

exports.handler = async function (event) {
  const encodedSummary = event.queryStringParameters?.summary;
  let summary = "";
  if (encodedSummary) {
    try {
      summary = Buffer.from(encodedSummary, "base64").toString("utf8");
    } catch (e) {
      summary = "";
    }
  }

  if (!summary) {
    summary = "I finished the call, but I don't have a clean summary for you - you may want to check in with them directly.";
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE}">It's Jarvis, sir. ${escapeXml(summary)}</Say><Hangup/></Response>`
  };
};

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
  }[c]));
}
