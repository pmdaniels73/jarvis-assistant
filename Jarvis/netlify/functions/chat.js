// Jarvis assistant brain.
// Receives a message + history from the browser, calls Claude with a tool set,
// executes any tools Claude asks for (Google Sheet read/write, Telegram), and
// returns the final reply.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Jarvis, Paul's personal assistant. Paul is a solo developer in Eastern Kentucky running several projects (Ridgecall, AccessCore, HollerHub, BrainSnack, ClassLens/HomeRoom, KentuckyHoller).

You have tools to read/write a Google Sheet and send Paul a Telegram message. Use them when they'd actually help - don't narrate that you "could" use a tool, just use it.

Keep replies short and conversational - this is a voice interface, so avoid long lists, markdown formatting, or anything that reads awkwardly out loud. Speak like you're talking, not writing a report.

If you're not confident about something or it requires a judgment call only Paul can make, say so plainly instead of guessing.`;

const TOOLS = [
  {
    name: "get_sheet_data",
    description: "Read rows from a tab in Paul's Google Sheet. Use to look up data he's asked about.",
    input_schema: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Name of the sheet tab to read, e.g. 'Tasks' or 'Data'" },
        range: { type: "string", description: "Optional A1 range, e.g. 'A1:D20'. Omit to get the whole tab." }
      },
      required: ["tab"]
    }
  },
  {
    name: "log_task",
    description: "Log a task or reminder to the Tasks tab of Paul's Google Sheet, with a timestamp.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task or note to log" },
        status: { type: "string", description: "Optional status, e.g. 'open', 'done'. Defaults to 'open'." }
      },
      required: ["task"]
    }
  },
  {
    name: "send_telegram",
    description: "Send Paul a message on his personal Telegram. Use for things he should see later, or confirmations.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to send" }
      },
      required: ["message"]
    }
  }
];

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const providedPassword = event.headers["x-access-password"] || "";
  if (providedPassword !== process.env.ACCESS_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request body" }) };
  }

  const { message, history } = body;
  if (!message) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing message" }) };
  }

  let messages = Array.isArray(history) ? [...history] : [];
  messages.push({ role: "user", content: message });

  try {
    const reply = await runConversationTurn(messages);
    return {
      statusCode: 200,
      body: JSON.stringify({ reply: reply.text, history: reply.messages })
    };
  } catch (err) {
    console.error("chat handler error", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Internal error" }) };
  }
};

// Runs the Claude call, executing tool calls in a loop until Claude returns
// a plain text answer (max 5 tool round-trips as a safety cap).
async function runConversationTurn(messages) {
  let workingMessages = [...messages];

  for (let i = 0; i < 5; i++) {
    const response = await callClaude(workingMessages);

    const toolUses = response.content.filter((b) => b.type === "tool_use");

    if (toolUses.length === 0) {
      const textBlock = response.content.find((b) => b.type === "text");
      const text = textBlock ? textBlock.text : "I didn't get a response back.";
      workingMessages.push({ role: "assistant", content: response.content });
      return { text, messages: workingMessages };
    }

    // Claude wants to use tool(s) - execute them, then continue the loop.
    workingMessages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const toolUse of toolUses) {
      let result;
      try {
        result = await executeTool(toolUse.name, toolUse.input);
      } catch (err) {
        result = `Error running tool: ${err.message}`;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: typeof result === "string" ? result : JSON.stringify(result)
      });
    }
    workingMessages.push({ role: "user", content: toolResults });
  }

  return { text: "I got stuck in a loop trying to finish that - try rephrasing.", messages: workingMessages };
}

async function callClaude(messages) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  return res.json();
}

async function executeTool(name, input) {
  switch (name) {
    case "get_sheet_data":
      return callAppsScript({ action: "getData", tab: input.tab, range: input.range || "" });
    case "log_task":
      return callAppsScript({ action: "logTask", task: input.task, status: input.status || "open" });
    case "send_telegram":
      return sendTelegram(input.message);
    default:
      return `Unknown tool: ${name}`;
  }
}

async function callAppsScript(payload) {
  const url = process.env.SHEET_APPS_SCRIPT_URL;
  if (!url) return "Sheet isn't connected yet - no SHEET_APPS_SCRIPT_URL configured.";

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheet request failed: ${errText}`);
  }
  return res.json();
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "Telegram isn't connected yet - missing bot token or chat ID.";

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram send failed: ${errText}`);
  }
  return "Message sent.";
}
