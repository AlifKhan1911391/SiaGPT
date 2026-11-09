// Chat backend: forwards the conversation to the Gemini Interactions API.
// Docs: https://ai.google.dev/gemini-api/docs/text-generation
//
// The browser sends { messages, apiKey, systemPrompt }. Each visitor supplies their own
// key from https://aistudio.google.com/apikey; GEMINI_API_KEY is an optional server fallback.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Netlify kills a function at 30s, so everything is budgeted to finish before that.
// Calls are raced, not queued: a second call starts the moment the first one fails,
// or after HEDGE_MS if it is merely slow, and the first good answer wins.
const TOTAL_BUDGET_MS = 22000; // give up after this long overall
const ATTEMPT_MS = 12000;      // cut off any single call after this long
const HEDGE_MS = 4000;         // start a second call if there is no answer by then

// Optional extra models to race (comma-separated FALLBACK_MODELS env var). None by default.
const DEFAULT_FALLBACKS = [];

const DEFAULT_MODEL = "gemini-3.5-flash-lite"; // override with the MODEL env var, e.g. gemini-3.5-flash

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
  const PRIMARY = process.env.MODEL || DEFAULT_MODEL;
  const FALLBACKS = process.env.FALLBACK_MODELS !== undefined
    ? process.env.FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean)
    : DEFAULT_FALLBACKS;
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const TOTAL_MS = num(process.env.TOTAL_BUDGET_MS, TOTAL_BUDGET_MS);
  const PER_CALL_MS = num(process.env.ATTEMPT_TIMEOUT_MS, ATTEMPT_MS);
  const HEDGE = num(process.env.HEDGE_MS, HEDGE_MS);

  if (!GEMINI_API_KEY) {
    return reply(400, "API key not provided 💔 Please go back and enter your Gemini key.");
  }

  const steps = toSteps(Array.isArray(messages) ? messages : []);
  if (!steps.length || steps[steps.length - 1].type !== "user_input") {
    return reply(400, "Oops! Kono ekta problem hoise 💔 Try again?");
  }

  const system_instruction = [String(systemPrompt || "").trim(), BREVITY_RULE].filter(Boolean).join("\n\n");

  // One call to one model. Never throws; reports what happened.
  async function attempt(model, controller) {
    const timer = setTimeout(() => controller.abort(), PER_CALL_MS);
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
      return { ok: false, status: 0, msg: err && err.name === "AbortError" ? "timed out or cancelled" : String(err && err.message), model };
    } finally {
      clearTimeout(timer);
    }
  }

  // Race the calls: the model is tried twice (second call = retry/hedge), then any extra models.
  // First success wins; a bad key stops everything.
  const plan = [PRIMARY, PRIMARY, ...FALLBACKS.filter((m) => m !== PRIMARY)];
  const started = Date.now();
  const controllers = [];
  let winner = null;
  let keyFailed = false;
  let last = null;

  await new Promise((resolve) => {
    let launched = 0, finished = 0, settled = false, hedgeTimer = null;

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadlineTimer);
      controllers.forEach((c) => c.abort()); // stop the losers
      resolve();
    };
    const deadlineTimer = setTimeout(settle, TOTAL_MS);

    const launchNext = () => {
      if (settled || launched >= plan.length) return;
      const model = plan[launched++];
      const controller = new AbortController();
      controllers.push(controller);

      attempt(model, controller).then((r) => {
        finished++;
        if (settled) return;
        if (r.ok) { winner = r; return settle(); }
        console.error("Gemini attempt failed:", r.model, r.status, r.msg.slice(0, 200));
        last = r;
        if (r.keyError) { keyFailed = true; return settle(); }
        if (launched < plan.length) launchNext();      // failed: start the next call now
        else if (finished >= plan.length) settle();    // nobody left
      });

      clearTimeout(hedgeTimer);
      if (launched < plan.length) hedgeTimer = setTimeout(launchNext, HEDGE); // slow: start a second call
    };

    launchNext();
  });

  if (winner) {
    console.log("Answered by", winner.model, "in", Date.now() - started, "ms");
    return reply(200, extractText(winner.data) || "💖");
  }
  if (keyFailed) return reply(401, "Invalid API key 💔 Please go back and re-enter it.");
  if (last && last.status === 429) {
    return reply(429, "Jaan... amar API er limit mone hoy sesh 🥺 Home page e giye notun akta API Key generate kor 🥰");
  }
  return reply(502, "Oops! Kono ekta problem hoise 💔 Try again?");
};
