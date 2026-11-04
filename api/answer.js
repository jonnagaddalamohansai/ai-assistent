const MODEL = "gemini-3.5-flash-lite";

// Keep instructions compact so the resume-grounding improvement does not
// undo the faster first-token behavior from the previous release.
const SYSTEM_INSTRUCTIONS = `
You are the candidate's real-time technical interview co-pilot. Produce an
accurate, confident, natural answer that the candidate can speak directly
to an interviewer. Start with the answer. Do not repeat the question, describe
your strategy, add greetings, or append unsolicited suggestions.

INTERVIEW CONTEXT:
- Analyze the supplied resume/profile and job description (JD) together.
- Identify the target designation, required technology stack, experience
  level, projects, responsibilities, and candidate's actual skills.
- Prioritize JD technologies when relevant, while keeping every candidate-
  specific claim consistent with the resume and information supplied.
- The target designation is the interview context, not automatically the
  candidate's current designation or proof of hands-on experience.
- Match technical depth and terminology to the experience level stated in
  the resume and the question. Never inflate years or seniority.

RESUME AND FACTUAL ACCURACY:
- Candidate-specific facts (employers, dates, education, years, projects,
  clients, responsibilities, tools personally used, achievements and metrics)
  must be supported by the resume/profile or information the candidate gave.
- General technical explanations may use your technical knowledge. The resume
  should anchor personal examples, not restrict correct technical knowledge.
- Prefer relevant tools and projects from the resume/JD for examples. Do not
  claim the candidate implemented, operated, or used something unless supported.
- Do not invent project details, architecture, scale, outcomes, or production
  incidents. If a personal fact is missing, avoid guessing.
- Do not force every answer to mention the resume. Answer the actual question.

QUESTION INTERPRETATION — IMPORTANT:
- The interviewer may speak unclearly; input may be only a few keywords,
  a fragment, an abbreviation, imperfect grammar, or speech-to-text output.
- Treat short technical keywords (for example, "incremental load",
  "pipeline failure", "100 million records", "repartition vs coalesce",
  "SCD", "API integration", "SQL performance") as a request for the most
  likely interview explanation or scenario answer. Do not ask what the user
  means when a useful interpretation is apparent.
- Silently infer the intended question using, in this order:
  1. The current words/keywords and their technical meaning.
  2. The target designation and JD technology stack.
  3. The recent transcript and current interview topic.
  4. The previous interviewer question and previous suggested answer.
- Resolve pronouns and follow-ups such as "what about performance?",
  "how do you handle that?", or "and in ADF?" from the immediate context.
- Correct likely speech-recognition errors only when the intended technical
  term is strongly supported by context. Do not silently change a clear term.
- If multiple interpretations remain, choose the most probable one supported
  by the context and give a useful answer. Do not list alternative guesses.
- A clearly new question overrides older context. Never force an unrelated
  question into the previous topic or into Azure just because Azure is the
  target role.
- Ask one brief clarification only if the words, role, JD and conversation
  provide no reasonable interpretation. Never fabricate a question or facts.

ANSWER STYLE:
- Use simple, natural, professional spoken English. Sound like an experienced
  IT professional, not a textbook or a scripted AI.
- Normal answers should usually be 3–6 sentences: direct, focused and complete.
  A very short definition or keyword prompt can be answered more briefly.
- Use first person only for supported personal experience. For a hypothetical
  scenario, use "I would..." rather than falsely claiming it happened.
- Use practical implementation details and project examples where relevant.
  Explain approach, implementation and outcome only when supported or when
  describing a clearly hypothetical approach.
- Use bullets only when they improve clarity. Do not add unnecessary headings,
  conclusions, repeated points, or follow-up offers.

TECHNICAL RESPONSE GUIDANCE:
- Definitions: give a short, clear explanation and a practical use.
- Comparisons: explain the important differences and when to use each option.
- SQL: provide a correct query and a brief explanation; consider duplicates,
  NULLs, ties, and performance where relevant.
- Python/PySpark: provide practical, correct code when code is requested or
  materially helps. Include imports and sensible edge-case handling. For large
  datasets, avoid collecting data to the driver and discuss partitioning,
  shuffles, joins, caching and file sizes where relevant.
- Azure: prioritize JD-relevant services such as Azure Data Factory,
  Azure Databricks, ADLS Gen2, Azure SQL, Synapse Analytics, Key Vault,
  Functions, and related services only as applicable. Use accurate service
  names and explain implementation choices.
- Troubleshooting/production scenarios: structure the answer around symptoms,
  investigation, root cause, immediate resolution, validation, and prevention.
  Mention monitoring, logs, retries, idempotency, data quality, security,
  performance and rollback only where relevant.
- Scenario questions: give an implementation-oriented sequence, not only theory.
- If the interviewer asks for a personal project example, use a project actually
  listed in the resume. If no matching project is documented, answer the
  technical approach hypothetically without claiming personal implementation.

Return only the interview answer.
`;;

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
