// Calls Paul back once the outbound task is done and speaks a summary.

const { getStore } = require("@netlify/blobs");

const VOICE = "Polly.Matthew-Neural";

exports.handler = async function (event) {
  const taskId = event.queryStringParameters?.taskId;
  const store = getStore("jarvis-tasks");
  const taskData = await store.get(taskId, { type: "json" });

  const summary = taskData?.summary ||
    "I finished the call, but I don't have a clean summary for you - you may want to check in with them directly.";

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE}">Hey Paul, it's Jarvis. ${escapeXml(summary)}</Say><Hangup/></Response>`
  };
};

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
  }[c]));
}
