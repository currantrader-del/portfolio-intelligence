"use client";

/**
 * Interaction feedback for every control that changes something:
 * - <ActionForm> runs a server action without a full page reload, blocks double submits, keeps what
 *   the person typed when it fails, and says plainly whether it worked.
 * - <SubmitButton> shows a spinner and a "Saving…" label while its form is working. It also works
 *   inside a plain <form action={serverAction}> (through useFormStatus).
 * - toast() / <Toaster> confirm a finished action even when the page re-renders or scrolls.
 * Nothing here claims success before the server has answered.
 */
import { createContext, useContext, useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { unstable_rethrow } from "next/navigation";
import type { ActionResult } from "@/lib/action-result";
import { cx } from "@/components/ui";

/* ------------------------------------------------------------------ spinner */

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("spin", className)} />;
}

/* ------------------------------------------------------------------ toast */

type ToastMsg = { id: number; text: string; tone: "ok" | "error" };
const TOAST_EVENT = "pi:toast";

/** Shows a short confirmation above the tab bar. Call only after the server has confirmed. */
export function toast(text: string, tone: ToastMsg["tone"] = "ok") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { text, tone } }));
}

export function Toaster() {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; tone: ToastMsg["tone"] }>).detail;
      setMsg({ id: Date.now(), text: d.text, tone: d.tone });
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), d.tone === "error" ? 5000 : 2800);
    };
    window.addEventListener(TOAST_EVENT, on);
    return () => { window.removeEventListener(TOAST_EVENT, on); clearTimeout(timer); };
  }, []);
  return (
    <div aria-live="polite" role="status" className="toast-wrap">
      {msg && (
        <div key={msg.id} className={cx("toast", msg.tone === "error" && "toast-error")} onClick={() => setMsg(null)}>
          {msg.tone === "ok" ? <Tick /> : <Bang />}
          <span className="min-w-0">{msg.text}</span>
        </div>
      )}
    </div>
  );
}

const Tick = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0"><path d="M3.5 8.5l3 3 6-7" /></svg>
);
const Bang = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0"><path d="M8 4v5M8 11.5v.5" /></svg>
);

/* ------------------------------------------------------------------ action form */

type Action = (formData: FormData) => Promise<ActionResult | undefined>;
const FormPending = createContext<{ pending: boolean; submitter: string | null } | null>(null);

function failureMessage(): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "You're offline, so nothing was saved. Your entries are still here; try again when you're connected.";
  return "That didn't save: the server didn't answer properly. Nothing was changed and your entries are still here. Try again.";
}

/**
 * A form for a server action. On success the action usually redirects (the page then shows its own
 * "Saved" note) and a toast confirms it; on failure the message appears under the form and every field
 * keeps its value.
 */
export function ActionForm({ action, children, className, success = "Saved", resetOnSuccess = false, id, "aria-label": ariaLabel }: {
  action: Action; children: ReactNode; className?: string;
  /** The confirmation once the server has finished. null when the page itself reports the outcome (it may be a failure). */
  success?: string | null;
  resetOnSuccess?: boolean; id?: string; "aria-label"?: string;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [submitter, setSubmitter] = useState<string | null>(null);
  const lock = useRef(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return; // a second tap while the first is still working does nothing
    const form = e.currentTarget;
    const by = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    let fd: FormData;
    try { fd = new FormData(form, by ?? undefined); } catch { fd = new FormData(form); }
    lock.current = true;
    setSubmitter(by?.dataset.key ?? null);
    setResult(null);
    start(async () => {
      try {
        const r = await action(fd);
        if (r && typeof r === "object" && "error" in r) { setResult({ kind: "error", text: r.error }); return; }
        if (success) { setResult({ kind: "ok", text: success }); toast(success); }
        if (resetOnSuccess) form.reset();
      } catch (err) {
        // A redirect means the server finished and is sending the updated page: let Next.js handle it.
        try { unstable_rethrow(err); } catch (nav) { if (success) toast(success); throw nav; }
        setResult({ kind: "error", text: failureMessage() });
      } finally {
        lock.current = false;
      }
    });
  }

  return (
    <FormPending.Provider value={{ pending, submitter }}>
      <form id={id} aria-label={ariaLabel} onSubmit={onSubmit} className={className} aria-busy={pending || undefined}>
        {children}
        {result && (
          <p role={result.kind === "error" ? "alert" : "status"} className={cx("form-note basis-full", result.kind === "error" ? "form-note-error" : "form-note-ok")}>
            {result.kind === "ok" ? <Tick /> : <Bang />}<span className="min-w-0">{result.text}</span>
          </p>
        )}
      </form>
    </FormPending.Provider>
  );
}

/**
 * Submit button with a pending state. Disabled while its form works, so a double tap can't submit twice.
 * Give `pendingKey` when a form has more than one submit button, so only the tapped one shows the spinner.
 */
export function SubmitButton({ children, pendingText = "Saving…", className = "btn", pendingKey, disabled, name, value, title }: {
  children: ReactNode; pendingText?: ReactNode; className?: string; pendingKey?: string; disabled?: boolean; name?: string; value?: string; title?: string;
}) {
  const ctx = useContext(FormPending);
  const status = useFormStatus();
  const formPending = ctx ? ctx.pending : status.pending;
  const mine = formPending && (!pendingKey || !ctx || ctx.submitter === null || ctx.submitter === pendingKey);
  return (
    <button type="submit" name={name} value={value} title={title} data-key={pendingKey} disabled={disabled || formPending} aria-busy={mine || undefined} className={cx(className, mine && "is-pending")}>
      {mine ? <><Spinner />{pendingText}</> : children}
    </button>
  );
}
