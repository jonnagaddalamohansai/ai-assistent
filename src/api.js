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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\\n\\n");
    buffer = events.pop() || "";

    for (const event of events) {
      for (const line of event.split("\\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        const data = JSON.parse(raw);
        if (data.error) throw new Error(data.error);
        if (data.text) {
          fullText += data.text;
          options.onChunk(data.text);
        }
      }
    }
  }

  return fullText;
}
