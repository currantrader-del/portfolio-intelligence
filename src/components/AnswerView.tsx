import { Markdown } from "@/components/Markdown";
import { Disclose } from "@/components/ui";
import { splitAnswer } from "@/lib/assistant/splitAnswer";

/** An assistant answer: the summary up front, the full analysis one tap away. */
export function AnswerView({ text, open }: { text: string; open?: boolean }) {
  const { summary, rest } = splitAnswer(text);
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="text-[15px] leading-relaxed"><Markdown text={summary} /></div>
      {rest && (
        <Disclose summary={<span className="t-sm">Full analysis</span>} open={open}>
          <div className="text-[15px] leading-relaxed"><Markdown text={rest} /></div>
        </Disclose>
      )}
    </div>
  );
}
