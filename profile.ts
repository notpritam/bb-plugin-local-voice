// Writes the "Your voice" persona with the polisher model, grammar-constrained to JSON.
export const profileFetch: typeof fetch = (...args) => fetch(...args);

export interface Persona {
  title: string;
  description: string;
  catchphrase: string;
  peakDescription: string;
}

const SYSTEM =
  "You write short, warm, specific 'voice profile' cards for a person based on a sample of things they dictated by voice " +
  "(to AI coding agents, notes, messages). Speak to them as 'you'. Be concrete about what they actually talk about; never generic. " +
  "Return JSON with: title (a 2-3 word persona name like 'Context Clarifier' or 'Deploy Whisperer'), " +
  "description (two sentences about how and what they dictate), catchphrase (a short phrase taken verbatim from the sample that they say often, " +
  "without surrounding quotes), peakDescription (one sentence about what they tend to do at their peak time, using the stats).";

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", maxLength: 40 },
    description: { type: "string", maxLength: 400 },
    catchphrase: { type: "string", maxLength: 80 },
    peakDescription: { type: "string", maxLength: 240 },
  },
  required: ["title", "description", "catchphrase", "peakDescription"],
};

export async function generatePersona(o: {
  sample: string[];
  stats: string;
  serverUrl: string;
  model: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Persona | null> {
  const fetchImpl = o.fetchImpl ?? profileFetch;
  const user = `Stats:\n${o.stats}\n\nSample of dictations (newest first):\n${o.sample.map((s) => `- ${s}`).join("\n")}`;
  try {
    const response = await fetchImpl(`${o.serverUrl.replace(/\/$/u, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: o.signal,
      body: JSON.stringify({
        model: o.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user.slice(0, 12_000) },
        ],
        temperature: 0.3,
        max_tokens: 400,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_schema", json_schema: { name: "persona", schema: SCHEMA } },
      }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content) as Partial<Persona>;
    const field = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const persona = { title: field(parsed.title), description: field(parsed.description), catchphrase: field(parsed.catchphrase).replace(/^["“]|["”]$/gu, ""), peakDescription: field(parsed.peakDescription) };
    return persona.title === "" || persona.description === "" ? null : persona;
  } catch {
    return null;
  }
}
