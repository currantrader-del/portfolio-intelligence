/** @jsxRuntime automatic */
/**
 * The "Share full research" PDF layout for @react-pdf/renderer. Layout only: every word comes from the report.
 * No Node APIs here, so it runs in the browser (pdfBrowser.tsx, what the app uses) and in Node (pdf.tsx, tests).
 * The browser does the drawing because a long report took longer than Netlify allows a request to run.
 *
 * Known engine limits (both crashed or hung the export): no dynamic page-number `render` text, and no
 * `break` on content views. Each major section is its own <Page> instead, which also keeps layout time
 * linear in the length of the research.
 */
import { Document, Font, Link, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/stylesheet";
import type { ReactNode } from "react";
import type { Block, ShareReport } from "./report";

// ---- Fonts ------------------------------------------------------------------------------------
// Inter (SIL Open Font License, public/share-fonts/LICENSE-Inter.txt). The caller says where the files
// are: paths on disk in Node, URLs under /share-fonts in the browser.
export type FontFile = "Inter-Regular.otf" | "Inter-Italic.otf" | "Inter-SemiBold.otf" | "Inter-Bold.otf" | "InterDisplay-Bold.otf";
let fontsFrom: string | null = null;
export function registerShareFonts(src: (file: FontFile) => string) {
  const key = src("Inter-Regular.otf");
  if (fontsFrom === key) return;
  Font.register({ family: "Inter", fonts: [
    { src: src("Inter-Regular.otf"), fontWeight: 400 },
    { src: src("Inter-Italic.otf"), fontWeight: 400, fontStyle: "italic" },
    { src: src("Inter-SemiBold.otf"), fontWeight: 600 },
    { src: src("Inter-Bold.otf"), fontWeight: 700 },
  ] });
  Font.register({ family: "InterDisplay", src: src("InterDisplay-Bold.otf"), fontWeight: 700 });
  Font.registerHyphenationCallback((w) => [w]); // never hyphenate figures or tickers
  fontsFrom = key;
}
const HAS_INTER = true;
const F = { body: { fontFamily: "Inter" }, semi: { fontFamily: "Inter", fontWeight: 600 as const }, bold: { fontFamily: "Inter", fontWeight: 700 as const }, italic: { fontFamily: "Inter", fontStyle: "italic" as const }, display: { fontFamily: "InterDisplay", fontWeight: 700 as const } };

// ---- Palette and styles -----------------------------------------------------------------------
const C = {
  ink: "#16202c", body: "#2b3644", muted: "#6b7585", faint: "#98a1ae", line: "#e2e5ea", zebra: "#f7f8fa",
  navy: "#14243a", accent: "#b5652a", accentSoft: "#f6ebe1", warnBg: "#fdf3e6", warnInk: "#8a4b10", warnBar: "#e0a050", infoBg: "#f0f4f9", infoBar: "#7c95b6",
};
const M = 48; // page side margin

const s = StyleSheet.create({
  page: { paddingTop: 58, paddingBottom: 56, paddingHorizontal: M, ...F.body, fontSize: 9.4, color: C.body, lineHeight: 1.5 },
  header: { position: "absolute", top: 24, left: M, right: M, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: C.faint, letterSpacing: 0.6, textTransform: "uppercase" },
  footer: { position: "absolute", bottom: 24, left: M, right: M, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: C.faint, borderTopWidth: 0.5, borderTopColor: C.line, paddingTop: 6 },

  // Cover
  cover: { padding: 0, ...F.body, fontSize: 9.4, color: C.body, lineHeight: 1.5 },
  band: { backgroundColor: C.navy, paddingHorizontal: M, paddingTop: 54, paddingBottom: 30 },
  bandKicker: { ...F.semi, fontSize: 8, color: "#e9b48a", letterSpacing: 1.6, textTransform: "uppercase", marginBottom: 14 },
  bandTitle: { ...F.display, fontSize: 30, color: "#ffffff", lineHeight: 1.12, marginBottom: 6 },
  bandSub: { fontSize: 10.5, color: "#c3cddb" },
  coverBody: { paddingHorizontal: M, paddingTop: 22, paddingBottom: 56 },
  tiles: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4, marginBottom: 14 },
  tile: { width: "33.333%", paddingHorizontal: 4, marginBottom: 8 },
  tileIn: { borderWidth: 0.6, borderColor: C.line, borderRadius: 5, paddingVertical: 7, paddingHorizontal: 9, minHeight: 46 },
  tileK: { fontSize: 6.8, color: C.muted, letterSpacing: 0.9, textTransform: "uppercase", marginBottom: 3 },
  tileV: { ...F.semi, fontSize: 9.2, color: C.ink, lineHeight: 1.3 },
  headline: { borderLeftWidth: 3, borderLeftColor: C.accent, backgroundColor: C.accentSoft, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 14 },
  headlineK: { fontSize: 6.8, color: C.accent, letterSpacing: 0.9, textTransform: "uppercase", marginBottom: 3, ...F.semi },
  headlineT: { ...F.semi, fontSize: 11.5, color: C.ink, lineHeight: 1.4 },
  tocTitle: { ...F.semi, fontSize: 7.5, color: C.muted, letterSpacing: 1.2, textTransform: "uppercase", marginTop: 4, marginBottom: 6 },
  tocCols: { flexDirection: "row", flexWrap: "wrap" },
  tocItem: { width: "50%", flexDirection: "row", paddingVertical: 3, paddingRight: 10 },
  tocNum: { width: 22, color: C.accent, ...F.semi, fontSize: 8.5 },
  tocText: { flex: 1, fontSize: 8.8, color: C.ink, textDecoration: "none" },

  // Sections
  secHead: { flexDirection: "row", alignItems: "flex-end", marginTop: 6, marginBottom: 12, paddingBottom: 7, borderBottomWidth: 0.8, borderBottomColor: C.line },
  secNum: { ...F.display, fontSize: 22, color: C.accent, width: 40, lineHeight: 1 },
  secTitle: { ...F.display, fontSize: 15, color: C.ink, flex: 1, lineHeight: 1.2 },
  h2: { ...F.semi, fontSize: 10.4, color: C.ink, marginTop: 10, marginBottom: 5 },
  p: { marginBottom: 6 },
  muted: { color: C.muted, fontSize: 8.4 },
  strong: { ...F.semi, fontSize: 11, color: C.ink, lineHeight: 1.4 },
  warn: { color: C.warnInk },
  li: { flexDirection: "row", marginBottom: 3.5 },
  bullet: { width: 13, color: C.accent, ...F.bold },
  liText: { flex: 1 },
  kvRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: C.line, paddingVertical: 4.5 },
  kvKey: { width: "30%", color: C.muted, paddingRight: 10, fontSize: 8.6 },
  kvVal: { width: "70%", color: C.ink },
  table: { marginBottom: 10, marginTop: 3, borderWidth: 0.5, borderColor: C.line, borderRadius: 3 },
  thRow: { flexDirection: "row", backgroundColor: C.navy, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  th: { ...F.semi, fontSize: 7.4, color: "#ffffff", paddingVertical: 4.5, paddingHorizontal: 5, letterSpacing: 0.3 },
  tr: { flexDirection: "row", borderTopWidth: 0.5, borderTopColor: C.line },
  td: { fontSize: 8, paddingVertical: 4, paddingHorizontal: 5, lineHeight: 1.4 },
  card: { borderWidth: 0.5, borderColor: C.line, borderRadius: 4, paddingVertical: 6, paddingHorizontal: 8, marginBottom: 5 },
  cardK: { width: 72, fontSize: 7.2, color: C.muted, letterSpacing: 0.4, textTransform: "uppercase", paddingTop: 1 },
  box: { borderLeftWidth: 3, paddingVertical: 8, paddingHorizontal: 11, marginBottom: 10, marginTop: 3 },
  boxTitle: { ...F.semi, marginBottom: 4, color: C.ink },
  notice: { backgroundColor: C.warnBg, borderLeftWidth: 3, borderLeftColor: C.warnBar, paddingVertical: 8, paddingHorizontal: 11, marginBottom: 14 },
  link: { color: C.accent, textDecoration: "none" },
});

/** Characters the font cannot draw are replaced with plain equivalents so nothing renders as a box. */
const MAP: Record<string, string> = {
  "→": "->", "←": "<-", "↑": "up", "↓": "down", "≈": "~", "≥": ">=", "≤": "<=", "≠": "!=", "−": "-", "‑": "-", "‐": "-", "✓": "OK", "✔": "OK", "✕": "X", "✗": "X", "×": "x",
  "∼": "~", "√": "sqrt", "Δ": "change in ", "∆": "change in ", "₂": "2", "≫": ">>", "≪": "<<", " ": " ", " ": " ", " ": " ", "​": "", "★": "*", "⚠": "!", "∞": "infinity",
};
const INTER_OK = /[←-↓−≈≠≤≥×Δ∆∞‑‐]/;
export function pdfSafe(t: string): string {
  return t.replace(/[^\x00-\xff–—‘’“”•…€™‰]/g, (ch) => (HAS_INTER && INTER_OK.test(ch) ? ch : MAP[ch] ?? "?"));
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
        : <Text key={i} style={g.bold ? { ...F.semi, color: C.ink } : g.italic ? F.italic : undefined}>{pdfSafe(g.text)}</Text>)}
    </Text>
  );
}

function List({ items, ordered }: { items: string[]; ordered?: boolean }) {
  return <View style={{ marginBottom: 7 }}>{items.map((it, i) => <View key={i} style={s.li}><Text style={s.bullet}>{ordered ? `${i + 1}.` : "•"}</Text><Rich text={it} style={s.liText} /></View>)}</View>;
}

/**
 * Tables with short cells render as rows. Rows with long cells render as stacked label/value cards,
 * because a flex row taller than a page breaks the PDF layout engine.
 */
function Table({ head, rows, widths }: { head: string[]; rows: string[][]; widths?: number[] }) {
  const w = widths ?? head.map(() => 100 / head.length);
  const long = rows.some((r) => r.some((c) => c.length > 280) || r.join("").length > 600);
  if (long) {
    return (
      <View style={{ marginBottom: 10, marginTop: 3 }}>
        {rows.map((r, k) => (
          <View key={k} style={s.card}>
            {r.map((c, i) => c.trim() ? (
              <View key={i} style={{ flexDirection: "row", marginBottom: 2 }}>
                <Text style={s.cardK}>{pdfSafe(head[i] ?? "")}</Text>
                <View style={{ flex: 1 }}>{c.split("\n").map((line, j) => <Rich key={j} text={line} style={{ fontSize: 8.4, ...(i === 0 ? { ...F.semi, color: C.ink } : {}) }} />)}</View>
              </View>
            ) : null)}
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={s.table}>
      <View style={s.thRow}>{head.map((h, i) => <Text key={i} style={[s.th, { width: `${w[i]}%` }]}>{pdfSafe(h)}</Text>)}</View>
      {rows.map((r, k) => (
        <View key={k} style={[s.tr, k % 2 === 1 ? { backgroundColor: C.zebra } : {}]} wrap={false}>
          {r.map((c, i) => <View key={i} style={{ width: `${w[i] ?? 10}%` }}>{c.split("\n").map((line, j) => <Rich key={j} text={line} style={[s.td, i === 0 ? { color: C.ink } : {}]} />)}</View>)}
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
    if (h) { flushPara(); flushList(); out.push(<Rich key={out.length} text={h[1].replace(/\*\*/g, "")} style={s.h2} />); continue; }
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
    case "kv": return <View style={{ marginBottom: 10, borderTopWidth: 0.5, borderTopColor: C.line }}>{b.rows.map(([k, v], i) => <View key={i} style={s.kvRow}><Text style={s.kvKey}>{pdfSafe(k)}</Text><Rich text={v} style={s.kvVal} /></View>)}</View>;
    case "table": return <Table head={b.head} rows={b.rows} widths={b.widths} />;
    case "box": return (
      <View wrap={b.title.length + b.items.join("").length > 1500} style={[s.box, b.tone === "warn" ? { backgroundColor: C.warnBg, borderLeftColor: C.warnBar } : { backgroundColor: C.infoBg, borderLeftColor: C.infoBar }]}>
        <Text style={[s.boxTitle, b.tone === "warn" ? s.warn : {}]}>{pdfSafe(b.title)}</Text>
        <List items={b.items} />
      </View>
    );
  }
}

/** Sections that share a page with the one before them; every other section starts a new page. */
const SAME_PAGE = new Set(["status", "conclusion", "valuation", "validation", "sources", "redactions"]);

const two = (n: number) => String(n).padStart(2, "0");

export function ShareDocument({ r }: { r: ShareReport }) {
  const gen = new Date(r.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  const num = new Map(r.sections.map((sec, i) => [sec.id, i + 1]));
  const groups: ShareReport["sections"][] = [];
  for (const sec of r.sections) {
    if (groups.length && SAME_PAGE.has(sec.id)) groups[groups.length - 1].push(sec);
    else groups.push([sec]);
  }
  const headline = r.sections.find((x) => x.id === "conclusion")?.blocks.find((b): b is Extract<Block, { t: "p" }> => b.t === "p" && b.tone === "strong")?.text ?? null;
  const fact = (k: string) => r.facts.find((f) => f[0] === k)?.[1] ?? "n/a";
  const tiles: [string, string][] = [["Research date", fact("Research date")], ["Reference price", fact("Reference price")], ["Confidence", fact("Confidence")], ["Approval", fact("Approval")], ["Completeness", fact("Completeness")], ["Classification", fact("Classification")]];
  const footer = (
    <View style={s.footer} fixed>
      <Text>Exported {gen} from saved research · Personal portfolio details removed · Not personalized investment advice</Text>
      <Text>{pdfSafe(r.symbol)}</Text>
    </View>
  );
  const header = <View style={s.header} fixed><Text>{pdfSafe(r.title)}</Text><Text>Company research</Text></View>;
  const section = (sec: ShareReport["sections"][number]) => (
    <View key={sec.id} id={sec.id}>
      <View style={s.secHead}><Text style={s.secNum}>{two(num.get(sec.id) ?? 0)}</Text><Text style={s.secTitle}>{pdfSafe(sec.title)}</Text></View>
      {sec.blocks.map((b, j) => <BlockView key={j} b={b} />)}
    </View>
  );

  return (
    <Document title={pdfSafe(`${r.title} research`)} author="Portfolio Intelligence" subject={pdfSafe(r.subtitle)} creator="Portfolio Intelligence" producer="Portfolio Intelligence">
      {/* Cover: title band, key facts, headline, status notices and contents. */}
      <Page size="LETTER" style={s.cover}>
        <View style={s.band}>
          <Text style={s.bandKicker}>Company research · {pdfSafe(fact("Research type"))}</Text>
          <Text style={s.bandTitle}>{pdfSafe(r.name ?? r.symbol)}</Text>
          <Text style={s.bandSub}>{pdfSafe(`${r.symbol} · ${fact("Research date")}`)}</Text>
        </View>
        <View style={s.coverBody}>
          <View style={s.tiles}>{tiles.map(([k, v]) => <View key={k} style={s.tile}><View style={s.tileIn}><Text style={s.tileK}>{pdfSafe(k)}</Text><Text style={s.tileV}>{pdfSafe(v)}</Text></View></View>)}</View>
          {headline && <View style={s.headline}><Text style={s.headlineK}>Conclusion</Text><Rich text={headline} style={s.headlineT} /></View>}
          {r.notices.length > 0 && <View style={s.notice}>{r.notices.map((n, i) => <View key={i} style={s.li}><Text style={[s.bullet, { color: C.warnBar }]}>•</Text><Text style={[s.liText, s.warn, { fontSize: 8.6 }]}>{pdfSafe(n)}</Text></View>)}</View>}
          <Text style={s.tocTitle}>Contents</Text>
          <View style={s.tocCols}>{r.sections.map((sec, i) => <View key={sec.id} style={s.tocItem}><Text style={s.tocNum}>{two(i + 1)}</Text><Link src={`#${sec.id}`} style={s.tocText}>{pdfSafe(sec.title)}</Link></View>)}</View>
        </View>
        {footer}
      </Page>
      {groups.map((g, gi) => (
        <Page key={gi} size="LETTER" style={s.page} wrap>
          {header}
          {footer}
          {g.map(section)}
        </Page>
      ))}
    </Document>
  );
}
