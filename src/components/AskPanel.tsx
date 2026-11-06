"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Markdown } from "./Markdown";

type Msg = { role: "user" | "assistant"; content: string; meta?: string };

const SUGGESTIONS: Record<string, string[]> = {
  "/": ["Why am I up or down today?", "What needs my attention?", "Where should $1,250 go?"],
  "/portfolio": ["Am I too concentrated anywhere?", "What is missing before these numbers are verified?", "What's my exposure to AI infrastructure?"],
  "/policy": ["Explain my policy limit conflicts", "Which of my limits are still placeholders?"],
  "/research": ["Which research is stale?", "Which researched stock has the best expected return today?"],
  "/decisions": ["Summarize my past decisions", "Which decisions have worked out so far?"],
};

function symbolFromPath(path: string): string | null {
  const m = path.match(/^\/(?:research|decisions\/review)\/([A-Za-z.]+)/);
  return m ? m[1].toUpperCase() : null;
}

export function AskPanel() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [deep, setDeep] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const symbol = symbolFromPath(path);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpen = (e: Event) => {
      setOpen(true);
      const q = (e as CustomEvent<string | undefined>).detail;
      if (q) setInput(q);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pi:ask", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pi:ask", onOpen); };
  }, []);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs, busy]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: question }];
    setMsgs(next);
    setInput("");
    setBusy("Thinking");
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })), page: path, symbol, deep }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setMsgs([...next, { role: "assistant", content: j.error ?? "The assistant is unavailable right now." }]);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "status") setBusy(ev.text);
          if (ev.type === "answer") {
            const meta = `${ev.model.includes("opus") ? "Deep review" : "Standard"}${ev.tools?.length ? ` · used ${[...new Set(ev.tools as string[])].length} tool${ev.tools.length > 1 ? "s" : ""}` : ""} · AI judgment`;
            setMsgs([...next, { role: "assistant", content: ev.text, meta }]);
          }
          if (ev.type === "error") setMsgs([...next, { role: "assistant", content: ev.text }]);
        }
      }
    } catch {
      setMsgs([...next, { role: "assistant", content: "Network error. Try again." }]);
    } finally {
      setBusy(null);
    }
  }

  const suggestions = SUGGESTIONS[Object.keys(SUGGESTIONS).find((k) => (k === "/" ? path === "/" : path.startsWith(k))) ?? "/"] ?? [];

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"
        className="min-h-10 px-3.5 rounded-lg bg-chrome-ink text-chrome text-sm font-medium inline-flex items-center gap-2">
        Ask <span className="font-mono text-xs opacity-70 hidden sm:inline">⌘J</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Assistant">
          <button type="button" aria-label="Close assistant" className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="relative w-full sm:w-[440px] h-full bg-surface text-ink border-l border-line flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <div>
                <div className="font-semibold">Assistant</div>
                <div className="text-xs text-muted">Knows this page{symbol ? ` · ${symbol}` : ""}. Numbers come from the app, not from the AI.</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="min-h-10 min-w-10 rounded-lg hover:bg-ground" aria-label="Close">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
              {!msgs.length && (
                <div className="flex flex-col gap-2">
                  {suggestions.map((s) => (
                    <button key={s} type="button" onClick={() => ask(s)} className="text-left min-h-11 px-3 rounded-lg border border-line hover:bg-ground text-sm">{s}</button>
                  ))}
                </div>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={m.role === "user" ? "self-end max-w-[85%] bg-ink text-ground rounded-xl px-3.5 py-2 text-sm" : "text-[15px] leading-relaxed"}>
                  {m.role === "assistant" ? <Markdown text={m.content} /> : <div className="whitespace-pre-wrap">{m.content}</div>}
                  {m.meta && <div className="text-xs text-muted mt-1.5">{m.meta}</div>}
                </div>
              ))}
              {busy && <div className="text-sm text-muted animate-pulse">{busy}…</div>}
              <div ref={endRef} />
            </div>
            <form className="border-t border-line p-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
              <label htmlFor="ask-input" className="sr-only">Ask a question</label>
              <textarea id="ask-input" ref={inputRef} rows={2} value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
                placeholder={symbol ? `Ask about ${symbol}` : "Ask about your portfolio"}
                className="w-full resize-none rounded-lg border border-line-strong bg-ground px-3 py-2 text-[15px]" />
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm text-muted inline-flex items-center gap-2 min-h-10">
                  <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> Think harder (slower, costs more)
                </label>
                <button type="submit" disabled={!!busy || !input.trim()} className="min-h-10 px-4 rounded-lg bg-ink text-ground font-medium disabled:opacity-50">Send</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

/** Opens the assistant with a question prefilled. */
export function AskButton({ question, children, className }: { question: string; children: React.ReactNode; className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new CustomEvent("pi:ask", { detail: question }))}>
      {children}
    </button>
  );
}
