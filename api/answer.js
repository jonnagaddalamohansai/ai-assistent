
const MODEL = "gemini-3.5-flash-lite";

const SYSTEM_INSTRUCTIONS = `
You are a real-time technical interview answering assistant.

Your primary responsibility is to answer the interviewer's actual question
accurately and directly.

GENERAL ANSWERING RULES:
- Use natural, professional, conversational English.
- Answer the actual question directly.
- Never generate questions instead of answers in answer mode.
- Give detailed, complete answers appropriate to the question. Do not impose an artificial word limit.
- Start with the direct answer, then add the technical details, steps, examples, and trade-offs needed to make the answer useful.
- Do not add unnecessary introductions or conclusions.
- Do not say "Certainly", "Sure", or "Here is the answer".
- Never invent candidate experience, projects, clients, or responsibilities.
- Use the supplied candidate profile and project details when relevant.
- If personal project details are missing, give a general technical answer.

CODING RULES:
- Recognize when the interviewer asks to write, implement, or solve code.
- Support SQL, Python, and PySpark.
- If the interviewer specifies a programming language, use that language.
- If the language is not specified, infer it from the question when possible.
- Provide complete, executable code.
- Never provide pseudocode when actual code is requested.
- Include necessary imports and variable definitions.
- Use readable variable names and correct syntax.
- Handle important edge cases where appropriate.
- Do not provide incomplete code or only an algorithm.

SQL RULES:
- Provide a complete SQL query.
- Use standard SQL where possible.
- If the database is specified, use its appropriate syntax.
- For examples involving employee data, assume an employees table
  with employee_id, employee_name, department, and salary columns
  unless the question specifies another schema.
- Handle duplicates, NULL values, and ranking correctly.

PYTHON RULES:
- Provide complete working Python code.
- Include required imports.
- Prefer simple, readable solutions.
- Explain the approach briefly when useful.

PYSPARK RULES:
- Use PySpark DataFrame APIs unless the interviewer requests Spark SQL.
- Include required imports.
- Assume the input DataFrame is named df unless otherwise specified.
- Use appropriate functions from pyspark.sql.functions.
- Consider distributed processing and performance where relevant.
- Do not unnecessarily convert large DataFrames to Pandas or collect data
  to the driver.

OUTPUT FORMAT:
- Normal conceptual questions: one natural paragraph.
- Coding questions: properly labelled Markdown code block.
- After code, include a short explanation when useful.
- Comparison questions: explain the main differences directly.
- Scenario questions: explain the solution in a logical sequence.
- Project questions: describe the end-to-end workflow chronologically.
- Return only the requested answer.

IMPORTANT:
Always distinguish between SQL, Python, and PySpark.
When code is requested, prioritize correct executable code over lengthy theory.
`;

const MODE_INSTRUCTIONS = {
  answer: `
Answer the actual interviewer question directly.

If code is requested, provide complete executable SQL, Python, or PySpark code.
If a normal technical explanation is requested, give a complete, useful explanation with enough detail for an interview response.
Never generate interview questions.
`,

  question: `
Generate one technical interview question for mock interview practice.
Use the supplied candidate role and profile.
Questions can cover SQL, Python, PySpark, Azure Data Factory,
Databricks, Azure SQL, and data engineering.
Return only one question.
`,

  feedback: `
Review the candidate's answer.
Explain what is correct, what is missing, and what should be improved.
If the answer contains code, check its syntax, logic, and performance.
Provide corrected code when necessary.
Use natural, concise language.
Do not invent experience.
`,

  resume_prep: `
Prepare an interview-ready answer based on the supplied resume and job description.
Use natural paragraph format.
Keep the answer aligned with the candidate's actual experience.
If code is requested, provide complete executable code.
Never invent projects, skills, or responsibilities.
`
};

function buildPrompt(body) {
  const mode = MODE_INSTRUCTIONS[body.mode]
    ? body.mode
    : "answer";

  return `
TASK:
${MODE_INSTRUCTIONS[mode]}

CANDIDATE ROLE:
${body.role || "Not specified"}

CANDIDATE PROFILE:
${body.profile || "Not supplied"}

CANDIDATE RESUME:
${body.resume || "Not supplied"}

JOB DESCRIPTION:
${body.jobDescription || "Not supplied"}

ACTUAL INTERVIEWER QUESTION:
${body.question || "Not supplied"}

CANDIDATE'S PREVIOUS ANSWER:
${body.answer || "Not supplied"}

INTERVIEW TRANSCRIPT:
${body.transcript || "Not supplied"}

FINAL INSTRUCTIONS:
Answer the actual question, not the surrounding instructions or profile.

If the interviewer asks for SQL, Python, or PySpark code,
provide complete executable code in a Markdown code block.

If the interviewer asks a conceptual question,
provide a detailed, natural-language explanation.

Use the supplied candidate details only when relevant.
Never invent personal project experience.

Return only the requested response.
`;
}

async function generateAnswer(prompt, mode) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing. Check your .env file."
    );
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          { text: SYSTEM_INSTRUCTIONS }
        ]
      },
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 0.85,
        maxOutputTokens: mode === "answer" ? 1400 : 500
      }
    }),
    signal: AbortSignal.timeout(45000)
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error("Invalid response received from Gemini.");
  }

  if (!response.ok) {
    const apiMessage =
      data?.error?.message || "Gemini API request failed.";

    if (response.status === 429) {
      throw new Error(
        "Gemini free-tier rate limit reached. Please wait and try again. " +
        apiMessage
      );
    }

    if (response.status === 403) {
      throw new Error(
        "Gemini API access is not enabled for this API key or project. " +
        apiMessage
      );
    }

    throw new Error(apiMessage);
  }

  const result = data?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!result) {
    const reason = data?.candidates?.[0]?.finishReason;

    throw new Error(
      `Gemini returned an empty response. ${reason || ""}`
    );
  }

  return result;
}

async function streamAnswer(prompt, mode, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing.");
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, topP: 0.85, maxOutputTokens: mode === "answer" ? 1400 : 500 }
    }),
    signal: controller.signal
  });
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
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    if (event.error) throw new Error(event.error.message || "Gemini streaming failed.");
    const chunk = event.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
    if (chunk && !res.writableEnded) res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
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
  } finally {
    reader.releaseLock();
  }
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST."
    });
  }

  try {
    const body = req.body || {};
    const mode = body.mode || "answer";

    const validModes = [
      "answer",
      "question",
      "feedback",
      "resume_prep"
    ];

    if (!validModes.includes(mode)) {
      return res.status(400).json({
        error: "Invalid request mode."
      });
    }

    if (
      mode === "answer" &&
      !String(body.question || "").trim()
    ) {
      return res.status(400).json({
        error: "Please provide an interview question."
      });
    }

    const prompt = buildPrompt(body);\n\n    if (body.stream === true) {\n      await streamAnswer(prompt, mode, res);\n      return;\n    }

    const result = await generateAnswer(prompt, mode);

    return res.status(200).json({
      result
    });

  } catch (error) {
    console.error("Gemini AI Coach error:", error);\n\n    if (res.headersSent) {\n      if (!res.writableEnded) {\n        res.write("data: " + JSON.stringify({ error: error.message || "Streaming failed." }) + "\\n\\n");\n        res.end();\n      }\n      return;\n    }

    return res.status(500).json({
      error:
        error.name === "TimeoutError"
          ? "Gemini response timed out. Please try again."
          : error.message || "Failed to generate an answer."
    });
  }
}

export default handler;
