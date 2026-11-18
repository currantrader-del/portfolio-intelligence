"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";
import { requestPaidJSON } from "@/lib/client/request";

const MAX = 20 * 1024 * 1024;

async function sha256(buf: ArrayBuffer) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Upload an analyst report PDF: the browser puts it straight into your private storage, then the app starts
 * one AI read (about $0.10-0.30). Refreshes the page until the read is saved.
 */
export function AnalystUpload({ symbol, running }: { symbol: string; running: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = running || !!step;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [running, router]);
  useEffect(() => { if (running) setStep(null); }, [running]);

  async function upload(file: File) {
    setError(null);
    if (file.type && file.type !== "application/pdf") { setError("Choose a PDF file."); return; }
    if (file.size > MAX) { setError("The PDF must be under 20 MB."); return; }
    try {
      setStep("Uploading…");
      const buf = await file.arrayBuffer();
      const sha = await sha256(buf);
      // Loaded only when a file is chosen, so the page stays light.
      const { createClient } = await import("@/lib/supabase/client");
      const db = createClient();
      const { data: u } = await db.auth.getUser();
      if (!u.user) { setError("Sign in again, then retry."); setStep(null); return; }
      const fileName = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "report.pdf";
      const path = `${u.user.id}/${sha}/${fileName}`;
      const up = await db.storage.from("originals").upload(path, new Blob([buf], { type: "application/pdf" }), { upsert: false, contentType: "application/pdf" });
      if (up.error && !/exists|duplicate/i.test(up.error.message)) { setError(`Upload failed: ${up.error.message}`); setStep(null); return; }
      setStep("Starting the read…");
      const r = await requestPaidJSON("/api/analyst", { json: { symbol, path, fileName, sha256: sha, size: file.size } });
      if (!r.ok) { setError(r.error); setStep(null); return; }
      setStep("Reading… (1–3 min)");
      router.refresh();
    } catch (e) {
      setError((e as Error).message || "Upload failed."); setStep(null);
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className={`btn btn-sm self-start ${active ? "is-pending pointer-events-none opacity-70" : ""}`}>
        {active ? <><Spinner />{step ?? "Reading… (1–3 min)"}</> : "Upload an analyst report (PDF)"}
        <input ref={input} type="file" accept="application/pdf,.pdf" className="sr-only" disabled={active} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
      </label>
      {error && <span role="alert" className="form-note form-note-error">{error}</span>}
    </div>
  );
}
