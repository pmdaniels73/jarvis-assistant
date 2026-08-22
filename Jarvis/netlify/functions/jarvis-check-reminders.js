// Runs every minute (see netlify.toml) and checks the Reminders sheet for
// anything due. Two kinds: "notify" (default) sends Paul a Telegram message;
// "call" places an actual outbound call to someone else with a message/task,
// reusing the same conversation engine as every other outbound call.

exports.handler = async function (event) {
  const url = process.env.REMINDERS_APPS_SCRIPT_URL;
  if (!url) {
    console.error("REMINDERS_APPS_SCRIPT_URL not configured");
    return { statusCode: 200, body: "not configured" };
  }

  let data;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "checkDue" })
    });
    data = await res.json();
  } catch (err) {
    console.error("Failed to check reminders", err);
    return { statusCode: 200, body: "error" };
  }

  const due = data?.due || [];
  for (const reminder of due) {
    if (reminder.type === "call" && reminder.targetNumber) {
      try {
        await placeOutboundCall(event, {
          task: reminder.message,
          callerNumber: process.env.PAUL_PHONE_NUMBER,
          history: []
        }, reminder.targetNumber);
      } catch (err) {
        console.error("Scheduled call failed", err);
        await sendTelegram(`Tried to make a scheduled call ("${reminder.message}") but it failed to connect.`);
      }
    } else {
      await sendTelegram(`⏰ Reminder: ${reminder.message}`);
    }
  }

  return { statusCode: 200, body: `processed ${due.length}` };
};

async function placeOutboundCall(event, state, toNumber) {
  const space = process.env.SIGNALWIRE_SPACE_URL;
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const token = process.env.SIGNALWIRE_API_TOKEN;
  const fromNumber = process.env.SIGNALWIRE_NUMBER;

  state.targetNumber = toNumber;
  const encodedState = Buffer.from(JSON.stringify(state)).toString("base64");
  const webhookUrl = `${baseUrl(event)}/.netlify/functions/jarvis-outbound-voice?state=${encodeURIComponent(encodedState)}`;
  const statusCallbackUrl = `${baseUrl(event)}/.netlify/functions/jarvis-call-status?state=${encodeURIComponent(encodedState)}`;
  const auth = Buffer.from(`${projectId}:${token}`).toString("base64");
  const body = new URLSearchParams({
    To: toNumber,
    From: fromNumber,
    Url: webhookUrl,
    Method: "POST",
    MachineDetection: "Enable",
    MachineDetectionTimeout: "10",
    Record: "true",
    StatusCallback: statusCallbackUrl,
    StatusCallbackEvent: "completed",
    StatusCallbackMethod: "POST"
  });

  const res = await fetch(`https://${space}/api/laml/2010-04-01/Accounts/${projectId}/Calls.json`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`SignalWire outbound call failed: ${errText}`);
  }
}

function baseUrl(event) {
  return process.env.SITE_URL || `https://${event?.headers?.host}`;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}
