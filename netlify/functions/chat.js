exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const {
    messages = [],
    apiKey = "",
    systemPrompt = ""
  } = JSON.parse(event.body || "{}");

  const OPENROUTER_API_KEY = apiKey || process.env.OPENROUTER_API_KEY;
  const MODEL = process.env.MODEL || "google/gemini-2.0-flash-001";

  if (!OPENROUTER_API_KEY) {
    return {
      statusCode: 400,
      body: JSON.stringify({ reply: "API key not provided 💔 Please go back and enter your OpenRouter key." }),
    };
  }

  // Detect naughty mode from recent message content
  const naughtyKeywords = ["naughty", "nsfw", "seduce", "kiss", "touch", "bed", "naked", "undress", "hot", "body", "moan", "desire", "want you", "come here"];
  const recentRaw = messages.slice(-4).map(m => m.content || "").join(" ");
  const recentLower = recentRaw.toLowerCase();

  const secretPhrase = "By the way, the mangoes are very juicy 😊";
  const isNaughtyMode =
    recentRaw.includes(secretPhrase) ||
    naughtyKeywords.some(kw => recentLower.includes(kw));

  const finalMessages = isNaughtyMode
    ? messages
    : [
        ...messages.filter(m => m.role !== "system"),
        { role: "system", content: "Reply in 3 to 4 lines only. Be warm but very concise. Never exceed 4 lines." }
      ];

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.SITE_URL || "https://siagpt.netlify.app",
        "X-Title": "SiaGPT",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: finalMessages,
        max_tokens: isNaughtyMode ? 450 : 120,
        temperature: 0.6,
        top_p: 0.85,
        top_k: 30,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenRouter error:", data);
      return {
        statusCode: 502,
        body: JSON.stringify({ reply: "Jaan... amar API er limit mone hoy sesh 🥺 Home page e giye notun akta API Key generate kor 🥰" }),
      };
    }

    const reply = data.choices?.[0]?.message?.content?.trim() || "💖";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    };
  } catch (err) {
    console.error("Function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ reply: "Oops! Kono ekta problem hoise 💔 Try again?" }),
    };
  }
};
