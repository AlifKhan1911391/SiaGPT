// Chat backend: forwards the conversation to the Gemini Interactions API.
// Docs: https://ai.google.dev/gemini-api/docs/text-generation
//
// The browser sends { messages, apiKey, systemPrompt }. Each visitor supplies their own
// key from https://aistudio.google.com/apikey; GEMINI_API_KEY is an optional server fallback.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

const BREVITY_RULE = "Reply in 3 to 4 lines only. Be warm but very concise. Never exceed 4 lines.";

const reply = (statusCode, text) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ reply: text }),
});

// Steps that never carry the reply text.
const NON_REPLY = new Set(["user_input", "thought", "function_call", "function_result"]);

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

// Current API revisions return `steps`; earlier ones returned `outputs`. Accept both.
function extractText(data) {
  if (!data) return "";
  if (Array.isArray(data.steps)) {
    for (let i = data.steps.length - 1; i >= 0; i--) {
      const s = data.steps[i];
      if (!s || NON_REPLY.has(s.type)) continue;
      const t = textOf(s.content).trim();
      if (t) return t;
    }
  }
  if (Array.isArray(data.outputs)) {
    for (let i = data.outputs.length - 1; i >= 0; i--) {
      const o = data.outputs[i];
      if (o && o.type === "text" && typeof o.text === "string" && o.text.trim()) return o.text.trim();
    }
  }
  return typeof data.output_text === "string" ? data.output_text.trim() : "";
}

// Chat history -> Interactions API steps (stateless: we resend the history each turn).
// The browser's history can start with her greeting (the prompt that triggered it isn't stored),
// can be cut mid-pair when trimmed, and can hold two user turns in a row after a failed send.
// Normalise it so it always starts with the user and strictly alternates.
function toSteps(messages) {
  const steps = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content !== "string" || !m.content.trim()) continue;
    const type = m.role === "user" ? "user_input" : "model_output";
    const last = steps[steps.length - 1];
    if (last && last.type === type) last.content.push({ type: "text", text: m.content });
    else steps.push({ type, content: [{ type: "text", text: m.content }] });
  }
  if (steps.length && steps[0].type === "model_output") {
    steps.unshift({ type: "user_input", content: [{ type: "text", text: "(The user just opened the chat.)" }] });
  }
  return steps;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return reply(400, "Oops! Kono ekta problem hoise 💔 Try again?");
  }
  const { messages = [], apiKey = "", systemPrompt = "" } = payload;

  const GEMINI_API_KEY = apiKey || process.env.GEMINI_API_KEY;
  const MODEL = process.env.MODEL || "gemini-3.8-flash";

  if (!GEMINI_API_KEY) {
    return reply(400, "API key not provided 💔 Please go back and enter your Gemini key.");
  }

  const steps = toSteps(Array.isArray(messages) ? messages : []);
  if (!steps.length || steps[steps.length - 1].type !== "user_input") {
    return reply(400, "Oops! Kono ekta problem hoise 💔 Try again?");
  }

  const system_instruction = [String(systemPrompt || "").trim(), BREVITY_RULE].filter(Boolean).join("\n\n");

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        model: MODEL,
        input: steps,
        system_instruction,
        store: false, // history is resent by the browser each turn; nothing is kept on Google's side
        // Gemini 3.6+ ignores temperature/top_p/top_k, so they are not sent.
        generation_config: { thinking_level: "low", max_output_tokens: 600 },
      }),
    });

    let data = null;
    try { data = await response.json(); } catch (_) { /* non-JSON error body */ }

    if (!response.ok) {
      const msg = String((data && data.error && data.error.message) || "").toLowerCase();
      console.error("Gemini error:", response.status, msg);
      if (response.status === 401 || response.status === 403 || msg.includes("api key")) {
        return reply(401, "Invalid API key 💔 Please go back and re-enter it.");
      }
      if (response.status === 429) {
        return reply(429, "Jaan... amar API er limit mone hoy sesh 🥺 Home page e giye notun akta API Key generate kor 🥰");
      }
      return reply(502, "Oops! Kono ekta problem hoise 💔 Try again?");
    }

    return reply(200, extractText(data) || "💖");
  } catch (err) {
    console.error("Function error:", err && err.message);
    return reply(500, "Oops! Kono ekta problem hoise 💔 Try again?");
  }
};
