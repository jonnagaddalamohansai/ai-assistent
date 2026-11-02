
import express from "express";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import handler from "./api/answer.js";

const app = express();
app.use(express.json({ limit: "16mb" }));
app.all("/api/answer", (req, res) => handler(req, res));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, "http://localhost").pathname;

  if (pathname !== "/live-audio") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (client) => {
    wss.emit("connection", client, request);
  });
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

server.listen(3001, () => {
  console.log("API running at http://localhost:3001");
  console.log("Live audio WebSocket: ws://localhost:3001/live-audio");
});
