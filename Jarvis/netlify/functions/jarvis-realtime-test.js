// Temporary test endpoint - connects an inbound call directly to the new
// Jarvis Realtime WebSocket server instead of the normal Say/Gather flow.
// Point a SignalWire number's "when a call comes in" webhook at this URL
// to test the streaming foundation, then point it back afterward.

exports.handler = async function () {
  const renderUrl = process.env.REALTIME_SERVER_URL; // e.g. your-app.onrender.com (no wss://, no path)
  if (!renderUrl) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Realtime server URL isn't configured yet.</Say><Hangup/></Response>`
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${renderUrl}/media-stream" /></Connect></Response>`
  };
};
