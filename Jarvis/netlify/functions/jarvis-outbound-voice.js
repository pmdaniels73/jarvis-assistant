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
    // Generate and speak the REAL, task-specific opening line right away -
    // no generic filler first. Keep the brief pause beforehand, since
    // whoever answers is likely still mid-way through their own greeting
    // the instant the call connects, and talking directly over that
    // seemed to confuse speech detection for whatever they said next.
    const opening = await generateOpening(state.task);
    state.history.push({ role: "assistant", content: JSON.stringify({ say: opening, pressDigits: "", done: false, summary: "" }) });
    const nextUrl = buildUrl(event, state);
    return laml(`
      <Pause length="1"/>
      <Say voice="${VOICE}">${escapeXml(opening)}</Say>
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="2" timeout="20" actionOnEmptyResult="true" language="en-US" hints="hello, hi, hey, yes, no, okay, sure, thanks, goodbye, bye, Paul"></Gather>
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
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="2" timeout="20" actionOnEmptyResult="true" language="en-US" hints="hello, hi, hey, yes, no, okay, sure, thanks, goodbye, bye, Paul"></Gather>
    `);
  }

  return await processReply(event, state, speechResult);
};

async function generateOpening(task) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: FAST_MODEL,
      max_tokens: 100,
      system: `You are Paul's AI phone assistant, about to start a call on his behalf to accomplish: "${task}". When you introduce yourself, your name is Ava - not Jarvis (Jarvis is what Paul calls you, but to people you call, you're Ava).

Write ONE short, natural opening line for this call - identify yourself briefly, then state your actual purpose clearly. You are the caller with a request - never phrase this as offering to help them. Use contractions, sound human, not scripted. Keep it to one short sentence. Vary the phrasing and structure - don't default to the same "Hi, this is Ava, calling on behalf of Paul..." pattern every time; real people open calls differently depending on the situation. Respond with ONLY the line to say, nothing else - no quotes, no JSON, no explanation.`,
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
  return (text || `Hi, this is Ava, calling for Paul - ${task}.`).trim();
}

async function processReply(event, state, heardSpeech) {
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

You're talking to a real person (unless a new automated menu comes up mid-call - see below). Sound like a friendly, casual human on the phone - not a script. Use contractions (I'm, that's, sounds good). Every extra word adds real delay before you can speak, since longer replies take longer to synthesize - so keep it TIGHT: one short sentence whenever you can, never more than a short two. Say only what's needed to move the conversation forward.

Don't default to the same phrases every time - real people don't repeat an identical catchphrase on every call. Vary how you acknowledge things: sometimes "got it," sometimes "okay cool," sometimes just moving straight to the next thing with no acknowledgment word at all. Avoid always sounding uniformly upbeat ("Perfect! Thanks so much!") - that reads as performative. Most real phone calls are more understated than that; match a calmer, more natural register most of the time, and save genuine warmth for when it actually fits.

Don't restate everything back to confirm it - that's a scripted-sounding habit. A brief "got it" is usually enough. Only repeat something back in full when it's genuinely worth double-checking, like a final order total or an appointment time - not routine responses.

Write money and numbers the way you'd actually SAY them out loud, never with symbols - "one ninety-nine" or "a dollar ninety-nine" instead of "$1.99", "eight dollars" instead of "$8", "twelve fifty" instead of "$12.50". The text you write gets spoken directly, and symbols get read literally (like "one dot 99") instead of naturally.

CRITICAL - remember your role: YOU are the caller. YOU called THEM with a specific request. Never ask "what can I help you with," "how can I help you," or anything similar - that's their line, not yours, and it confuses whoever answers since you're the one who initiated the call. If you haven't yet told them why you're calling, your very next line must state your purpose clearly (e.g. "Hi, I'm calling to ask what time you close tonight") - don't wait for them to ask, and don't offer to help them with anything.

CRITICAL - stick to exactly what the task asks for, nothing more:
- If the task only asks to find out something (a price, hours, availability, whether they have something in stock), that's ALL you do. Get the answer, then wrap up - do NOT proceed to place an order or make a booking, even if it would be easy to, even if they ask "would you like to order?" If asked, politely say you're just checking on pricing/info for now and that's it.
- Only place an order or make a booking if the task explicitly says to do that (words like "order," "book," "reserve," "schedule"). In that case, see it through completely - confirm size/quantity/details, pickup vs delivery, and give Paul's name/address/payment approach when asked, using the info above. Don't stop at just getting a price if the task was to actually order/book something.
- When genuinely unsure which category a task falls into, treat it as information-only and don't take action - Paul can always call back to actually order once he has the price.

If what you just heard sounds cut off, incomplete, or like it blends into a menu/list of options (e.g. "...for $8.99, are you calling to place an order, ask about hours, or..."), you may have started talking over them mid-sentence. Don't confidently treat a fragment like that as the final, complete answer - acknowledge what you caught, and if anything is unclear or seems incomplete, ask a brief clarifying question rather than declaring done.

If you get transferred and suddenly hear an automated menu ("press 1 for..."), you can press digits: set "pressDigits" to the digit(s) needed instead of (or alongside) speaking.

If what you just heard is purely transitional - "one moment," "please hold," "transferring you now," a recorded disclaimer, or similar - there's nothing to actually respond to. Set "say" and "pressDigits" to empty strings AND set "waiting" to true, so you just listen quietly for what comes next instead of saying anything.

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"say": "what to say next, or empty string if you're only pressing digits or waiting", "pressDigits": "digit(s) to press if a menu just came up, otherwise empty string", "waiting": true if you're deliberately staying silent because what you heard was purely transitional, otherwise false, "done": true or false, "summary": "one short sentence summarizing the outcome for Paul, only if done is true, otherwise empty string"}

Set done to true once the task is confirmed complete (order taken and total given, appointment time confirmed, question answered, message delivered, etc) and "say" contains a brief goodbye. Vary how you sign off - don't default to the same closing line every call ("thanks so much, have a great day!" every time reads as scripted). Something as simple as "alright, thanks" or "sounds good, bye" is often more natural than an enthusiastic send-off.`,
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
