/**
 * Renders a ShareReport as a PDF with @react-pdf/renderer (server side, no browser needed).
 * Layout only: every word comes from the report.
 */
import { Document, Link, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/stylesheet";
import type { ReactNode } from "react";
import type { Block, ShareReport } from "./report";

const C = { ink: "#1d1f23", muted: "#5d6470", line: "#d9dce1", accent: "#8a4b22", warnBg: "#fbf1e4", warnInk: "#7a4510", infoBg: "#eef1f5", head: "#f3f4f6" };

const s = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 54, paddingHorizontal: 50, fontFamily: "Helvetica", fontSize: 9.5, color: C.ink, lineHeight: 1.42 },
  header: { position: "absolute", top: 22, left: 50, right: 50, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: C.muted, borderBottomWidth: 0.5, borderBottomColor: C.line, paddingBottom: 4 },
  footer: { position: "absolute", bottom: 22, left: 50, right: 50, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: C.muted, borderTopWidth: 0.5, borderTopColor: C.line, paddingTop: 4 },
  kicker: { fontSize: 8.5, color: C.accent, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 },
  title: { fontSize: 22, fontFamily: "Helvetica-Bold", lineHeight: 1.2, marginBottom: 6 },
  subtitle: { fontSize: 10.5, color: C.muted, marginBottom: 14 },
  h1: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 16, marginBottom: 8, color: C.ink, borderBottomWidth: 1, borderBottomColor: C.accent, paddingBottom: 3 },
  h2: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginTop: 8, marginBottom: 4 },
  p: { marginBottom: 6 },
  muted: { color: C.muted, fontSize: 8.5 },
  strong: { fontFamily: "Helvetica-Bold", fontSize: 10.5 },
  warn: { color: C.warnInk },
  li: { flexDirection: "row", marginBottom: 3 },
  bullet: { width: 12, color: C.muted },
  liText: { flex: 1 },
  kvRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: C.line, paddingVertical: 3 },
  kvKey: { width: "30%", color: C.muted, paddingRight: 8 },
  kvVal: { width: "70%" },
  table: { borderTopWidth: 0.5, borderTopColor: C.line, marginBottom: 8, marginTop: 2 },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: C.line },
  th: { fontFamily: "Helvetica-Bold", fontSize: 8, backgroundColor: C.head, paddingVertical: 3, paddingHorizontal: 3 },
  td: { fontSize: 8, paddingVertical: 3, paddingHorizontal: 3 },
  box: { borderRadius: 4, padding: 8, marginBottom: 8, marginTop: 2 },
  boxTitle: { fontFamily: "Helvetica-Bold", marginBottom: 3 },
  notice: { backgroundColor: C.warnBg, color: C.warnInk, borderRadius: 4, padding: 8, marginBottom: 10 },
  toc: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2, borderBottomWidth: 0.3, borderBottomColor: C.line },
  link: { color: C.accent, textDecoration: "none" },
});

/**
 * The PDF's built-in Helvetica covers Windows-1252 only. Characters outside it are replaced with plain
 * equivalents so nothing renders as a blank box.
 */
const MAP: Record<string, string> = {
  "→": "->", "←": "<-", "↑": "up", "↓": "down", "≈": "~", "≥": ">=", "≤": "<=", "≠": "!=", "−": "-", "‑": "-", "‐": "-", "✓": "OK", "✔": "OK", "✕": "X", "✗": "X", "×": "x",
  "∼": "~", "√": "sqrt", "Δ": "change in ", "∆": "change in ", "₂": "2", "≫": ">>", "≪": "<<", " ": " ", " ": " ", " ": " ", "​": "", "★": "*", "⚠": "!", "∞": "infinity",
};
export function pdfSafe(t: string): string {
  return t.replace(/[^\x00-\xff–—‘’“”•…€™‰]/g, (ch) => MAP[ch] ?? "?");
}

type Seg = { text: string; bold?: boolean; italic?: boolean; href?: string };
/** **bold**, *italic*, [label](url) and bare URLs. */
function inline(text: string): Seg[] {
  const out: Seg[] = [];
  const re = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)<>\]]+[^\s)<>\].,;:!?'"]|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const t = m[0];
    const link = t.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) out.push({ text: link[1], href: link[2] });
    else if (/^https?:\/\//.test(t)) out.push({ text: t, href: t });
    else if (t.startsWith("**")) out.push({ text: t.slice(2, -2), bold: true });
    else out.push({ text: t.slice(1, -1), italic: true });
    last = m.index + t.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function Rich({ text, style }: { text: string; style?: Style | Style[] }) {
  const segs = inline(text);
  return (
    <Text style={style}>
      {segs.map((g, i) => g.href
        ? <Link key={i} src={g.href} style={s.link}>{pdfSafe(g.text)}</Link>
        : <Text key={i} style={g.bold ? { fontFamily: "Helvetica-Bold" } : g.italic ? { fontFamily: "Helvetica-Oblique" } : undefined}>{pdfSafe(g.text)}</Text>)}
    </Text>
  );
}

function List({ items, ordered }: { items: string[]; ordered?: boolean }) {
  return <View style={{ marginBottom: 6 }}>{items.map((it, i) => <View key={i} style={s.li}><Text style={s.bullet}>{ordered ? `${i + 1}.` : "•"}</Text><Rich text={it} style={s.liText} /></View>)}</View>;
}

function Table({ head, rows, widths }: { head: string[]; rows: string[][]; widths?: number[] }) {
  const w = widths ?? head.map(() => 100 / head.length);
  return (
    <View style={s.table}>
      <View style={s.tr} fixed={false}>{head.map((h, i) => <Text key={i} style={[s.th, { width: `${w[i]}%` }]}>{pdfSafe(h)}</Text>)}</View>
      {rows.map((r, k) => (
        <View key={k} style={s.tr}>
          {r.map((c, i) => <View key={i} style={{ width: `${w[i] ?? 10}%` }}>{c.split("\n").map((line, j) => <Rich key={j} text={line} style={s.td} />)}</View>)}
        </View>
      ))}
    </View>
  );
}

/** Markdown from a phase body: headings, paragraphs, bullet and numbered lists, tables. */
function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;
  const flushPara = () => { if (para.length) { out.push(<Rich key={out.length} text={para.join(" ")} style={s.p} />); para = []; } };
  const flushList = () => { if (list) { out.push(<List key={out.length} items={list.items} ordered={list.ordered} />); list = null; } };
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    const n = head.length;
    out.push(<Table key={out.length} head={head} rows={rows.map((r) => Array.from({ length: n }, (_, i) => r[i] ?? ""))} />);
    table = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      (table ??= []).push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      continue;
    }
    flushTable();
    const h = line.match(/^#{1,4}\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim() || /^\s*(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); flushList(); continue; }
    if (h) { flushPara(); flushList(); out.push(<Rich key={out.length} text={h[1]} style={s.h2} />); continue; }
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
  flushPara(); flushList(); flushTable();
  return <View>{out}</View>;
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "p": return <Rich text={b.text} style={[s.p, ...(b.tone === "muted" ? [s.muted] : b.tone === "warn" ? [s.warn] : b.tone === "strong" ? [s.strong] : [])]} />;
    case "md": return <Markdown text={b.text} />;
    case "h": return <Text style={s.h2}>{pdfSafe(b.text)}</Text>;
    case "list": return <List items={b.items} ordered={b.ordered} />;
    case "kv": return <View style={{ marginBottom: 8 }}>{b.rows.map(([k, v], i) => <View key={i} style={s.kvRow}><Text style={s.kvKey}>{pdfSafe(k)}</Text><Rich text={v} style={s.kvVal} /></View>)}</View>;
    case "table": return <Table head={b.head} rows={b.rows} widths={b.widths} />;
    case "box": return (
      <View style={[s.box, { backgroundColor: b.tone === "warn" ? C.warnBg : C.infoBg }]}>
        <Text style={[s.boxTitle, b.tone === "warn" ? s.warn : {}]}>{pdfSafe(b.title)}</Text>
        <List items={b.items} />
      </View>
    );
  }
}

export function ShareDocument({ r }: { r: ShareReport }) {
  const gen = new Date(r.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <Document title={pdfSafe(`${r.title} research`)} author="Portfolio Intelligence" subject={pdfSafe(r.subtitle)} creator="Portfolio Intelligence" producer="Portfolio Intelligence">
      <Page size="LETTER" style={s.page} wrap>
        <View style={s.header} fixed><Text>{pdfSafe(r.title)} · company research</Text><Text>Personal portfolio details removed</Text></View>
        <View style={s.footer} fixed>
          <Text>Exported {gen} from saved research. Not personalized investment advice.</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
        <Text style={s.kicker}>Company research · full investigation</Text>
        <Text style={s.title}>{pdfSafe(r.title)}</Text>
        <Text style={s.subtitle}>{pdfSafe(r.subtitle)}</Text>
        {r.notices.length > 0 && <View style={s.notice}>{r.notices.map((n, i) => <Text key={i} style={{ marginBottom: 2 }}>{pdfSafe(n)}</Text>)}</View>}
        <Text style={s.h2}>Contents</Text>
        <View style={{ marginBottom: 12 }}>{r.sections.map((sec, i) => <View key={sec.id} style={s.toc}><Link src={`#${sec.id}`} style={{ color: C.ink, textDecoration: "none" }}>{pdfSafe(`${i + 1}. ${sec.title}`)}</Link></View>)}</View>
        {r.sections.map((sec, i) => (
          <View key={sec.id} id={sec.id}>
            <Text style={s.h1}>{pdfSafe(`${i + 1}. ${sec.title}`)}</Text>
            {sec.blocks.map((b, j) => <BlockView key={j} b={b} />)}
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function renderSharePdf(r: ShareReport): Promise<Buffer> {
  return renderToBuffer(<ShareDocument r={r} />);
}
