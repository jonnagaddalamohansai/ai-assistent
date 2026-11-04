export async function callApi(payload, options = {}) {
  const res = await fetch("/api/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.onChunk ? { ...payload, stream: true } : payload),
  });

  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch {}
    throw new Error(data.error || "Request failed");
  }

  if (!options.onChunk) {
    const data = await res.json();
    return data.result;
  }

  if (!res.body) throw new Error("Streaming is not supported by this browser.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  const processEvent = (frame) => {
    const lines = frame.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim());
    if (!lines.length) return;
    const data = JSON.parse(lines.join("\n"));
    if (data.error) throw new Error(data.error);
    if (data.text) {
      fullText += data.text;
      options.onChunk(data.text);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const event of events) if (event.trim()) processEvent(event);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processEvent(buffer);
  return fullText;
}
