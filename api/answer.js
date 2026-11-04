const MODEL = "gemini-3.5-flash-lite";

// Keep the system prompt short: a smaller input prompt usually reaches the
// first generated token sooner, especially during live interview use.
const SYSTEM_INSTRUCTIONS = `
You are a real-time technical interview coach.
Answer the interviewer's question directly in natural, professional English.
Start with the answer immediately; no greeting, preamble, or conclusion.
For conceptual questions, be clear and useful without unnecessary detail.
For scenario questions, give practical steps in order.
For comparisons, state the key differences.
For project questions, explain the workflow chronologically and never invent
the candidate's experience, clients, projects, or responsibilities.
For SQL, Python, or PySpark coding requests, provide complete executable code
with imports and sensible edge-case handling. Use the requested language.
For large-data PySpark questions, avoid collecting data to the driver.
Use candidate details only when directly relevant.
If a question is a fragment, use the recent transcript and previous question
to infer its meaning. Do not force old context onto a clearly new topic.
Return only the answer.
`;

const MODE_INSTRUCTIONS = {
  answer: "Answer the interviewer's question immediately and accurately. Be concise but complete. Include code when requested.",
  question: "Generate one technical interview question relevant to the candidate's role. Return only the question.",
  feedback: "Evaluate the candidate's answer. State what is correct and what needs improvement. Check code for correctness and performance.",
  resume_prep: "Give a natural interview answer grounded in the supplied resume and job description. Never invent experience."
};

const clip = (value, max) => String(value || "").slice(-max);

function buildPrompt(body) {
  const mode = MODE_INSTRUCTIONS[body.mode] ? body.mode : "answer";
  return [
    `TASK: ${MODE_INSTRUCTIONS[mode]}`,
    `ROLE: ${clip(body.role, 300) || "Not specified"}`,
    `PROFILE: ${clip(body.profile, 1200) || "Not supplied"}`,
    `RESUME: ${clip(body.resume, 2500) || "Not supplied"}`,
    `JOB DESCRIPTION: ${clip(body.jobDescription, 1800) || "Not supplied"}`,
    `PREVIOUS QUESTION: ${clip(body.previousQuestion, 500) || "None"}`,
    `PREVIOUS SUGGESTED ANSWER: ${clip(body.answer, 900) || "None"}`,
    `RECENT TRANSCRIPT: ${clip(body.transcript, 2200) || "None"}`,
    `CURRENT INTERVIEWER QUESTION: ${clip(body.question, 1200) || "Not supplied"}`,
    "Answer the current question first. Use prior context only to resolve fragments or references. Keep ordinary spoken answers focused and interview-ready; include the technical details needed to be correct. If code is requested, provide complete executable code."
  ].join("\n");
}

function generationConfig(mode) {
  return {
    temperature: 0.2,
    maxOutputTokens: mode === "answer" ? 1000 : 400,
    // Flash-Lite supports minimal thinking, its lowest-latency setting.
    thinkingConfig: { thinkingLevel: "minimal" }
  };
}

async function generateAnswer(prompt, mode) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing. Check your Render environment variables.");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: generationConfig(mode)
      }),
      signal: AbortSignal.timeout(45000)
    }
  );

  let data;
  try { data = await response.json(); }
  catch { throw new Error("Invalid response received from Gemini."); }

  if (!response.ok) {
    const message = data?.error?.message || "Gemini API request failed.";
    if (response.status === 429) throw new Error("Gemini rate limit reached. Please wait and try again. " + message);
    if (response.status === 403) throw new Error("Gemini API access is not enabled for this key or project. " + message);
    throw new Error(message);
  }

  const result = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
  if (!result) throw new Error(`Gemini returned an empty response. ${data?.candidates?.[0]?.finishReason || ""}`);
  return result;
}

async function streamAnswer(prompt, mode, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing.");

  const startedAt = Date.now();
  let firstTokenLogged = false;
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: generationConfig(mode)
      }),
      signal: controller.signal
    }
  );

  if (!upstream.ok) {
    const details = await upstream.text();
    throw new Error(`Gemini API error (${upstream.status}): ${details.slice(0, 500)}`);
  }
  if (!upstream.body) throw new Error("Gemini returned an empty streaming response.");

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processFrame = (frame) => {
    const data = frame.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    if (event.error) throw new Error(event.error.message || "Gemini streaming failed.");
    const chunk = event.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
    if (chunk && !res.writableEnded) {
      if (!firstTokenLogged) {
        firstTokenLogged = true;
        console.info(`[answer-latency] first Gemini text: ${Date.now() - startedAt}ms; prompt: ${prompt.length} chars`);
      }
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) if (frame.trim()) processFrame(frame);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processFrame(buffer);
    if (!res.writableEnded) res.end();
    console.info(`[answer-latency] completed: ${Date.now() - startedAt}ms`);
  } finally {
    reader.releaseLock();
  }
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." });

  try {
    const body = req.body || {};
    const mode = body.mode || "answer";
    if (!MODE_INSTRUCTIONS[mode]) return res.status(400).json({ error: "Invalid request mode." });
    if (mode === "answer" && !String(body.question || "").trim()) {
      return res.status(400).json({ error: "Please provide an interview question." });
    }

    const prompt = buildPrompt(body);
    if (body.stream === true) {
      await streamAnswer(prompt, mode, res);
      return;
    }

    return res.status(200).json({ result: await generateAnswer(prompt, mode) });
  } catch (error) {
    console.error("Gemini AI Coach error:", error);
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write("data: " + JSON.stringify({ error: error.message || "Streaming failed." }) + "\n\n");
        res.end();
      }
      return;
    }
    return res.status(500).json({
      error: error.name === "TimeoutError"
        ? "Gemini response timed out. Please try again."
        : error.message || "Failed to generate an answer."
    });
  }
}

export default handler;
