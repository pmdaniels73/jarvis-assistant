// Handles the live conversation once the outbound call connects to the
// business. Loops: business speaks -> Claude decides the reply -> speak it ->
// listen again, until the task is done, then hangs up and calls Paul back.
//
// State travels in the URL as a base64-encoded JSON blob (task, caller
// number, conversation history so far) - no server-side storage needed.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
// Haiku is fast and proved reliable for the simple, single-shot opening
// decision (menu/hold/respond). But it started ignoring the "JSON only"
// instruction once the ongoing conversation's message history grew longer,
// silently discarding good answers - so that part stays on Sonnet, where
// correctness matters more than shaving off a second.
const FAST_MODEL = "claude-haiku-4-5-20251001";
const MODEL = "claude-sonnet-4-6";
const VOICE = "azure.en-US-AvaNeural"; // Confirmed working on Ridgecall - genuinely natural, not the robotic Polly voice

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
    const message = `Hi, this is Ava, calling on behalf of Paul. I was trying to ${state.task}. Please give him a call back when you get a chance. Thanks!`;
    await sendTelegram(`I got voicemail when I called about "${state.task}" - I left a message, but you may want to follow up directly since I couldn't complete this over voicemail.`);
    return laml(`<Say voice="${VOICE}">${escapeXml(message)}</Say><Hangup/>`);
  }

  if (state.history.length === 0) {
    // Say something brief and generic the instant the call connects - a
    // real person never sits in dead air - but hold off on the actual
    // task-specific message until we hear what comes back. That way a
    // menu or hold message only gets talked over by a short "hi", not the
    // full request, and the real opening line only gets delivered once we
    // know we're actually talking to someone.
    const filler = "Hi there!";
    state.history.push({ role: "assistant", content: JSON.stringify({ say: filler, pressDigits: "", done: false, summary: "" }) });
    const nextUrl = buildUrl(event, state);
    return laml(`
      <Say voice="${VOICE}">${escapeXml(filler)}</Say>
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="2" timeout="20" actionOnEmptyResult="true" language="en-US" hints="hello, hi, hey, yes, no, okay, sure, thanks, goodbye, bye, Paul"></Gather>
    `);
  }

  const isProcessing = event.queryStringParameters?.process === "1";

  if (isProcessing) {
    // Do the actual work now. SignalWire's <Redirect> does NOT carry the
    // original SpeechResult forward into this new request, so we read it
    // from the URL where we explicitly encoded it, not from this request's
    // body.
    const encodedHeard = event.queryStringParameters?.heard;
    const heardSpeech = encodedHeard ? Buffer.from(decodeURIComponent(encodedHeard), "base64").toString("utf8") : "";

    state.history.push({ role: "user", content: heardSpeech });
    state.turnCount = (state.turnCount || 0) + 1;

    if (state.turnCount > 8) {
      return await bailOut(event, state, "The call went on longer than expected without wrapping up, so I stopped rather than keep going in circles.");
    }

    const reply = await generateReply(state);
    console.log("generateReply result", { heard: heardSpeech, reply });
    state.history.push({ role: "assistant", content: JSON.stringify({ say: reply.say, pressDigits: reply.pressDigits || "", waiting: reply.waiting || false, done: reply.done, summary: reply.summary || "" }) });

    if (reply.done) {
      await sendTelegram(`Done - ${reply.summary}`);
      return laml(`
        ${reply.pressDigits ? `<Play digits="w${escapeXml(reply.pressDigits)}w${escapeXml(reply.pressDigits)}"/>` : ""}
        ${reply.say ? `<Say voice="${VOICE}">${escapeXml(reply.say)}</Say>` : ""}
        <Hangup/>
      `);
    }

    const nextUrl = buildUrl(event, state);
    return laml(`
      ${reply.pressDigits ? `<Play digits="w${escapeXml(reply.pressDigits)}w${escapeXml(reply.pressDigits)}"/>` : ""}
      ${reply.say ? `<Say voice="${VOICE}">${escapeXml(reply.say)}</Say>` : ""}
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="2" timeout="20" actionOnEmptyResult="true" language="en-US" hints="hello, hi, hey, yes, no, okay, sure, thanks, goodbye, bye, Paul"></Gather>
    `);
  }

  if (!speechResult) {
    // Gather timed out with no speech - ask them to repeat rather than
    // restarting the greeting. Count this as a turn toward the safety cap.
    // No ack+redirect needed here since there's no real work to mask -
    // this is already a fast, static response.
    state.emptyTurns = (state.emptyTurns || 0) + 1;
    if (state.emptyTurns >= 3) {
      return await bailOut(event, state, "I couldn't get a response after a few tries - the line may have gone quiet.");
    }
    const nextUrl = buildUrl(event, state);
    return laml(`
      <Say voice="${VOICE}">Sorry, I didn't catch that - could you repeat it?</Say>
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="2" timeout="20" actionOnEmptyResult="true" language="en-US" hints="hello, hi, hey, yes, no, okay, sure, thanks, goodbye, bye, Paul"></Gather>
    `);
  }

  // We just heard real speech - respond FAST with a quick acknowledgment
  // (no Claude call, so this is near-instant) and redirect to do the
  // actual thinking. The caller hears something immediately instead of
  // dead air while generateReply runs - masking the real processing time
  // the same way Amy's system does for Silver Spoon.
  const fillers = ["Mm-hmm, one sec.", "Okay, just a moment.", "Got it, hang on."];
  const filler = fillers[Math.floor(Math.random() * fillers.length)];
  const processUrl = buildProcessUrl(event, state, speechResult);
  return laml(`
    <Say voice="${VOICE}">${escapeXml(filler)}</Say>
    <Redirect method="POST">${escapeXml(processUrl)}</Redirect>
  `);
};

async function bailOut(event, state, reason) {
  await sendTelegram(`Couldn't complete "${state.task}" - ${reason}`);
  return laml(`<Say voice="${VOICE}">Sorry, I'm having trouble completing this. I'll let Paul know. Have a good day.</Say><Hangup/>`);
}

async function generateReply(state) {
  const profile = buildProfileContext();

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: FAST_MODEL,
      max_tokens: 150,
      system: [{
        type: "text",
        text: `You are Paul's AI assistant, currently on a live phone call to: ${state.task}. Your name, to whoever you're talking to, is Ava - not Jarvis (that's what Paul calls you, but you introduce yourself to others as Ava). If asked your name, say Ava.

${profile}

You're talking to a real person (unless a new automated menu comes up mid-call - see below). Sound like a friendly, casual human on the phone - not a script. Use contractions (I'm, that's, sounds good). Every extra word adds real delay before you can speak, since longer replies take longer to synthesize - so keep it TIGHT: one short sentence whenever you can, never more than a short two. Say only what's needed to move the conversation forward. React naturally but briefly - a quick "great" or "got it" is enough, don't over-elaborate.

If this is an actual order or booking, see it through completely - confirm size/quantity/details, pickup vs delivery, and give Paul's name/address/payment approach when asked, using the info above. Don't stop at just getting a price if Paul's task was to actually order/book something.

If what you just heard sounds cut off, incomplete, or like it blends into a menu/list of options (e.g. "...for $8.99, are you calling to place an order, ask about hours, or..."), you may have started talking over them mid-sentence. Don't confidently treat a fragment like that as the final, complete answer - acknowledge what you caught, and if anything is unclear or seems incomplete, ask a brief clarifying question rather than declaring done.

If you get transferred and suddenly hear an automated menu ("press 1 for..."), you can press digits: set "pressDigits" to the digit(s) needed instead of (or alongside) speaking.

If what you just heard is purely transitional - "one moment," "please hold," "transferring you now," a recorded disclaimer, or similar - there's nothing to actually respond to. Set "say" and "pressDigits" to empty strings AND set "waiting" to true, so you just listen quietly for what comes next instead of saying anything.

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"say": "what to say next, or empty string if you're only pressing digits or waiting", "pressDigits": "digit(s) to press if a menu just came up, otherwise empty string", "waiting": true if you're deliberately staying silent because what you heard was purely transitional, otherwise false, "done": true or false, "summary": "one short sentence summarizing the outcome for Paul, only if done is true, otherwise empty string"}

Set done to true once the task is confirmed complete (order taken and total given, appointment time confirmed, question answered, message delivered, etc) and "say" contains a brief, warm goodbye.`,
        cache_control: { type: "ephemeral" }
      }],
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
  console.log("generateReply raw response", { rawText: text, apiError: data?.error });

  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    // Guard against a technically-valid-but-empty/malformed response (e.g.
    // {}) that would otherwise leave the call silent with nothing to say -
    // but a deliberate "waiting" response (transitional message, nothing to
    // respond to) is valid and should NOT trigger the fallback apology.
    if (!parsed || (!parsed.say && !parsed.pressDigits && !parsed.waiting)) {
      throw new Error("Empty or missing say/pressDigits/waiting in response");
    }
    return parsed;
  } catch (e) {
    console.error("generateReply parse/validation failed", { rawText: text, error: e.message });
    return { say: "Sorry, could you say that again?", pressDigits: "", waiting: false, done: false, summary: "" };
  }
}

function buildProfileContext() {
  const name = process.env.PAUL_NAME || "Paul";
  const address = process.env.PAUL_ADDRESS || "";
  const lines = [
    `Paul's info, for when it's needed to complete a transaction:`,
    `- Name to give: ${name}`,
    address ? `- Delivery address (only give this if delivery is actually needed): ${address}` : `- No delivery address on file - if delivery requires an address you don't have, ask Paul to provide it by having the business call him back, or default to pickup instead if that's an option.`,
    `- Payment: say Paul will pay in cash or card at pickup/delivery. Never give a credit card number over the phone.`
  ];
  return lines.join("\n");
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("Telegram not configured - message not sent:", message);
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `🤵 Jarvis: ${message}` })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Telegram send failed:", errText);
    }
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}

function buildUrl(event, state) {
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
  return `${baseUrl(event)}/.netlify/functions/jarvis-outbound-voice?state=${encodeURIComponent(encoded)}`;
}

function buildProcessUrl(event, state, heardSpeech) {
  const encodedState = Buffer.from(JSON.stringify(state)).toString("base64");
  const encodedHeard = encodeURIComponent(Buffer.from(heardSpeech).toString("base64"));
  return `${baseUrl(event)}/.netlify/functions/jarvis-outbound-voice?state=${encodeURIComponent(encodedState)}&process=1&heard=${encodedHeard}`;
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
