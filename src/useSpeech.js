
import { useEffect, useRef, useState } from "react";

export function useSpeech(onFinalText) {
  const callbackRef = useRef(onFinalText);
  const streamRef = useRef(null);
  const contextRef = useRef(null);
  const socketRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const gainRef = useRef(null);

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    callbackRef.current = onFinalText;
  }, [onFinalText]);

  const stop = () => {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }

    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    gainRef.current?.disconnect();

    processorRef.current = null;
    sourceRef.current = null;
    gainRef.current = null;

    if (contextRef.current) {
      contextRef.current.close().catch(() => {});
      contextRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    setListening(false);
    setInterim("Audio capture stopped.");
  };

  const start = async () => {
    try {
      setError("");
      setInterim("Select the meeting tab and enable Share tab audio.");

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        preferCurrentTab: false,
        selfBrowserSurface: "exclude",
        systemAudio: "exclude",
      });

      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(
          "No tab audio received. Select your meeting tab and enable Share tab audio."
        );
      }

      streamRef.current = stream;

      const context = new AudioContext({ sampleRate: 16000 });
      contextRef.current = context;

      await context.resume();

      const audioStream = new MediaStream(stream.getAudioTracks());
      const source = context.createMediaStreamSource(audioStream);
      sourceRef.current = source;

      const processor = context.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      const gain = context.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/live-audio`
      );

      socketRef.current = socket;

      socket.onopen = () => {
        setInterim("Connected. Waiting for Gemini Live...");
      };

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "ready") {
          setListening(true);
          setInterim("Live transcription active. Listening to meeting audio...");
          return;
        }

        if (data.type === "interim") {
          setInterim(data.text);
          return;
        }

        if (data.type === "final") {
          setInterim("");
          if (data.text?.trim()) {
            callbackRef.current(data.text.trim());
          }
          return;
        }

        if (data.type === "error") {
          setError(data.message || "Gemini Live error.");
          stop();
        }
      };

      socket.onerror = () => {
        setError("WebSocket connection failed. Check that the API server is running.");
        stop();
      };

      socket.onclose = () => {
        setListening(false);
      };

      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;

        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);

        for (let i = 0; i < input.length; i++) {
          const sample = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = sample < 0
            ? sample * 32768
            : sample * 32767;
        }

        const bytes = new Uint8Array(pcm.buffer);
        let binary = "";

        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }

        socket.send(JSON.stringify({
          audio: btoa(binary),
        }));
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);

      stream.getTracks().forEach((track) => {
        track.onended = () => stop();
      });
    } catch (err) {
      stop();
      setError(err.message || "Could not start audio capture.");
    }
  };

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
      gainRef.current?.disconnect();
      contextRef.current?.close().catch(() => {});
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return { start, stop, listening, interim, error };
}
