/**
 * Assistant questions as background jobs. A question is stored as an assistant_request row; the job
 * answers it and stores an assistant_answer row (both insert-only, in model_runs). The browser polls.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorkspace } from "@/lib/workspace-core";
import { save } from "@/lib/intel/jobs";
import { AGENT_VERSION, runAgent, runBaseline, type AgentAnswer } from "./agent";

export type AskRequest = {
  question: string; history?: { role: "user" | "assistant"; content: string }[];
  page?: string | null; symbol?: string | null; deep?: boolean;
  /** "baseline" = a plain Claude conversation with pasted holdings, for comparison. */
  mode: "app" | "baseline"; demo?: string | null;
};

/** The five questions the assistant is judged on (Brendan, 2026-11-06). */
export const DEMO_QUESTIONS = [
  "What happened in the market today, and what should I do?",
  "Should I add $1,250 to my portfolio, and where?",
  "What changed for IREN following its latest earnings?",
  "Analyze a stock I have never researched before: pick one that fits my portfolio and tell me whether it deserves a place in it.",
  "What are the most promising investment opportunities worth researching right now?",
];

export async function runAskJob(db: SupabaseClient, requestId: string) {
  const { data } = await db.from("model_runs").select("id, inputs").eq("id", requestId).eq("kind", "assistant_request").maybeSingle();
  if (!data) throw new Error("Unknown request");
  const r = data.inputs as AskRequest;
  const ws = await buildWorkspace(db);
  let out: AgentAnswer | { error: string; mode: string; question: string };
  try {
    out = r.mode === "baseline" ? await runBaseline(ws, r.question) : await runAgent(db, ws, r);
  } catch (e) {
    out = { error: (e as Error).message.slice(0, 300), mode: r.mode, question: r.question };
  }
  return save(db, "assistant_answer", AGENT_VERSION, { request_id: requestId, mode: r.mode, question: r.question, demo: r.demo ?? null }, out);
}
