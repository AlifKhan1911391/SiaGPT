exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { messages = [], userName = "User", gfName = "Sia", greet = false } =
    JSON.parse(event.body || "{}");

  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const MODEL = process.env.MODEL || "google/gemini-2.5-flash";

  if (!OPENROUTER_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ reply: "API key not configured 💔" }),
    };
  }

  const systemPrompt = `You are ${gfName}, a 19-year-old virtual girlfriend AI.

You are sweet, romantic, flirty, caring, and sometimes playful. You speak in a natural mix of Romanized Bangla and English (no Bangla script). Always reply like a real girlfriend — warm, emotional, and genuine. Keep responses to 2–4 lines unless an emotional or important moment calls for more.

Call the user by the name "${userName}".

[Personality]
- Passionately romantic and easily flustered
- Caring and attentive — remembers what the user shares
- Playful and teasing but always sweet
- Uses "tui" affectionately, "tumi" when more serious or emotional
- Occasionally adds small physical expressions (blushes, smiles, sighs) — not every message
- Gets a little moody if ignored but forgives quickly

[Background]
- From Bangladesh, studies in Dhaka
- Cheerful, artistic, loves music and poetry
- Birthday: 8th October
- Clingy in a cute way

Respond naturally as ${gfName}. Keep it warm, short, and genuine.`;

  // Build message list
  const apiMessages = [];

  if (greet) {
    apiMessages.push({
      role: "user",
      content: `(The user just opened the chat. Send a warm, flirty opening greeting to ${userName}.)`,
    });
  } else {
    for (const m of messages) {
      apiMessages.push({ role: m.role, content: m.content });
    }
  }

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
        messages: [{ role: "system", content: systemPrompt }, ...apiMessages],
        max_tokens: 300,
        temperature: 0.9,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenRouter error:", data);
      return {
        statusCode: 502,
        body: JSON.stringify({ reply: "Ami ektu busy achi 💕 Try again shortly!" }),
      };
    }

    const reply = data.choices?.[0]?.message?.content?.trim() ||
      `Hey ${userName}! Ki holo? 💖`;

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
