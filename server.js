
import express from "express";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./api/answer.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "16mb" }));

// API endpoint
app.all("/api/answer", (req, res) => handler(req, res));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// Serve React frontend
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const syncWss = new WebSocketServer({ noServer: true });
const interviewRooms = new Map();

// Live audio WebSocket
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, "http://localhost").pathname;

  if (pathname === "/live-audio") {
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
    return;
  }

  if (pathname === "/live-sync") {
    syncWss.handleUpgrade(request, socket, head, (client) => {
      syncWss.emit("connection", client, request);
    });
    return;
  }

  socket.destroy();
});

wss.on("connection", (client) => {
  if (!process.env.GEMINI_API_KEY) {
    client.close(1011, "GEMINI_API_KEY is missing");
    return;
  }

  const model = "gemini-3.5-transcribe-live";

  const upstream = new WebSocket(
    "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
      `?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`
  );

  let ready = false;

  upstream.on("open", () => {
    upstream.send(JSON.stringify({
      setup: {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ["TEXT"],
        },
        inputAudioTranscription: {
          mode: "SMART",
          languageCodes: [],
        },
      },
    }));
  });

  upstream.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.setupComplete) {
      ready = true;

      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "ready" }));
      }

      return;
    }

    const content = message.serverContent;

    if (content?.interimInputTranscription?.text) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "interim",
          text: content.interimInputTranscription.text,
        }));
      }
    }

    if (content?.inputTranscription?.text) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "final",
          text: content.inputTranscription.text,
        }));
      }
    }

    if (message.error) {
      console.error("Gemini Live error:", message.error);

      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "error",
          message: message.error.message || "Gemini Live error",
        }));
      }
    }
  });

  upstream.on("error", (error) => {
    console.error("Gemini WebSocket error:", error.message);

    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "error",
        message: "Could not connect to Gemini Live.",
      }));
    }
  });

  client.on("message", (raw) => {
    if (!ready || upstream.readyState !== WebSocket.OPEN) return;

    try {
      const message = JSON.parse(raw.toString());

      if (message.audio) {
        upstream.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: message.audio,
              mimeType: "audio/pcm;rate=16000",
            },
          },
        }));
      }
    } catch (error) {
      console.error("Invalid audio message:", error.message);
    }
  });

  const closeConnections = () => {
    if (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    ) {
      upstream.close();
    }
  };

  client.on("close", closeConnections);
  client.on("error", closeConnections);

  upstream.on("close", () => {
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    }
  });
});

// Laptop-to-mobile interview session synchronization.
syncWss.on("connection", (client) => {
  let joinedRoom = null;
  let clientRole = "viewer";

  client.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.type === "join") {
      if (joinedRoom) {
        client.send(JSON.stringify({ type: "error", message: "This connection has already joined a session." }));
        client.close(1008, "Already joined");
        return;
      }
      const roomId = String(message.roomId || "").trim().toUpperCase();
      if (!/^[A-F0-9]{12}$/.test(roomId)) {
        client.send(JSON.stringify({ type: "error", message: "Invalid session code." }));
        return;
      }
      joinedRoom = roomId;
      clientRole = message.role === "host" ? "host" : "viewer";
      if (!interviewRooms.has(roomId)) interviewRooms.set(roomId, { snapshot: null, clients: new Set(), host: null });
      const room = interviewRooms.get(roomId);
      if (clientRole === "host" && room.host && room.host.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "error", message: "This session already has an active laptop host." }));
        client.close(1008, "Host already connected");
        return;
      }
      if (room.clients.size >= 5) {
        client.send(JSON.stringify({ type: "error", message: "This session is full." }));
        client.close(1008, "Session full");
        return;
      }
      if (clientRole === "host") room.host = client;
      room.clients.add(client);
      client.send(JSON.stringify({ type: "joined", role: clientRole, snapshot: room.snapshot }));
      return;
    }

    if (message.type === "update" && joinedRoom && clientRole === "host") {
      const room = interviewRooms.get(joinedRoom);
      if (!room) return;
      const snapshot = {
        transcript: String(message.snapshot?.transcript || "").slice(-12000),
        question: String(message.snapshot?.question || "").slice(0, 3000),
        answer: String(message.snapshot?.answer || "").slice(0, 12000),
        updatedAt: Date.now(),
      };
      room.snapshot = snapshot;
      const payload = JSON.stringify({ type: "snapshot", snapshot });
      for (const peer of room.clients) {
        if (peer.readyState === WebSocket.OPEN) peer.send(payload);
      }
    }
  });

  const removeClient = () => {
    if (!joinedRoom) return;
    const room = interviewRooms.get(joinedRoom);
    if (!room) return;
    room.clients.delete(client);
    if (room.host === client) room.host = null;
    if (room.clients.size === 0) interviewRooms.delete(joinedRoom);
  };
  client.on("close", removeClient);
  client.on("error", removeClient);
});

// React SPA fallback (Express 5 compatible)
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// Render assigns the PORT environment variable
const PORT = process.env.PORT || 3001;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Coach server running on port ${PORT}`);
});
