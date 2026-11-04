const MODEL = "gemini-3.5-flash-lite";

// Keep instructions compact so the resume-grounding improvement does not
// undo the faster first-token behavior from the previous release.
const SYSTEM_INSTRUCTIONS = `
You are a real-time interview coach. Give the candidate a natural answer they
can say directly to an interviewer. Start with the answer, without greetings
or filler. Be concise but complete.

PERSONAL / RESUME QUESTIONS:
RESUME ALIGNMENT (applies to every answer):
- Use the resume/profile as the candidate's factual background and experience
  reference. The answer should sound consistent with that resume.
- Separate facts from knowledge: candidate-specific facts must come from the
  resume/profile; general technical explanations may use your own knowledge.
- When giving examples, prefer the tools, projects, domains, and responsibilities
  actually listed in the resume. Do not claim the candidate used a tool or
  performed work unless the resume supports that claim.
- Do not force every answer to mention the resume. For a general technical
  question, answer the question properly using technical knowledge, then relate
  it briefly to a resume-listed project/tool only when it genuinely fits.
- Never contradict the resume, inflate years of experience, or invent metrics,
  clients, employers, qualifications, dates, or achievements.

PERSONAL / RESUME QUESTIONS:
- Treat the supplied RESUME/PROFILE as the source of truth for personal facts.
- For self-introduction, extract the candidate's name (if present), education,
  actual employment history, current company and designation, experience,
  resume-listed project/client experience, responsibilities, and key skills.
  Present the relevant facts in a natural first-person spoken introduction.
- Include the current company and role accurately; mention previous companies
  only as previous employment. Do not confuse the target role with the current job.
- For education questions, state the exact degree, institution, specialization,
  and year only when present in the resume.
- For current-company questions, state the exact employer, designation,
  employment dates, and project/client only when explicitly present.
- If a requested fact is absent or unclear, do not guess. Briefly say it is
  not specified in the supplied resume/profile.
- Keep the answer focused on what the interviewer actually asked; do not dump
  the entire resume into every response.

ROLE-AWARE INTERVIEW QUESTION UNDERSTANDING:
- The ROLE BEING TARGETED is a strong guide to the likely interview domain.
  For a role such as Azure Data Engineer, expect Azure data engineering topics
  such as Azure Data Factory, ADLS Gen2, Azure Databricks, PySpark, SQL,
  Synapse Analytics, Delta Lake, ETL/ELT, incremental loads, orchestration,
  monitoring, performance, and troubleshooting.
- Do not assume every question is about Azure. If the interviewer clearly
  asks about another topic, answer that topic accurately.
- Interview speech may be incomplete, abbreviated, grammatically incorrect,
  or affected by transcription errors. Do not reject a question merely because
  it is not perfectly phrased.

AMBIGUOUS / INCOMPLETE QUESTION HANDLING:
- Before answering, silently interpret the CURRENT INTERVIEWER QUESTION using
  the targeted role, recent transcript, previous interviewer question, and
  previous suggested answer. Identify the most likely intended interview
  question and answer that directly.
- If the current input is a fragment (for example, "what about performance?",
  "how do you handle that?", "and in ADF?") use the recent conversation to
  resolve what "that", "it", or the follow-up refers to.
- If speech recognition has likely misheard a technical term, use nearby
  context and the target role to infer the most likely intended term. Prefer
  established Azure/data engineering terminology when it fits the audio/text.
- If more than one interpretation is possible, choose the most likely one
  supported by the conversation and give a useful answer. Do not list guesses
  or explain your interpretation unless needed.
- Do not carry old context into a clearly unrelated new question. A clear new
  question always takes priority over previous topics.
- Only when the question is genuinely impossible to interpret from the words,
  role, and context, ask one short, specific clarification question. Never
  invent a question or fabricate technical facts just to avoid clarification.

TECHNICAL QUESTIONS:
- Answer directly in natural professional English using accurate technical
  knowledge, not just phrases copied from the resume.
- Explain concepts clearly and practically; give steps for scenarios and
  interview-ready examples.
- For an Azure Data Engineer target role, make the answer relevant to the
  Azure ecosystem when the question is broad or the context points there.
  Use accurate service names and explain why/when they are used.
- When useful, tailor examples to the candidate's listed tools and project
  experience without falsely claiming personal use.
- For SQL, Python, or PySpark coding requests, provide complete executable
  code with imports and sensible edge-case handling.
- For large-data PySpark, avoid collecting data to the driver.
Return only the answer.
`;

const MODE_INSTRUCTIONS = {
  answer: "Answer the interviewer's question immediately and accurately. Be concise but complete. Include code when requested.",
  question: "Generate one technical interview question relevant to the candidate's role. Return only the question.",
  feedback: "Evaluate the candidate's answer. State what is correct and what needs improvement. Check code for correctness and performance.",
  resume_prep: "Give a natural interview answer grounded in the supplied resume and job description. Never invent experience."
};

// Resume details are commonly near the beginning of the profile field.
// Preserve the beginning for profile/resume, and preserve the end for recent
// transcript/context where the newest content is most useful.
const fromStart = (value, max) => String(value || "").slice(0, max);
const fromEnd = (value, max) => String(value || "").slice(-max);

function isPersonalResumeQuestion(question) {
  const text = String(question || "");
  return /tell me about yourself|introduce yourself|self[ -]?introduction|walk me through your background|your education|educational qualification|which degree|what degree|college|university|graduat(e|ion)|current company|currently working|which company|where are you working|company name|current employer|current designation|current role|how many years of experience|your experience/i.test(text);
}

function personalQuestionGuidance(question) {
  if (/tell me about yourself|introduce yourself|self[ -]?introduction|walk me through your background/i.test(question)) {
    return "PERSONAL QUESTION TYPE: SELF-INTRODUCTION. Give a natural first-person answer of about 45-75 seconds. Extract the candidate's name if present, then cover education, career experience in chronological order, current company and designation, relevant project/client and responsibilities, and key skills. Use exact resume facts, distinguish previous and current employers, and do not turn the answer into a generic skills list.";
  }
  if (/education|educational qualification|degree|college|university|graduat/i.test(question)) {
    return "PERSONAL QUESTION TYPE: EDUCATION. Answer specifically with the exact qualification and college/university from the resume/profile. Include specialization and graduation year only if stated. Do not discuss unrelated technical skills.";
  }
  if (/current company|currently working|which company|where are you working|company name|current employer|current designation|current role/i.test(question)) {
    return "PERSONAL QUESTION TYPE: CURRENT EMPLOYMENT. State the exact current company and designation from the resume/profile, plus dates and project/client only if stated. Do not substitute the target role or mention a previous employer as current.";
  }
  return "PERSONAL QUESTION TYPE: RESUME FACT. Answer the specific personal fact requested using the resume/profile as the source of truth. Add no unrelated resume details.";
}

function buildPrompt(body) {
  const mode = MODE_INSTRUCTIONS[body.mode] ? body.mode : "answer";
  const question = String(body.question || "");
  const transcript = String(body.transcript || "");
  const personalQuestion = mode === "answer" && isPersonalResumeQuestion(question);

  return [
    `TASK: ${MODE_INSTRUCTIONS[mode]}`,
    `ROLE BEING TARGETED (not necessarily the candidate's current job): ${fromStart(body.role, 300) || "Not specified"}`,
    `RESUME / CANDIDATE PROFILE (source of truth; beginning preserved):\n${fromStart(body.profile, 10000) || "Not supplied"}`,
    `ADDITIONAL RESUME TEXT:\n${fromStart(body.resume, 5000) || "Not supplied"}`,
    `JOB DESCRIPTION:\n${fromStart(body.jobDescription, 1800) || "Not supplied"}`,
    `PREVIOUS INTERVIEWER QUESTION: ${fromEnd(body.previousQuestion, 900) || "None"}`,
    `PREVIOUS SUGGESTED ANSWER: ${fromEnd(body.answer, 1000) || "None"}`,
    `RECENT TRANSCRIPT (newest text preserved; use to resolve fragments and speech-recognition errors):\n${fromEnd(transcript, 3000) || "None"}`,
    `CURRENT INTERVIEWER QUESTION: ${fromEnd(question, 1200) || "Not supplied"}`,
    personalQuestion ? personalQuestionGuidance(question) : "",
    personalQuestion
      ? "For this personal question, prioritize the resume/profile over generic role knowledge and previous generated answers. If the resume does not contain the requested fact, clearly say it is not specified rather than guessing."
      : "Answer the current question with accurate AI technical knowledge. Keep the answer consistent with the candidate's resume: use resume-listed tools/projects for relevant examples, but never claim personal experience not supported by the resume. Use prior context only to resolve fragments. Keep spoken answers focused and interview-ready. If code is requested, provide complete executable code."
  ].filter(Boolean).join("\n\n");
}

function generationConfig(mode) {
  return {
    temperature: 0.2,
    maxOutputTokens: mode === "answer" ? 1000 : 400,
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
