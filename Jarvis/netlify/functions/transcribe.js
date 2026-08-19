// Takes recorded audio from the browser and transcribes it via Deepgram.
// This exists because Firefox and iOS browsers don't reliably support the
// browser's built-in speech recognition, so we record audio client-side
// and transcribe it server-side instead.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const providedPassword = event.headers["x-access-password"] || "";
  if (providedPassword !== process.env.ACCESS_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request body" }) };
  }

  const { audio, mimeType } = parsed;
  if (!audio) {
    return { statusCode: 400, body: JSON.stringify({ error: "No audio received" }) };
  }

  let audioBuffer;
  try {
    audioBuffer = Buffer.from(audio, "base64");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad audio payload" }) };
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "No audio received" }) };
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Deepgram isn't connected yet - no DEEPGRAM_API_KEY configured." }) };
  }

  const dgContentType = (typeof mimeType === "string" && mimeType.startsWith("audio")) ? mimeType : "audio/webm";

  try {
    const res = await fetch("https://api.deepgram.com/v1/listen?smart_format=true", {
      method: "POST",
      headers: {
        "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": dgContentType
      },
      body: audioBuffer
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: `Deepgram error: ${errText}`, debugContentType: dgContentType, debugBytes: audioBuffer.length }) };
    }

    const data = await res.json();
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    return {
      statusCode: 200,
      body: JSON.stringify({ transcript })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Transcription failed" }) };
  }
};// Takes recorded audio from the browser and transcribes it via Deepgram.
// This exists because Firefox and iOS browsers don't reliably support the
// browser's built-in speech recognition, so we record audio client-side
// and transcribe it server-side instead.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const providedPassword = event.headers["x-access-password"] || "";
  if (providedPassword !== process.env.ACCESS_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request body" }) };
  }

  const { audio, mimeType } = parsed;
  if (!audio) {
    return { statusCode: 400, body: JSON.stringify({ error: "No audio received" }) };
  }

  let audioBuffer;
  try {
    audioBuffer = Buffer.from(audio, "base64");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad audio payload" }) };
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "No audio received" }) };
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Deepgram isn't connected yet - no DEEPGRAM_API_KEY configured." }) };
  }

  const dgContentType = (typeof mimeType === "string" && mimeType.startsWith("audio")) ? mimeType : "audio/webm";

  try {
    const res = await fetch("https://api.deepgram.com/v1/listen?smart_format=true", {
      method: "POST",
      headers: {
        "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": dgContentType
      },
      body: audioBuffer
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: `Deepgram error: ${errText}`, debugContentType: dgContentType, debugBytes: audioBuffer.length }) };
    }

    const data = await res.json();
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    return {
      statusCode: 200,
      body: JSON.stringify({ transcript })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Transcription failed" }) };
  }
};
