// Chat backend: forwards the conversation to the Gemini Interactions API.
// Docs: https://ai.google.dev/gemini-api/docs/text-generation
//
// The browser sends { messages, apiKey, systemPrompt }. Each visitor supplies their own
// key from https://aistudio.google.com/apikey; GEMINI_API_KEY is an optional server fallback.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Netlify kills a function at 30s. Everything below is budgeted to finish before that,
// so people get an answer (or a clean error) instead of a platform timeout.
const TOTAL_BUDGET_MS = 26000;
const DEFAULT_ATTEMPT_MS = 9000;
const RETRY_PAUSE_MS = 600;

// Used when the primary model is overloaded (503) or otherwise failing.
const DEFAULT_FALLBACKS = ["gemini-3.7-flash", "gemini-3.5-flash-lite"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const PRIMARY = process.env.MODEL || "gemini-3.8-flash";
  const FALLBACKS = process.env.FALLBACK_MODELS !== undefined
    ? process.env.FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean)
    : DEFAULT_FALLBACKS;
  const ATTEMPT_MS = Number(process.env.ATTEMPT_TIMEOUT_MS) || DEFAULT_ATTEMPT_MS;

  if (!GEMINI_API_KEY) {
    return reply(400, "API key not provided 💔 Please go back and enter your Gemini key.");
  }

  const steps = toSteps(Array.isArray(messages) ? messages : []);
  if (!steps.length || steps[steps.length - 1].type !== "user_input") {
    return reply(400, "Oops! Kono ekta problem hoise 💔 Try again?");
  }

  const system_instruction = [String(systemPrompt || "").trim(), BREVITY_RULE].filter(Boolean).join("\n\n");

  // One call to one model. Never throws; reports what happened.
  async function attempt(model, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          model,
          input: steps,
          system_instruction,
          store: false, // the browser resends history each turn; nothing is kept on Google's side
          // Gemini 3.6+ ignores temperature/top_p/top_k, so they are not sent.
          generation_config: { thinking_level: "low", max_output_tokens: 600 },
        }),
        signal: controller.signal,
      });
      let data = null;
      try { data = await response.json(); } catch (_) { /* non-JSON error body */ }
      const msg = String((data && data.error && data.error.message) || "");
      return {
        ok: response.ok, status: response.status, data, msg, model,
        keyError: !response.ok && (response.status === 401 || response.status === 403 || /api key/i.test(msg)),
      };
    } catch (err) {
      return { ok: false, status: 0, msg: err && err.name === "AbortError" ? "timed out" : String(err && err.message), model };
    } finally {
      clearTimeout(timer);
    }
  }

  // Primary model, one quick retry of it (503s are usually brief), then the fallbacks.
  const plan = [PRIMARY, PRIMARY, ...FALLBACKS.filter((m) => m !== PRIMARY)];
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let last = null;

  for (let i = 0; i < plan.length; i++) {
    if (i === 1) await sleep(RETRY_PAUSE_MS);
    const remaining = deadline - Date.now();
    if (remaining < 2500) break;

    const r = await attempt(plan[i], Math.min(ATTEMPT_MS, remaining - 500));
    if (r.ok) {
      if (i > 0) console.log("Answered by", r.model, "after", i, "failed attempt(s)");
      return reply(200, extractText(r.data) || "💖");
    }
    console.error("Gemini attempt failed:", r.model, r.status, r.msg.slice(0, 200));
    last = r;
    if (r.keyError) return reply(401, "Invalid API key 💔 Please go back and re-enter it.");
  }

  if (last && last.status === 429) {
    return reply(429, "Jaan... amar API er limit mone hoy sesh 🥺 Home page e giye notun akta API Key generate kor 🥰");
  }
  return reply(502, "Oops! Kono ekta problem hoise 💔 Try again?");
};
