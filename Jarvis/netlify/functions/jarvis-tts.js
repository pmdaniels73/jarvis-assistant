// Generates speech audio via Azure's Ava Neural voice (the same one used by
// Ridgecall) and returns it as MP3 bytes. SignalWire's <Play> verb fetches
// this URL and plays the audio, since the built-in <Say> verb only supports
// Amazon Polly voices, not Azure's more natural ones.

exports.handler = async function (event) {
  const text = event.queryStringParameters?.text;
  if (!text) {
    return { statusCode: 400, body: "Missing text parameter" };
  }

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    console.error("Azure Speech not configured - missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION");
    return { statusCode: 500, body: "TTS not configured" };
  }

  const ssml = `<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='en-US-AvaNeural'>${escapeSsml(text)}</voice></speak>`;

  try {
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-16khz-32kbitrate-mono-mp3",
        "User-Agent": "JarvisAssistant"
      },
      body: ssml
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Azure TTS request failed", { status: res.status, errText });
      return { statusCode: 500, body: "TTS generation failed" };
    }

    const audioBuffer = await res.arrayBuffer();
    return {
      statusCode: 200,
      headers: { "Content-Type": "audio/mpeg" },
      body: Buffer.from(audioBuffer).toString("base64"),
      isBase64Encoded: true
    };
  } catch (err) {
    console.error("Azure TTS error", err);
    return { statusCode: 500, body: "TTS generation error" };
  }
};

function escapeSsml(str) {
  return String(str).replace(/[<>&'"]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
  }[c]));
}
