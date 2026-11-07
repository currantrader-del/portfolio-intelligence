/**
 * Splits an assistant answer into a short summary (shown) and the full analysis (collapsed).
 * The assistant is told to lead with its conclusion, so the summary is the opening paragraphs up to
 * the first heading, capped at about 700 characters (always at least the first paragraph).
 */
export function splitAnswer(text: string, maxSummary = 700): { summary: string; rest: string } {
  const paras = text.trim().split(/\n\s*\n/);
  const out: string[] = [];
  let len = 0;
  for (const p of paras) {
    if (out.length && (/^\s*#{1,6}\s/.test(p) || len + p.length > maxSummary)) break;
    if (!out.length && /^\s*#{1,6}\s/.test(p) && paras.length > 1) continue; // skip a leading title
    out.push(p);
    len += p.length;
  }
  const used = paras.indexOf(out[out.length - 1]) + 1;
  const rest = paras.slice(used).filter((p) => !out.includes(p)).join("\n\n").trim();
  return { summary: out.join("\n\n").trim(), rest };
}
