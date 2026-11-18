/**
 * Reads one section (or one part of a long section) of a document in full with Claude Haiku and
 * returns structured notes: a summary, figures with verbatim quotes, guidance, risks, capital
 * structure items and, for calls, the Q&A. The whole text is sent; nothing is pre-filtered by
 * keywords. Every quoted figure is checked against the text by code before it is stored.
 */
import Anthropic from "@anthropic-ai/sdk";
import { checkQuote, partsOf } from "./text";
import { INV_MODELS, usageOf } from "./models";
import { sectionText, type DocText } from "./documents";
import type { InvDoc, Review, Usage } from "./types";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "facts", "guidance", "risks", "capital", "qa", "flags"],
  properties: {
    summary: { type: "string" },
    facts: { type: "array", items: { type: "object", additionalProperties: false, required: ["claim", "value", "unit", "period", "quote"], properties: { claim: { type: "string" }, value: { type: "string" }, unit: { type: "string" }, period: { type: "string" }, quote: { type: "string" } } } },
    guidance: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    capital: { type: "array", items: { type: "string" } },
    qa: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "answer"], properties: { question: { type: "string" }, answer: { type: "string" } } } },
    flags: { type: "array", items: { type: "string" } },
  },
} as const;

const KIND_HINT: Partial<Record<InvDoc["kind"], string>> = {
  transcript: "This is an earnings call. Cover the prepared remarks AND every analyst question in the Q&A with the substance of management's answer (qa list). Note evasive or changed answers in flags.",
  proxy: "This is a proxy statement. Focus on how executives are paid (metrics, targets, equity grants, dilution from plans), board independence, related-party transactions and shareholder proposals.",
  financing: "This is a financing or agreement filing. Record exact terms: amounts, prices, coupons, conversion prices and dates, maturities, covenants, collateral, use of proceeds, and the dilution it can cause.",
  presentation: "This is an investor presentation. Record targets, segment data, unit economics and any claims that differ from the filings.",
};

export async function reviewPart(a: {
  client?: Anthropic; symbol: string; doc: InvDoc; text: DocText; section: string; part: number; focus?: string | null;
}): Promise<{ review: Review; usage: Usage } | { error: string; usage?: Usage }> {
  const body = sectionText(a.text, a.section);
  if (body === null) return { error: `Section ${a.section} not found in ${a.doc.id}` };
  const parts = partsOf(body.length);
  const range = parts[a.part];
  if (!range) return { error: `Part ${a.part + 1} does not exist (the section has ${parts.length})` };
  const chunk = body.slice(range.start, range.end);
  const label = a.doc.sections?.find((s) => s.key === a.section)?.label ?? a.section;
  const client = a.client ?? new Anthropic();
  const t0 = Date.now();
  const instructions = `You are reading, in full, ${parts.length > 1 ? `part ${a.part + 1} of ${parts.length} of ` : ""}"${label}" of ${a.doc.title} for an equity research file on ${a.symbol}. The complete text is above; read all of it.
${KIND_HINT[a.doc.kind] ?? ""}
Return:
- summary: a thorough plain-English account of everything material in this text (250-700 words): what it says, what changed, what matters for the business, its finances and its value.
- facts: up to 40 important figures. For each: the claim, the value exactly as written, its unit, the period, and a quote copied word for word from the text (8-300 characters) that contains the figure. Never paraphrase a quote.
- guidance: forward-looking statements and outlook, with figures.
- risks: risks, uncertainties, legal matters, customer or supplier concentration, going-concern or impairment language.
- capital: share count, dilution, buybacks, debt, convertibles, financing, commitments, with figures.
- qa: for an earnings call, each analyst question and the substance of the answer; otherwise empty.
- flags: inconsistencies, unusual accounting, changed definitions, anything that contradicts other statements or needs checking.${a.focus ? `\nThe research is specifically asking: ${a.focus}. Answer it in the summary if this text addresses it, and say so if it does not.` : ""}`;
  try {
    const res = await client.beta.messages.create({
      model: INV_MODELS.reader.id,
      max_tokens: 16000,
      output_config: { effort: INV_MODELS.reader.effort, format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: "user", content: [{ type: "text", text: `<document title="${a.doc.title.replace(/"/g, "'")}" section="${label}">\n${chunk}\n</document>` }, { type: "text", text: instructions }] }],
    });
    const usage = usageOf(res.model, res.usage, Date.now() - t0);
    if (res.stop_reason === "refusal") return { error: "The reader declined this text", usage };
    const txt = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    let out: Omit<Review, "key" | "docId" | "section" | "part" | "parts" | "chars" | "model" | "at" | "focus">;
    try { out = JSON.parse(txt); } catch { return { error: `The reader's notes were not readable${res.stop_reason === "max_tokens" ? " (cut at the length limit)" : ""}`, usage }; }
    // Keep only facts whose quote really is in the text; the rest are marked so nobody relies on them.
    const facts = (out.facts ?? []).slice(0, 40).map((f) => ({ ...f, check: checkQuote(chunk, f.quote, f.value).status }));
    const review: Review = {
      key: `${a.doc.id}:${a.section}:${a.part}`, docId: a.doc.id, section: a.section, part: a.part, parts: parts.length, chars: chunk.length,
      model: res.model, at: new Date().toISOString(), summary: String(out.summary ?? "").slice(0, 8000), facts,
      guidance: (out.guidance ?? []).slice(0, 30), risks: (out.risks ?? []).slice(0, 30), capital: (out.capital ?? []).slice(0, 30), qa: (out.qa ?? []).slice(0, 40), flags: (out.flags ?? []).slice(0, 20), focus: a.focus ?? null,
    };
    return { review, usage };
  } catch (e) {
    return { error: `Reader call failed: ${(e as Error).message.slice(0, 160)}` };
  }
}

/** Every (section, part) of a document that still has to be read for it to count as fully reviewed. */
export function pendingParts(d: InvDoc): { section: string; part: number }[] {
  if (!d.sections) return [];
  const material = d.sections.filter((s) => s.material);
  const secs = material.length ? material : d.sections;
  return secs.flatMap((s) => Array.from({ length: s.parts }, (_, i) => i).filter((i) => !s.reviewedParts.includes(i)).map((part) => ({ section: s.key, part })));
}

export function markReviewed(d: InvDoc, section: string, part: number) {
  const s = d.sections?.find((x) => x.key === section);
  if (s && !s.reviewedParts.includes(part)) s.reviewedParts.push(part);
}

/** Compact text of a review for the analyst's context. */
export function reviewText(r: Review, doc?: InvDoc): string {
  const sec = doc?.sections?.find((s) => s.key === r.section)?.label ?? r.section;
  const facts = r.facts.map((f) => `  - ${f.claim}: ${f.value} ${f.unit} (${f.period}) "${f.quote}"${f.check && f.check !== "verified" ? ` [quote check: ${f.check}]` : ""}`).join("\n");
  const list = (title: string, xs: string[]) => (xs.length ? `${title}:\n${xs.map((x) => `  - ${x}`).join("\n")}` : "");
  return [
    `[${r.docId} · ${doc?.title ?? ""} · ${sec}${r.parts > 1 ? ` part ${r.part + 1}/${r.parts}` : ""} · read in full by ${r.model}]`,
    r.summary,
    facts ? `Figures (quotes checked against the text):\n${facts}` : "",
    list("Guidance", r.guidance), list("Risks", r.risks), list("Capital structure", r.capital),
    r.qa.length ? `Q&A:\n${r.qa.map((q) => `  - Q: ${q.question}\n    A: ${q.answer}`).join("\n")}` : "",
    list("Flags", r.flags),
  ].filter(Boolean).join("\n");
}
