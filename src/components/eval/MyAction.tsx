import { ActionForm, SubmitButton } from "@/components/forms";
import { recordMyAction } from "@/app/(app)/eval-actions";
import { MY_ACTION_LABEL, type ActionRecord, type ActionSubject } from "@/lib/eval/log";
import { shortDate } from "@/lib/format";

/** "I did this" / "I passed" for one recommendation, alert or Radar idea. Recording only; nothing is traded. */
export function MyActionButtons({ subject, refId, symbol, summary, path, current, label = "What did you do?", did = "I did this", passed = "I passed" }: {
  subject: ActionSubject; refId: string; symbol?: string | null; summary: string; path: string; current?: ActionRecord | null; label?: string; did?: string; passed?: string;
}) {
  return (
    <ActionForm action={recordMyAction} success={null} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="subject" value={subject} /><input type="hidden" name="ref" value={refId} />
      <input type="hidden" name="symbol" value={symbol ?? ""} /><input type="hidden" name="summary" value={summary.slice(0, 400)} /><input type="hidden" name="path" value={path} />
      <span className="t-xs">{current ? `${did === "I did this" ? MY_ACTION_LABEL[current.action] : `You chose: ${current.action === "did" ? did : passed}`} (${shortDate(current.at)}).` : label}</span>
      <SubmitButton name="action" value="did" pendingKey="did" className={`btn btn-sm ${current?.action === "did" ? "btn-primary" : ""}`} pendingText="Saving…">{did}</SubmitButton>
      <SubmitButton name="action" value="passed" pendingKey="passed" className={`btn btn-sm ${current?.action === "passed" ? "btn-primary" : ""}`} pendingText="Saving…">{passed}</SubmitButton>
    </ActionForm>
  );
}
