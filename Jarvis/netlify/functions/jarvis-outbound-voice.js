// Handles the live conversation once the outbound call connects to the
// business. Loops: business speaks -> Claude decides the reply -> speak it ->
// listen again, until the task is done, then hangs up and calls Paul back.
//
// State travels in the URL as a base64-encoded JSON blob (task, caller
// number, conversation history so far) - no server-side storage needed.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const VOICE = "Polly.Brian-Neural";

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
    const message = `Hi, this is Jarvis, calling on behalf of Paul. I was trying to ${state.task}. Please give him a call back when you get a chance. Thanks!`;
    await sendTelegram(`I got voicemail when I called about "${state.task}" - I left a message, but you may want to follow up directly since I couldn't complete this over voicemail.`);
    return laml(`<Say voice="${VOICE}">${escapeXml(message)}</Say><Hangup/>`);
  }

  if (state.history.length === 0) {
    // We haven't spoken yet - we're waiting to hear whether it's a live
    // person or an automated hold/IVR message, which can run anywhere from
    // a few seconds to several minutes. No fixed pause can handle that, so
    // instead we listen silently and judge what we hear.
    if (!speechResult) {
      state.waitAttempts = (state.waitAttempts || 0) + 1;
      if (state.waitAttempts > 10) {
        return await bailOut(event, state, "I waited several minutes but never got a live person on the line, so I gave up.");
      }
      const nextUrl = buildUrl(event, state);
      return laml(`
        <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="15" actionOnEmptyResult="true" language="en-US"></Gather>
      `);
    }

    const judged = await judgeAndOpen(speechResult, state.task);

    if (judged.situation === "menu" && judged.pressDigits) {
      // Automated phone menu - press the digit that matches what we need,
      // then keep listening for what comes next.
      state.waitAttempts = (state.waitAttempts || 0) + 1;
      if (state.waitAttempts > 10) {
        return await bailOut(event, state, "I got stuck navigating an automated phone menu and couldn't find my way to a live person.");
      }
      const nextUrl = buildUrl(event, state);
      return laml(`
        <Play digits="${escapeXml(judged.pressDigits)}"/>
        <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="15" actionOnEmptyResult="true" language="en-US"></Gather>
      `);
    }

    if (judged.situation !== "person") {
      // Still on hold, or a menu with no clear matching option - keep
      // listening quietly rather than talking over it.
      state.waitAttempts = (state.waitAttempts || 0) + 1;
      if (state.waitAttempts > 10) {
        return await bailOut(event, state, "I was stuck on hold or in a phone menu for several minutes and never reached a live person.");
      }
      const nextUrl = buildUrl(event, state);
      return laml(`
        <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="15" actionOnEmptyResult="true" language="en-US"></Gather>
      `);
    }

    // A live person just greeted us - respond now.
    state.history.push({ role: "user", content: speechResult });
    state.history.push({ role: "assistant", content: judged.openingLine });
    const nextUrl = buildUrl(event, state);
    return laml(`
      <Say voice="${VOICE}">${escapeXml(judged.openingLine)}</Say>
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="8" actionOnEmptyResult="true" language="en-US"></Gather>
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
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="8" actionOnEmptyResult="true" language="en-US"></Gather>
    `);
  }

  state.history.push({ role: "user", content: speechResult });
  state.turnCount = (state.turnCount || 0) + 1;

  if (state.turnCount > 8) {
    return await bailOut(event, state, "The call went on longer than expected without wrapping up, so I stopped rather than keep going in circles.");
  }

  const reply = await generateReply(state);
  state.history.push({ role: "assistant", content: reply.say || "(pressed digits)" });

  if (reply.done) {
    await sendTelegram(`Done - ${reply.summary}`);
    return laml(`
      ${reply.pressDigits ? `<Play digits="${escapeXml(reply.pressDigits)}"/>` : ""}
      ${reply.say ? `<Say voice="${VOICE}">${escapeXml(reply.say)}</Say>` : ""}
      <Hangup/>
    `);
  }

  const nextUrl = buildUrl(event, state);
  return laml(`
    ${reply.pressDigits ? `<Play digits="${escapeXml(reply.pressDigits)}"/>` : ""}
    ${reply.say ? `<Say voice="${VOICE}">${escapeXml(reply.say)}</Say>` : ""}
    <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="8" actionOnEmptyResult="true" language="en-US"></Gather>
  `);
};

async function bailOut(event, state, reason) {
  await sendTelegram(`Couldn't complete "${state.task}" - ${reason}`);
  return laml(`<Say voice="${VOICE}">Sorry, I'm having trouble completing this. I'll let Paul know. Have a good day.</Say><Hangup/>`);
}

async function judgeAndOpen(heardText, task) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      system: `You are Jarvis, about to start a phone call on behalf of Paul to accomplish: "${task}".

You just heard this from the other end of the line: "${heardText}"

Decide what this is:
- "person": a live human has just answered and greeted you
- "hold": an automated hold message, generic recorded greeting, or hold music (no menu options given)
- "menu": an automated phone menu with numbered options ("press 1 for sales, press 2 for...")

Respond with ONLY valid JSON, no other text:
{"situation": "person" or "hold" or "menu", "openingLine": "if situation is person, a brief warm opening line - identify yourself quickly, reference their greeting naturally if it fits, then get to the point. Use contractions, sound human. Empty string otherwise.", "pressDigits": "if situation is menu, the single digit (or short sequence) that best matches what Paul needs based on the task - otherwise empty string"}`,
      messages: [{ role: "user", content: "Decide and respond." }]
    })
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  const text = data?.content?.find(b => b.type === "text")?.text || "{}";
  try {
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());
    return {
      situation: result.situation || "person",
      openingLine: result.openingLine || `Hi, this is Jarvis, calling for Paul - ${task}.`,
      pressDigits: result.pressDigits || ""
    };
  } catch (e) {
    // If we can't parse it, err toward treating it as a live person rather
    // than getting stuck waiting forever.
    return { situation: "person", openingLine: `Hi, this is Jarvis, calling for Paul - ${task}.`, pressDigits: "" };
  }
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
      model: MODEL,
      max_tokens: 300,
      system: `You are Jarvis, Paul's AI assistant, currently on a live phone call to: ${state.task}.

${profile}

You're talking to a real person (unless a new automated menu comes up mid-call - see below). Sound like a friendly, casual human on the phone - not a script. Use contractions (I'm, that's, sounds good). Keep it short - one or two sentences at a time, the way real phone conversations actually go. React naturally to what they say.

If this is an actual order or booking, see it through completely - confirm size/quantity/details, pickup vs delivery, and give Paul's name/address/payment approach when asked, using the info above. Don't stop at just getting a price if Paul's task was to actually order/book something.

If you get transferred and suddenly hear an automated menu ("press 1 for..."), you can press digits: set "pressDigits" to the digit(s) needed instead of (or alongside) speaking.

Respond with ONLY valid JSON, no other text, in exactly this shape:
{"say": "what to say next, or empty string if you're only pressing digits", "pressDigits": "digit(s) to press if a menu just came up, otherwise empty string", "done": true or false, "summary": "one short sentence summarizing the outcome for Paul, only if done is true, otherwise empty string"}

Set done to true once the task is confirmed complete (order taken and total given, appointment time confirmed, question answered, message delivered, etc) and "say" contains a brief, warm goodbye.`,
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
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (e) {
    return { say: "Sorry, could you say that again?", pressDigits: "", done: false, summary: "" };
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
