// Labels one dictation with a content category via the polisher model.
import { CATEGORIES, type Category } from "./contract.js";

/** Indirection so tests can stub the network without touching global fetch. */
export const classifyFetch: typeof fetch = (...args) => fetch(...args);

const SYSTEM =
  "Classify one dictated text into exactly one category: " +
  '"prompt" (an instruction or question for an AI coding agent), "note" (a note to self, todo, or plan), ' +
  '"message" (a message to a person: chat, email), "code" (a code-level edit instruction naming files, functions or commands), ' +
  '"other". Answer with JSON {"category": "<label>"} only.';

export async function classifyText(o: {
  text: string;
  serverUrl: string;
  model: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Category | null> {
  const fetchImpl = o.fetchImpl ?? classifyFetch;
  try {
    const response = await fetchImpl(`${o.serverUrl.replace(/\/$/u, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: o.signal,
      body: JSON.stringify({
        model: o.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: o.text.slice(0, 2000) },
        ],
        temperature: 0,
        max_tokens: 30,
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "category",
            schema: { type: "object", properties: { category: { type: "string", enum: [...CATEGORIES] } }, required: ["category"] },
          },
        },
      }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content) as { category?: unknown };
    return (CATEGORIES as readonly string[]).includes(String(parsed.category)) ? (parsed.category as Category) : null;
  } catch {
    return null;
  }
}
