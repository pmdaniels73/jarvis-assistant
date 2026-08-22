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

  if (!speechResult) {
    if (state.history.length === 0) {
      // Haven't said anything yet - this is genuinely waiting through
      // ringing, hold, or someone taking a moment to pick up. No "sorry,
      // I didn't catch that" here, since we haven't said anything to have
      // missed - just keep listening quietly. More patience than the
      // mid-conversation retry below, since ringing/hold can take a while.
      state.waitAttempts = (state.waitAttempts || 0) + 1;
      if (state.waitAttempts >= 10) {
        return await bailOut(event, state, "Nobody ever came on the line, even after waiting a while.");
      }
      const nextUrl = buildUrl(event, state);
      return laml(`
        <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="2" timeout="20" actionOnEmptyResult="true" language="en-US" hints="hello, hi, hey, yes, no, okay, sure, thanks, goodbye, bye, Paul, press one, press two, press three, press four, press five, press six, press seven, press eight, press nine, press zero" enhanced="true"></Gather>
      `);
    }

    // Gather timed out with no speech - ask them to repeat rather than
    // restarting the greeting. Count this as a turn toward the safety cap.
    state.emptyTurns = (state.emptyTurns || 0) + 1;
    if (state.emptyTurns >= 3) {
      return await bailOut(event, state, "I couldn't get a response after a few tries - the line may have gone quiet.");
    }
    const nextUrl = buildUrl(event, state);
    return laml(`
      <Say voice="${VOICE}">Sorry, I didn't catch that - could you repeat it?</Say>
      <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="2" timeout="20" actionOnEmptyResult="true" language="en-US" hints="hello, hi, hey, yes, no, okay, sure, thanks, goodbye, bye, Paul, press one, press two, press three, press four, press five, press six, press seven, press eight, press nine, press zero" enhanced="true"></Gather>
    `);
  }

  // Whether this is the very first thing heard on the call or a later
  // turn, route it the same way - generateReply already knows to state
  // her purpose if she hasn't yet, press digits for a menu, or stay quiet
  // through hold/garbled audio.
  return await processReply(event, state, speechResult);
};

// Deterministically extracts "option text" -> digit pairs from a menu
// transcript using plain pattern matching, not AI - this can't miscount
// the way asking a model to parse a long dense list can. Handles both
// common phrasings: "electronics press 5" and "press 5 for electronics".
// Returns null if it doesn't look like a menu (fewer than 2 matches).
function parseMenuOptions(text) {
  const WORD_TO_DIGIT = {
    zero: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9"
  };
  const digitPattern = "(zero|one|two|three|four|five|six|seven|eight|nine|\\d)";

  const results = [];

  // Pattern: "[option text] press [digit]"
  const pattern1 = new RegExp(`([a-z0-9,'\\s-]{2,60}?)\\s+press\\s+${digitPattern}\\b`, "gi");
  let m;
  while ((m = pattern1.exec(text)) !== null) {
    const option = m[1].trim().replace(/^(for|to)\s+/i, "");
    const digit = WORD_TO_DIGIT[m[2].toLowerCase()] || m[2];
    if (option) results.push({ option, digit });
  }

  // Pattern: "press [digit] for/to [option text]"
  if (results.length === 0) {
    const pattern2 = new RegExp(`press\\s+${digitPattern}\\s+(?:for|to)\\s+([a-z0-9,'\\s-]{2,60}?)(?=\\s*press|\\s*$)`, "gi");
    while ((m = pattern2.exec(text)) !== null) {
      const digit = WORD_TO_DIGIT[m[1].toLowerCase()] || m[1];
      const option = m[2].trim();
      if (option) results.push({ option, digit });
    }
  }

  return results.length >= 2 ? results : null;
}

async function processReply(event, state, heardSpeech) {
  // If this looks like an automated menu (several "press X" patterns),
  // parse the option->digit pairs deterministically with code instead of
  // asking Claude to parse a long, run-on, comma-less list itself - that
  // kind of dense list parsing is exactly where even a correct transcript
  // can get miscounted. Claude only has to match intent against an
  // already-organized list, not parse AND match at the same time.
  const parsedMenu = parseMenuOptions(heardSpeech);
  const messageForModel = parsedMenu
    ? `${heardSpeech}\n\n(Parsed menu options, so you don't have to count through the text above - use this list, it's reliable: ${parsedMenu.map(o => `"${o.option}" = press ${o.digit}`).join(", ")})`
    : heardSpeech;

  state.history.push({ role: "user", content: messageForModel });

  const reply = await generateReply(state);
  console.log("generateReply result", { heard: heardSpeech, parsedMenu, reply });
  state.history.push({ role: "assistant", content: JSON.stringify({ say: reply.say, pressDigits: reply.pressDigits || "", waiting: reply.waiting || false, done: reply.done, summary: reply.summary || "" }) });

  if (reply.waiting) {
    // Staying quiet through hold/garbled audio doesn't count as a real
    // exchange - track it separately so hold time can't eat into the
    // budget for the actual conversation, but still cap it on its own so
    // genuinely endless hold music doesn't loop forever either.
    state.waitingTurns = (state.waitingTurns || 0) + 1;
    if (state.waitingTurns >= 15) {
      return await bailOut(event, state, "I was on hold for a very long time and never reached a real conversation.");
    }
  } else {
    state.turnCount = (state.turnCount || 0) + 1;
    if (state.turnCount > 8) {
      return await bailOut(event, state, "The call went on longer than expected without wrapping up, so I stopped rather than keep going in circles.");
    }
  }

  if (reply.done) {
    await sendTelegram(`Done - ${reply.summary}`);
    await logCall(state, "done", reply.summary);
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
    <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="2" timeout="20" actionOnEmptyResult="true" language="en-US" hints="hello, hi, hey, yes, no, okay, sure, thanks, goodbye, bye, Paul, press one, press two, press three, press four, press five, press six, press seven, press eight, press nine, press zero" enhanced="true"></Gather>
  `);
}

async function bailOut(event, state, reason) {
  await sendTelegram(`Couldn't complete "${state.task}" - ${reason}`);
  await logCall(state, "bailed_out", reason);
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

In "say" specifically (what actually gets spoken aloud), write money and numbers the way you'd actually SAY them out loud, never with symbols - "one ninety-nine" or "a dollar ninety-nine" instead of "$1.99", "eight dollars" instead of "$8", "twelve fifty" instead of "$12.50". That text gets spoken directly, and symbols get read literally (like "one dot 99") instead of naturally.

In "summary" specifically (the text message Paul reads, never spoken aloud), do the opposite - use normal written numerals and symbols like "$53.41", since that's more readable as text than spelling it out in words.

CRITICAL - remember your role: YOU are the caller. YOU called THEM with a specific request. Never ask "what can I help you with," "how can I help you," or anything similar - that's their line, not yours, and it confuses whoever answers since you're the one who initiated the call. If you haven't yet told them why you're calling, your very next line must state your purpose clearly (e.g. "Hi, I'm calling to ask what time you close tonight") - don't wait for them to ask, and don't offer to help them with anything.

Never break character, no matter how confusing or garbled what you hear is. You are always Ava, speaking directly to whoever is on the line - never step outside that to talk about the task in third person ("I'm ready to help Paul make this call"), never ask meta-questions about how to conduct the call itself, never mention Paul's instructions as instructions. If something is confusing, ask THEM a natural clarifying question as Ava would, or acknowledge mild confusion in character ("sorry, I think we got cut off for a second") - never drop out of the conversation itself.

CRITICAL - stick to exactly what the task asks for, nothing more:
- If the task only asks to find out something (a price, hours, availability, whether they have something in stock), that's ALL you do. Get the answer, then wrap up - do NOT proceed to place an order or make a booking, even if it would be easy to, even if they ask "would you like to order?" If asked, politely say you're just checking on pricing/info for now and that's it.
- Only place an order or make a booking if the task explicitly says to do that (words like "order," "book," "reserve," "schedule"). In that case, see it through completely - confirm size/quantity/details, pickup vs delivery, and give Paul's name/address/payment approach when asked, using the info above. Don't stop at just getting a price if the task was to actually order/book something.
- When genuinely unsure which category a task falls into, treat it as information-only and don't take action - Paul can always call back to actually order once he has the price.

Track every specific detail in the task (bed type, dates, quantity, size, smoking preference, whatever's specified) and actively defend them through the whole call. If whoever you're talking to offers or confirms something that doesn't match what was actually asked for (e.g. the task said single bed but they mention a king, or the task said 2 large pizzas but they only confirm 1), don't just answer whatever immediate question came with it and let the mismatch slide - correct it in the same reply ("actually I need a single bed, not king - do you have that available?"). A price or answer for the wrong specifics isn't useful to Paul.

If what you just heard sounds cut off, incomplete, or like it blends into a menu/list of options (e.g. "...for $8.99, are you calling to place an order, ask about hours, or..."), you may have started talking over them mid-sentence. Don't confidently treat a fragment like that as the final, complete answer - acknowledge what you caught, and if anything is unclear or seems incomplete, ask a brief clarifying question rather than declaring done.

If you get transferred and suddenly hear an automated menu ("press 1 for..."), you can press digits: set "pressDigits" to the digit(s) needed instead of (or alongside) speaking.

The transcribed number attached to a menu option can occasionally be misheard (e.g. "5" transcribed as "4") when a long list of options is spoken quickly. To be more reliable, count the position of the option you want within the sequence as it's listed - if it's the 5th option mentioned, use 5, even if the number attached to it in the transcript looks different. Counting position in the sequence is more trustworthy than a single digit that could have been misheard.

If you end up leaving a voicemail and the system then asks you to confirm it ("if you're satisfied with your message, press 1"), press 1 to confirm/send it. But watch out for what comes right after that: if it then offers to "record another message" or similar, do NOT press to record again just because a digit option exists - a voicemail message has already been left, which is enough. Set done to true at that point and let the call end naturally, rather than pressing further options that would extend or repeat the interaction. Not every digit that's offered is one you should take - think about whether pressing it actually helps finish the task, or just continues something that's already been accomplished.

Voicemail greetings often continue for a while, with content that can sound like it's addressing you directly even though it's just the greeting talking - things like "leave a message with your callback number and email" are still part of the same uninterrupted greeting, not a real prompt for you to respond to right then. If what you're hearing sounds like instructions about what to include in a message (a callback number, an email, a name), treat that as still transitional (waiting true) the same as the rest of the greeting - don't jump in until you're confident the greeting has actually finished, ideally after something like a beep or clear pause.

If what you just heard is purely transitional - "one moment," "please hold," "transferring you now," a recorded disclaimer, or similar - there's nothing to actually respond to. Set "say" and "pressDigits" to empty strings AND set "waiting" to true, so you just listen quietly for what comes next instead of saying anything.

If what you just heard sounds garbled, nonsensical, or like disconnected random words rather than something a person or system would actually say, that's very likely hold music or background noise that got picked up and mistranscribed - not real speech meant for you. Treat this the same as a transitional message: set waiting to true and stay quiet rather than trying to form a coherent reply to noise.

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

// Logs the finished call (task, who it called, full transcript, outcome)
// to the CallLog tab in the same Reminders sheet. Fire-and-forget from the
// caller's perspective in spirit, but awaited so logging failures show up
// in the function logs rather than silently vanishing.
async function logCall(state, outcome, summaryOrReason) {
  const url = process.env.REMINDERS_APPS_SCRIPT_URL;
  if (!url) {
    console.error("REMINDERS_APPS_SCRIPT_URL not configured - call not logged");
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "logCall",
        task: state.task,
        targetNumber: state.targetNumber || "",
        transcript: formatTranscript(state.history),
        summary: summaryOrReason || "",
        outcome
      })
    });
    if (!res.ok) {
      console.error("Failed to log call", await res.text());
    }
  } catch (err) {
    console.error("Failed to log call", err);
  }
}

// Turns the raw history array (plain-text user turns, JSON-encoded
// assistant turns) into a readable transcript for the sheet.
function formatTranscript(history) {
  return (history || []).map(h => {
    if (h.role === "user") {
      return `Them: ${h.content}`;
    }
    try {
      const parsed = JSON.parse(h.content);
      if (parsed.say) return `Ava: ${parsed.say}`;
      if (parsed.pressDigits) return `Ava: [pressed ${parsed.pressDigits}]`;
      if (parsed.waiting) return `Ava: [listening quietly]`;
      return null;
    } catch (e) {
      return `Ava: ${h.content}`;
    }
  }).filter(Boolean).join("\n");
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
