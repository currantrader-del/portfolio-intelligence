"use client";

import { useState } from "react";
import Link from "next/link";
import { unzipSync } from "fflate";
import { createClient } from "@/lib/supabase/client";
import { classify, toInputs, type LoadedFile } from "@/lib/import/files";
import { buildPlan, type ImportPlan } from "@/lib/import/plan";
import { applyPlan } from "@/lib/import/apply";

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function load(list: FileList): Promise<LoadedFile[]> {
  const out: LoadedFile[] = [];
  for (const f of Array.from(list)) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (f.name.toLowerCase().endsWith(".zip")) {
      // Watchlist and baseline exports arrive zipped; read the JSON inside without saving the zip.
      const entries = unzipSync(bytes);
      for (const [path, data] of Object.entries(entries)) {
        const name = path.split("/").pop()!;
        if (name.endsWith(".json") || name.endsWith(".md")) out.push({ name, bytes: data, sha256: await sha256(data) });
      }
    } else {
      out.push({ name: f.name, bytes, sha256: await sha256(bytes) });
    }
  }
  return out;
}

type State =
  | { kind: "idle" }
  | { kind: "ready"; plan: ImportPlan; files: Map<string, Uint8Array>; ignored: string[]; duplicates: string[] }
  | { kind: "running"; lines: string[] }
  | { kind: "done"; lines: string[] }
  | { kind: "error"; message: string; lines: string[] };

export default function ImportPage() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    try {
      const loaded = await load(list);
      const { docs, ignored, duplicates } = classify(loaded);
      const plan = buildPlan(toInputs(docs));
      setState({ kind: "ready", plan, files: new Map(docs.map((d) => [d.key, d.bytes])), ignored, duplicates });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e), lines: [] });
    }
  }

  async function onImport() {
    if (state.kind !== "ready") return;
    const lines: string[] = [];
    const log = (l: string) => { lines.push(l); setState({ kind: "running", lines: [...lines] }); };
    log("Starting import…"); // hides the Import button at once, so a second tap can't start it twice
    try {
      const db = createClient();
      const { data } = await db.auth.getUser();
      if (!data.user) throw new Error("Not signed in");
      await applyPlan(db, state.plan, state.files, { ownerId: data.user.id, log });
      setState({ kind: "done", lines });
    } catch (e) {
      const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      setState({ kind: "error", message, lines });
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="h1">Import preserved research</h1>
        <p className="text-muted">Choose the ChatGPT files (JSON, Markdown and the two zips). Nothing is saved until you press Import. Running it twice is safe.</p>
      </div>

      <label className="bg-surface border border-dashed border-line-strong rounded-2xl p-6 flex flex-col gap-2 cursor-pointer">
        <span className="font-medium">Choose files</span>
        <input type="file" multiple accept=".json,.md,.zip" onChange={(e) => onFiles(e.target.files)} className="text-sm" />
      </label>

      {state.kind === "ready" && (
        <section className="bg-surface border border-line rounded-2xl p-6 flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Check before importing</h2>
          <div>
            <h3 className="text-sm font-semibold mb-1">Recognised files ({state.plan.documents.length})</h3>
            <ul className="text-sm flex flex-col gap-1">
              {state.plan.documents.map((d) => (
                <li key={d.key}><span className="font-mono text-xs text-muted">{d.sha256.slice(0, 12)}</span> {d.fileName} · {d.description}</li>
              ))}
            </ul>
          </div>
          {(state.ignored.length > 0 || state.duplicates.length > 0) && (
            <p className="text-sm text-muted">
              {state.ignored.length > 0 && <>Not used: {state.ignored.join(", ")}. </>}
              {state.duplicates.length > 0 && <>Duplicates skipped: {state.duplicates.join(", ")}.</>}
            </p>
          )}
          <div>
            <h3 className="text-sm font-semibold mb-1">What will be saved</h3>
            <ul className="text-sm list-disc pl-5 flex flex-col gap-1">{state.plan.report.map((l) => <li key={l}>{l}</li>)}</ul>
          </div>
          <button type="button" onClick={onImport} className="btn btn-primary self-start">Import</button>
        </section>
      )}

      {(state.kind === "running" || state.kind === "done" || state.kind === "error") && (
        <section className="bg-surface border border-line rounded-2xl p-6 flex flex-col gap-2" aria-live="polite">
          <h2 className="text-lg font-semibold">{state.kind === "running" ? "Importing…" : state.kind === "done" ? "Import finished" : "Import stopped"}</h2>
          <ul className="text-sm flex flex-col gap-1">{state.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          {state.kind === "error" && <p role="alert" className="text-sm text-alert-ink">{state.message}. Nothing after this point was saved; you can run it again.</p>}
          {state.kind === "done" && <Link href="/research" className="self-start min-h-11 px-5 inline-flex items-center rounded-lg bg-ink text-ground no-underline font-medium">Open research</Link>}
        </section>
      )}
    </div>
  );
}
