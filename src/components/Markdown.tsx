import { Fragment, type ReactNode } from "react";

/**
 * A small, safe Markdown renderer for assistant answers: headings, bullet and numbered lists,
 * bold, italics and inline code. No raw HTML is ever injected.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)<>\]]+[^\s)<>\].,;:!?'"]|\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const link = t.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) out.push(<a key={i++} href={link[2]} target="_blank" rel="noreferrer" className="underline break-words">{link[1]}</a>);
    else if (/^https?:\/\//.test(t)) out.push(<a key={i++} href={t} target="_blank" rel="noreferrer" className="underline break-all">{t.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}{t.length > 60 ? "…" : ""}</a>);
    else if (t.startsWith("**")) out.push(<strong key={i++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={i++} className="font-mono text-[0.92em] bg-ground px-1 rounded">{t.slice(1, -1)}</code>);
    else out.push(<em key={i++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let table: string[][] | null = null;
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    blocks.push(
      <div key={blocks.length} className="overflow-x-auto"><table className="text-[13px] w-full">
        <thead><tr>{head.map((c, j) => <th key={j} className="text-left font-semibold pr-3 pb-1 align-bottom">{inline(c)}</th>)}</tr></thead>
        <tbody>{rows.map((r, k) => <tr key={k} className="border-t border-line">{r.map((c, j) => <td key={j} className="pr-3 py-1 align-top">{inline(c)}</td>)}</tr>)}</tbody>
      </table></div>,
    );
    table = null;
  };
  const flushPara = () => { if (para.length) { blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>); para = []; } };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, j) => <li key={j}>{inline(it)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length} className="list-decimal pl-5 flex flex-col gap-1">{items}</ol> : <ul key={blocks.length} className="list-disc pl-5 flex flex-col gap-1">{items}</ul>);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^#{1,4}\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // the |---|---| separator row
      (table ??= []).push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      continue;
    }
    flushTable();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); flushList(); continue; }
    if (h) { flushPara(); flushList(); blocks.push(<p key={blocks.length} className="font-semibold">{inline(h[1])}</p>); continue; }
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  flushTable();
  return <div className="flex flex-col gap-2.5">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
