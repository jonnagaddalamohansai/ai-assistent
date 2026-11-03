
import { useEffect, useRef, useState } from "react";
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
  const [sessionCode, setSessionCode] = useState("");
  const [sessionInput, setSessionInput] = useState("");
  const [sessionMode, setSessionMode] = useState("");
  const [syncStatus, setSyncStatus] = useState("Not connected");
  const syncSocketRef = useRef(null);

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

  // Connect this device to a shared interview session.
  useEffect(() => {
    if (!sessionCode || !sessionMode) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/live-sync`);
    syncSocketRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "join", roomId: sessionCode, role: sessionMode }));
      setSyncStatus("Connected");
      if (sessionMode === "host") {
        socket.send(JSON.stringify({ type: "update", snapshot: { transcript, question, answer } }));
      }
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "error") {
        setSyncStatus(data.message || "Session error");
        return;
      }
      if (data.type === "joined") setSyncStatus("Connected");
      if (data.type === "snapshot" && sessionMode === "viewer" && data.snapshot) {
        setTranscript(data.snapshot.transcript || "");
        setQuestion(data.snapshot.question || "");
        setAnswer(data.snapshot.answer || "");
      }
    };

    socket.onerror = () => setSyncStatus("Connection error");
    socket.onclose = () => setSyncStatus("Disconnected");

    return () => {
      socket.close();
      if (syncSocketRef.current === socket) syncSocketRef.current = null;
    };
  }, [sessionCode, sessionMode]);

  // Publish laptop updates; viewer devices only receive snapshots.
  useEffect(() => {
    const socket = syncSocketRef.current;
    if (sessionMode !== "host" || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "update", snapshot: { transcript, question, answer } }));
  }, [transcript, question, answer, sessionMode]);

  const createInterviewSession = () => {
    const bytes = new Uint8Array(4);
    window.crypto.getRandomValues(bytes);
    const code = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
    setSessionCode(code);
    setSessionMode("host");
    setSessionInput(code);
    setSyncStatus("Connecting...");
  };

  const joinInterviewSession = () => {
    const code = sessionInput.trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(code)) {
      setError("Enter the 8-character session code shown on your laptop.");
      return;
    }
    setError("");
    setSessionCode(code);
    setSessionMode("viewer");
    setSyncStatus("Connecting...");
  };

  const leaveInterviewSession = () => {
    syncSocketRef.current?.close();
    setSessionCode("");
    setSessionMode("");
    setSyncStatus("Not connected");
  };

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

  if (sessionMode === "viewer") {
    return (
      <div className="app">
        <h2>Voice Coach — Mobile View</h2>
        <p>Session: <strong>{sessionCode}</strong> · {syncStatus}</p>
        <button type="button" onClick={leaveInterviewSession}>Leave session</button>
        <h4>Interviewer transcript</h4>
        <pre className="answer">{transcript || "Waiting for interviewer speech..."}</pre>
        <h4>Latest interviewer question</h4>
        <div className="answer">{question || "No question received yet."}</div>
        <h4>AI suggested answer</h4>
        <div className="answer">{answer ? <MarkdownAnswer>{answer}</MarkdownAnswer> : "Waiting for the AI answer..."}</div>
      </div>
    );
  }

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

      <section className="session-panel" style={{ border: "1px solid #777", borderRadius: 10, padding: 12, margin: "16px 0" }}>
        <h3>Mobile live sync</h3>
        <p>Connection: {syncStatus}</p>
        {!sessionMode ? (
          <>
            <button type="button" onClick={createInterviewSession}>Start laptop session</button>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input aria-label="Interview session code" placeholder="Enter laptop session code" value={sessionInput} onChange={(e) => setSessionInput(e.target.value.toUpperCase())} maxLength={8} />
              <button type="button" onClick={joinInterviewSession}>Join on mobile</button>
            </div>
          </>
        ) : (
          <>
            <p>{sessionMode === "host" ? "Share this code with your mobile:" : "Joined interview session:"}</p>
            <strong style={{ fontSize: 24, letterSpacing: 3 }}>{sessionCode}</strong>
            <button type="button" onClick={() => navigator.clipboard?.writeText(sessionCode)}>Copy code</button>
            <button type="button" onClick={leaveInterviewSession}>Leave session</button>
            {sessionMode === "viewer" && <p>Mobile is in view-only mode. Questions and answers will appear here as your laptop receives them.</p>}
          </>
        )}
      </section>

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
