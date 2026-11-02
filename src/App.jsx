
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

import { useSpeech } from "./useSpeech";
import { callApi } from "./api";

const FILLERS = /\b(um|uh|like|you know|basically|actually)\b/gi;

// ChatGPT-style code block with syntax highlighting and copy button
function CodeBlock({ className, children, ...props }) {
  const [copied, setCopied] = useState(false);

  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1].toLowerCase() : "text";
  const code = String(children).replace(/\n$/, "");

  // Normal inline code
  if (!match) {
    return (
      <code className="inline-code" {...props}>
        {children}
      </code>
    );
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);

      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <div className="code-header">
        <span className="code-language">{language}</span>

        <button
          className="copy-code-button"
          onClick={copyCode}
          type="button"
        >
          {copied ? "✓ Copied" : "Copy code"}
        </button>
      </div>

      <SyntaxHighlighter
        language={language === "pyspark" ? "python" : language}
        style={oneDark}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: "18px",
          background: "#171717",
          fontSize: "14px",
          lineHeight: "1.6",
          borderRadius: "0 0 8px 8px",
        }}
        wrapLongLines={true}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

// Reusable Markdown renderer
function MarkdownAnswer({ children }) {
  return (
    <ReactMarkdown
      components={{
        pre: ({ children }) => <>{children}</>,
        code: CodeBlock,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export default function App() {
  const [tab, setTab] = useState("coach");

  const [profile, setProfile] = useState(
    localStorage.getItem("profile") || ""
  );

  const [role, setRole] = useState(
    localStorage.getItem("role") || ""
  );

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [transcript, setTranscript] = useState("");

  const [mockQ, setMockQ] = useState("");
  const [myAnswer, setMyAnswer] = useState("");
  const [feedback, setFeedback] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn) => {
    setError("");
    setLoading(true);

    try {
      await fn();
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  // Generate an answer from the interviewer question
  const ask = async (q) => {
    const cleanQuestion = String(q || "").trim();

    if (!cleanQuestion) return;

    setQuestion(cleanQuestion);
    setAnswer("");

    await run(async () => {
      const result = await callApi({
        mode: "answer",
        question: cleanQuestion,
        profile,
        role,
      });

      setAnswer(result);
    });
  };

  // Automatically process the interviewer's final transcript
  const handleInterviewerText = (text) => {
    const cleanText = String(text || "").trim();

    if (!cleanText) return;

    setTranscript((previous) =>
      (previous + "\n" + cleanText).trim()
    );

    if (tab === "coach") {
      ask(cleanText);
    }
  };

  const {
    start,
    stop,
    listening,
    interim,
    error: audioError,
  } = useSpeech(handleInterviewerText);

  // Generate mock interview question
  const newMockQuestion = () =>
    run(async () => {
      const q = await callApi({
        mode: "question",
        profile,
        role,
      });

      setMockQ(q);
      setMyAnswer("");
      setFeedback("");

      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(
        new SpeechSynthesisUtterance(q)
      );
    });

  // Evaluate mock interview answer
  const getFeedback = () =>
    myAnswer.trim() &&
    run(async () => {
      const result = await callApi({
        mode: "feedback",
        question: mockQ,
        answer: myAnswer,
        profile,
        role,
      });

      setFeedback(result);
    });

  // Save profile and target role
  const save = (key, setter) => (value) => {
    setter(value);
    localStorage.setItem(key, value);
  };

  const fillerCount = (myAnswer.match(FILLERS) || []).length;

  return (
    <div className="app">
      <h2>Voice Coach</h2>

      <textarea
        rows={3}
        placeholder="Your background: skills, experience, projects"
        value={profile}
        onChange={(e) =>
          save("profile", setProfile)(e.target.value)
        }
      />

      <input
        placeholder="Target role, e.g. Azure Data Engineer"
        value={role}
        onChange={(e) =>
          save("role", setRole)(e.target.value)
        }
      />

      <div className="tabs">
        <button
          className={tab === "coach" ? "on" : ""}
          onClick={() => setTab("coach")}
        >
          Answer Coach
        </button>

        <button
          className={tab === "mock" ? "on" : ""}
          onClick={() => setTab("mock")}
        >
          Mock Interview
        </button>
      </div>

      {tab === "coach" && (
        <>
          <button
            className="mic"
            onClick={listening ? stop : start}
          >
            {listening
              ? "Stop interviewer audio"
              : "Start real-time listening"}
          </button>

          <p>
            Status: {listening ? "Connected" : "Not connected"}
          </p>

          {interim && (
            <p className="interim">
              Live transcript: {interim}
            </p>
          )}

          {(audioError || error) && (
            <p className="error">{audioError || error}</p>
          )}

          <h4>Interviewer transcript</h4>

          <pre className="answer">
            {transcript || "Waiting for interviewer speech..."}
          </pre>

          <h4>Latest interviewer question</h4>

          <p>{question || "No question received yet."}</p>

          <h4>AI suggested answer</h4>

          <div className="answer">
            {loading ? (
              "Generating your answer..."
            ) : answer ? (
              <MarkdownAnswer>{answer}</MarkdownAnswer>
            ) : (
              "Your answer will appear here automatically."
            )}
          </div>

          <input
            placeholder="Or type a question and press Enter"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                ask(e.currentTarget.value);
                e.currentTarget.value = "";
              }
            }}
          />

          <button
            onClick={() => {
              setTranscript("");
              setQuestion("");
              setAnswer("");
              setError("");
            }}
          >
            Clear conversation
          </button>
        </>
      )}

      {tab === "mock" && (
        <>
          <button onClick={newMockQuestion}>
            New question
          </button>

          <h4>Interviewer asks</h4>
          <p>{mockQ}</p>

          <h4>Your answer (speak it or type it)</h4>

          <textarea
            rows={5}
            value={myAnswer}
            onChange={(e) => setMyAnswer(e.target.value)}
          />

          <p>Filler words: {fillerCount}</p>

          <button onClick={getFeedback}>
            Get feedback
          </button>

          <h4>Feedback</h4>

          <div className="answer">
            {feedback ? (
              <MarkdownAnswer>{feedback}</MarkdownAnswer>
            ) : (
              "Your feedback will appear here."
            )}
          </div>
        </>
      )}

      {loading && <p>Thinking...</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
