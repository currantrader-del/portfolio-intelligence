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
import type { Block, Chart, Entry, ShareReport, Zone } from "./report";

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
  // Never hyphenate words, figures or tickers. Only a run long enough to overflow the line (a URL, a code
  // string) may break, in pieces, so it wraps instead of running off the page.
  Font.registerHyphenationCallback((w) => (w.length > 30 ? w.match(/.{1,16}/g) ?? [w] : [w]));
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
  band: { backgroundColor: C.navy, paddingHorizontal: M, paddingTop: 40, paddingBottom: 24 },
  bandKicker: { ...F.semi, fontSize: 8, color: "#e9b48a", letterSpacing: 1.6, textTransform: "uppercase", marginBottom: 14 },
  bandTitle: { ...F.display, fontSize: 30, color: "#ffffff", lineHeight: 1.12, marginBottom: 6 },
  bandSub: { fontSize: 10.5, color: "#c3cddb" },
  coverBody: { paddingHorizontal: M, paddingTop: 22, paddingBottom: 40 },
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

  // Summary page
  verdict: { flexDirection: "row", alignItems: "flex-start", borderWidth: 0.6, borderColor: C.line, borderRadius: 6, padding: 12, marginBottom: 12, backgroundColor: C.accentSoft },
  pill: { ...F.bold, fontSize: 8, color: "#ffffff", backgroundColor: C.accent, borderRadius: 3, paddingVertical: 3, paddingHorizontal: 7, letterSpacing: 0.6, textTransform: "uppercase" },
  stats: { flexDirection: "row", marginHorizontal: -4, marginBottom: 14 },
  stat: { flex: 1, marginHorizontal: 4, borderWidth: 0.6, borderColor: C.line, borderRadius: 5, paddingVertical: 8, paddingHorizontal: 9 },
  statK: { fontSize: 6.6, color: C.muted, letterSpacing: 0.9, textTransform: "uppercase", marginBottom: 3 },
  statV: { ...F.display, fontSize: 15, color: C.ink, lineHeight: 1.15 },
  statSub: { fontSize: 7.4, color: C.muted, marginTop: 2, lineHeight: 1.3 },
  chartTitle: { ...F.semi, fontSize: 9.6, color: C.ink, marginBottom: 2 },
  chartNote: { fontSize: 7.4, color: C.muted, marginBottom: 6 },
  chart: { marginBottom: 14 },

  // Entries (findings, questions, challenges)
  entry: { paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: C.line },
  entryTitle: { ...F.semi, fontSize: 8.6, color: C.ink, lineHeight: 1.4 },
  entryMeta: { fontSize: 7.2, color: C.muted, marginTop: 1, marginBottom: 2, letterSpacing: 0.2 },
  entryLine: { fontSize: 8.2, lineHeight: 1.45, marginTop: 1.5 },
  entryLabel: { ...F.semi, color: C.muted },
  part: { ...F.semi, fontSize: 7.5, color: C.accent, letterSpacing: 1.6, textTransform: "uppercase", marginBottom: 4 },
});

/** Characters the font cannot draw are replaced with plain equivalents so nothing renders as a box. */
const MAP: Record<string, string> = {
  "→": "->", "←": "<-", "↑": "up", "↓": "down", "≈": "~", "≥": ">=", "≤": "<=", "≠": "!=", "−": "-", "‑": "-", "‐": "-", "✓": "OK", "✔": "OK", "✕": "X", "✗": "X", "×": "x",
  "∼": "~", "√": "sqrt", "Δ": "change in ", "∆": "change in ", "₂": "2", "≫": ">>", "≪": "<<", " ": " ", " ": " ", " ": " ", "​": "", "★": "*", "⚠": "!", "∞": "infinity",
};
const INTER_OK = /[←-↓−≈≠≤≥×Δ∆∞‑‐]/;
export function pdfSafe(t: string): string {
  // Non-breaking and thin spaces become plain spaces first. Kept as they were, a line of research joined
  // by them was one unbreakable "word" and got cut mid-word at the margin.
  return t.replace(/[  -   ]/g, " ").replace(/[­​-‍﻿]/g, "").replace(/[^\x00-\xff–—‘’“”•…€™‰]/g, (ch) => (HAS_INTER && INTER_OK.test(ch) ? ch : MAP[ch] ?? "?"));
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

function Rich({ text, style, label }: { text: string; style?: Style | Style[]; label?: string }) {
  const segs = inline(text);
  return (
    <Text style={style}>
      {label ? <Text style={s.entryLabel}>{pdfSafe(label)}  </Text> : null}
      {segs.map((g, i) => g.href
        ? <Link key={i} src={g.href} style={s.link}>{pdfSafe(g.text)}</Link>
        : <Text key={i} style={g.bold ? { ...F.semi, color: C.ink } : g.italic ? F.italic : undefined}>{pdfSafe(g.text)}</Text>)}
    </Text>
  );
}

function List({ items, ordered }: { items: string[]; ordered?: boolean }) {
  const shown = items.filter((it) => it.trim());
  // Short items never split from their bullet across a page break.
  return <View style={{ marginBottom: 7 }}>{shown.map((it, i) => <View key={i} style={s.li} wrap={it.length > 700}><Text style={s.bullet}>{ordered ? `${i + 1}.` : "•"}</Text><Rich text={it} style={s.liText} /></View>)}</View>;
}

function Entries({ items }: { items: Entry[] }) {
  return (
    <View style={{ marginBottom: 10, borderTopWidth: 0.5, borderTopColor: C.line }}>
      {items.map((e, k) => {
        const size = e.title.length + e.lines.reduce((a, l) => a + l[0].length + l[1].length, 0);
        return (
          <View key={k} style={[s.entry, e.tone === "muted" ? { opacity: 0.6 } : {}]} wrap={size > 1100}>
            <Rich text={e.title} style={[s.entryTitle, e.tone === "warn" ? { color: C.warnInk } : {}]} />
            {e.meta ? <Text style={s.entryMeta}>{pdfSafe(e.meta)}</Text> : null}
            {e.lines.map(([label, text], i) => text.split("\n").map((line, j) => <Rich key={`${i}-${j}`} label={j === 0 ? label : undefined} text={line} style={s.entryLine} />))}
          </View>
        );
      })}
    </View>
  );
}

/**
 * Tables with short cells render as rows. Rows with long cells render as entries (first column as the
 * title, the rest as labeled lines), because a flex row taller than a page breaks the PDF layout engine.
 */
function Table({ head, rows, widths }: { head: string[]; rows: string[][]; widths?: number[] }) {
  const w = widths ?? head.map(() => 100 / head.length);
  const long = rows.some((r) => r.some((c) => c.length > 280) || r.join("").length > 600);
  if (long) return <Entries items={rows.map((r) => ({ title: r[0] ?? "", lines: r.slice(1).map((c, i) => [head[i + 1] ?? "", c] as [string, string]).filter((l) => l[1].trim()) }))} />;
  const row = (r: string[], k: number) => (
    <View key={k} style={[s.tr, k % 2 === 1 ? { backgroundColor: C.zebra } : {}]} wrap={false}>
      {r.map((c, i) => <View key={i} style={{ width: `${w[i] ?? 10}%` }}>{c.split("\n").map((line, j) => <Rich key={j} text={line} style={[s.td, i === 0 ? { color: C.ink } : {}, j > 0 ? { paddingTop: 0, color: C.muted, fontSize: 7.4 } : {}]} />)}</View>)}
    </View>
  );
  // The header row always travels with the first two rows, so a table never starts with a lone header.
  return (
    <View style={s.table}>
      <View wrap={false}>
        <View style={s.thRow}>{head.map((h, i) => <Text key={i} style={[s.th, { width: `${w[i]}%` }]}>{pdfSafe(h)}</Text>)}</View>
        {rows.slice(0, 2).map(row)}
      </View>
      {rows.slice(2).map((r, k) => row(r, k + 2))}
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
    if (h) { flushPara(); flushList(); out.push(<Text key={out.length} style={s.h2} minPresenceAhead={40}>{pdfSafe(h[1].replace(/\*\*/g, ""))}</Text>); continue; }
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

// ---- Charts (plain shapes; every number is a saved one) ------------------------------------------
const W = 612 - 2 * M; // content width in points
const SC: Record<string, string> = { bear: "#c4572f", base: "#5f7ea6", bull: "#3d8b5a", weighted: C.navy };
const ZONE: Record<Zone["tone"], { bar: string }> = { good: { bar: "#9fd0ae" }, wait: { bar: "#ecc77f" }, bad: { bar: "#e9a493" } };
const cap = (x: string) => `${x[0]?.toUpperCase() ?? ""}${x.slice(1)}`;
const dollars = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2, minimumFractionDigits: n >= 100 ? 0 : 2 })}`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
const clampX = (x: number, w: number, total: number) => Math.max(0, Math.min(total - w, x - w / 2));

function ScenarioChart({ c }: { c: Extract<Chart, { kind: "scenarios" }> }) {
  const labelW = 86, valueW = 112, trackW = W - labelW - valueW;
  const rows = [...c.rows.map((r) => ({ key: r.name, label: `${cap(r.name)}  ${Math.round(r.probability * 100)}%`, value: r.value })), ...(c.weighted !== null ? [{ key: "weighted", label: "Weighted", value: c.weighted }] : [])];
  const max = Math.max(...rows.map((r) => r.value), c.price ?? 0) * 1.08 || 1;
  const px = c.price !== null ? (c.price / max) * trackW : null;
  return (
    <View style={s.chart} wrap={false}>
      <Text style={s.chartTitle}>Value per share in each scenario</Text>
      <Text style={s.chartNote}>Bars are the app-computed value per share at the horizon; the dark line is the reference price. The percentage after each value is the change from that price.</Text>
      {px !== null && (
        <View style={{ flexDirection: "row", height: 12 }}>
          <View style={{ width: labelW }} />
          <View style={{ width: trackW, position: "relative" }}><Text style={{ position: "absolute", left: clampX(px, 90, trackW), width: 90, textAlign: "center", fontSize: 7, color: C.ink, ...F.semi }}>Price {dollars(c.price!)}</Text></View>
        </View>
      )}
      {rows.map((r) => (
        <View key={r.key} style={{ flexDirection: "row", alignItems: "center", height: 22, borderTopWidth: r.key === "weighted" ? 0.5 : 0, borderTopColor: C.line }}>
          <Text style={{ width: labelW, fontSize: 8.4, color: C.ink, ...(r.key === "weighted" ? F.semi : {}) }}>{r.label}</Text>
          <View style={{ width: trackW, height: 22, position: "relative" }}>
            <View style={{ position: "absolute", left: 0, top: 5, height: 12, width: Math.max(1.5, (Math.max(0, r.value) / max) * trackW), backgroundColor: SC[r.key] ?? C.navy, borderRadius: 2 }} />
            {px !== null && <View style={{ position: "absolute", left: px - 0.6, top: 0, width: 1.2, height: 22, backgroundColor: C.ink }} />}
          </View>
          <Text style={{ width: valueW, paddingLeft: 8, fontSize: 8.6, color: C.ink, ...F.semi }}>
            {dollars(r.value)}
            {c.price ? <Text style={{ ...F.body, color: r.value >= c.price ? "#2f7a4b" : "#b2472a" }}>{`   ${signed(r.value / c.price - 1)}`}</Text> : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ZonesChart({ c, full }: { c: Extract<Chart, { kind: "zones" }>; full?: boolean }) {
  const bounds = c.zones.flatMap((z) => [z.lo, z.hi]).filter((x): x is number => x !== null);
  if (c.price !== null) bounds.push(c.price);
  const lo = Math.min(...bounds) * 0.8, hi = Math.max(...bounds) * 1.2;
  const x = (v: number) => ((v - lo) / (hi - lo)) * W;
  const ticks = [...new Set(c.zones.flatMap((z) => [z.lo, z.hi]).filter((v): v is number => v !== null))];
  return (
    <View style={s.chart} wrap={false}>
      {full && <Text style={s.chartTitle}>Price framework</Text>}
      {full && <Text style={s.chartNote}>What the research says it would do at each price. The marker is the reference price.</Text>}
      {c.price !== null && <View style={{ height: 12, position: "relative" }}><Text style={{ position: "absolute", left: clampX(x(c.price), 90, W), width: 90, textAlign: "center", fontSize: 7, color: C.ink, ...F.semi }}>Price {dollars(c.price)}</Text></View>}
      <View style={{ height: 20, position: "relative" }}>
        {c.zones.map((z, i) => {
          const a = x(z.lo ?? lo), b = x(z.hi ?? hi);
          return <View key={i} style={{ position: "absolute", left: a, width: Math.max(1, b - a), top: 0, height: 20, backgroundColor: ZONE[z.tone].bar, borderRightWidth: i < c.zones.length - 1 ? 1 : 0, borderRightColor: "#ffffff" }} />;
        })}
        {c.price !== null && <View style={{ position: "absolute", left: x(c.price) - 1, top: -3, width: 2, height: 26, backgroundColor: C.ink }} />}
      </View>
      <View style={{ height: 12, position: "relative", marginBottom: full ? 6 : 0 }}>
        {ticks.map((t) => <Text key={t} style={{ position: "absolute", left: clampX(x(t), 50, W), width: 50, top: 2, textAlign: "center", fontSize: 7, color: C.muted }}>{dollars(t)}</Text>)}
      </View>
      {full && c.zones.map((z, i) => (
        <View key={i} style={{ flexDirection: "row", marginBottom: 3 }}>
          <View style={{ width: 8, height: 8, marginTop: 2.5, marginRight: 6, backgroundColor: ZONE[z.tone].bar }} />
          <Text style={{ width: 66, fontSize: 8.4, color: C.ink, ...F.semi }}>{pdfSafe(z.label)}</Text>
          <Rich text={z.action} style={{ flex: 1, fontSize: 8.4 }} />
        </View>
      ))}
    </View>
  );
}

function TornadoChart({ c }: { c: Extract<Chart, { kind: "tornado" }> }) {
  const labelW = 196, valueW = 96, trackW = W - labelW - valueW, mid = trackW / 2;
  const rows = [...c.rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const max = Math.max(...rows.map((r) => Math.abs(r.delta))) || 1;
  return (
    <View style={s.chart} wrap={false}>
      <Text style={s.chartNote}>How far one change moves the probability-weighted value ({dollars(c.base)}), largest first.</Text>
      {rows.map((r, i) => {
        const w = (Math.abs(r.delta) / max) * (mid - 4);
        return (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", height: 17 }}>
            <Text style={{ width: labelW, fontSize: 7.8, color: C.ink, paddingRight: 6 }}>{pdfSafe(r.label)}</Text>
            <View style={{ width: trackW, height: 17, position: "relative" }}>
              <View style={{ position: "absolute", left: mid - 0.4, top: 0, width: 0.8, height: 17, backgroundColor: C.faint }} />
              <View style={{ position: "absolute", top: 4, height: 9, left: r.delta < 0 ? mid - w : mid, width: Math.max(1, w), backgroundColor: r.delta < 0 ? SC.bear : SC.bull, borderRadius: 1.5 }} />
            </View>
            <Text style={{ width: valueW, paddingLeft: 8, fontSize: 7.8, color: C.ink }}>{`${r.delta >= 0 ? "+" : "-"}$${Math.abs(r.delta).toFixed(2)}  `}<Text style={{ color: C.muted }}>{dollars(r.weighted)}</Text></Text>
          </View>
        );
      })}
    </View>
  );
}

function ChartView({ c, full }: { c: Chart; full?: boolean }) {
  if (c.kind === "scenarios") return <ScenarioChart c={c} />;
  if (c.kind === "zones") return <ZonesChart c={c} full={full} />;
  return <TornadoChart c={c} />;
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "p": return <Rich text={b.text} style={[s.p, ...(b.tone === "muted" ? [s.muted] : b.tone === "warn" ? [s.warn] : b.tone === "strong" ? [s.strong] : [])]} />;
    case "md": return <Markdown text={b.text} />;
    case "h": return <Text style={s.h2} minPresenceAhead={40}>{pdfSafe(b.text)}</Text>;
    case "list": return <List items={b.items} ordered={b.ordered} />;
    case "kv": return <View style={{ marginBottom: 10, borderTopWidth: 0.5, borderTopColor: C.line }}>{b.rows.map(([k, v], i) => <View key={i} style={s.kvRow} wrap={v.length > 900}><Text style={s.kvKey}>{pdfSafe(k)}</Text><Rich text={v} style={s.kvVal} /></View>)}</View>;
    case "table": return <Table head={b.head} rows={b.rows} widths={b.widths} />;
    case "entries": return <Entries items={b.items} />;
    case "chart": return <ChartView c={b.chart} />;
    case "box": return (
      <View wrap={b.title.length + b.items.join("").length > 1200} style={[s.box, b.tone === "warn" ? { backgroundColor: C.warnBg, borderLeftColor: C.warnBar } : { backgroundColor: C.infoBg, borderLeftColor: C.infoBar }]}>
        <Text style={[s.boxTitle, b.tone === "warn" ? s.warn : {}]}>{pdfSafe(b.title)}</Text>
        <List items={b.items} />
      </View>
    );
  }
}

/** Rough size of a block, to decide whether it can be kept on one page with the heading above it. */
function small(b: Block | undefined): boolean {
  if (!b) return false;
  switch (b.t) {
    case "p": case "h": return b.text.length < 900;
    case "list": return b.items.join("").length < 900;
    case "kv": return b.rows.length <= 8 && b.rows.flat().join("").length < 1200;
    case "table": return b.rows.length <= 10 && b.rows.flat().join("").length < 1500;
    case "box": return b.items.join("").length < 900;
    case "chart": return true;
    case "entries": return b.items.length <= 2;
    case "md": return b.text.length < 700;
  }
}

/** How many short opening blocks (up to two, no headings) go with a section title. */
function lead(blocks: Block[]): number {
  let n = 0;
  while (n < 2 && blocks[n] && blocks[n].t !== "h" && small(blocks[n])) n++;
  return n;
}

/** Headings stay on the same page as what follows them (react-pdf's minPresenceAhead is not reliable). */
function keepWithNext(blocks: Block[]): ReactNode[] {
  const out: ReactNode[] = [];
  for (let j = 0; j < blocks.length; j++) {
    const b = blocks[j];
    if (b.t === "h" && small(blocks[j + 1])) {
      // A heading followed by a short note and a chart or table: keep all three together when they are small.
      const third = blocks[j + 1]?.t === "p" && small(blocks[j + 2]) && blocks[j + 2]?.t !== "h" ? 3 : 2;
      out.push(<View key={j} wrap={false}>{blocks.slice(j, j + third).map((x, k) => <BlockView key={k} b={x} />)}</View>);
      j += third - 1;
    } else out.push(<BlockView key={j} b={b} />);
  }
  return out;
}

/** Sections that begin a new page: the conclusion, the phases and the appendix. Everything else flows on. */
const NEW_PAGE = new Set(["conclusion", "phase-1"]);

export function ShareDocument({ r }: { r: ShareReport }) {
  const gen = new Date(r.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  const main = r.sections.filter((x) => !x.appendix);
  const appx = r.sections.filter((x) => x.appendix);
  const label = new Map<string, string>([...main.map((x, i) => [x.id, String(i + 1).padStart(2, "0")] as const), ...appx.map((x, i) => [x.id, String.fromCharCode(65 + i)] as const)]);
  const groups: ShareReport["sections"][] = [];
  let inAppendix = false;
  for (const sec of r.sections) {
    const starts = !groups.length || NEW_PAGE.has(sec.id) || (sec.appendix && !inAppendix);
    if (sec.appendix) inAppendix = true;
    if (starts) groups.push([sec]); else groups[groups.length - 1].push(sec);
  }
  const fact = (k: string) => r.facts.find((f) => f[0] === k)?.[1] ?? "n/a";
  const sm = r.summary;
  const headline = sm?.headline ?? r.sections.find((x) => x.id === "conclusion")?.blocks.find((b): b is Extract<Block, { t: "p" }> => b.t === "p" && b.tone === "strong")?.text ?? null;
  const footer = (
    <View style={s.footer} fixed>
      <Text>Exported {gen} from saved research · Personal portfolio details removed · Not personalized investment advice</Text>
      <Text>{pdfSafe(r.symbol)}</Text>
    </View>
  );
  const header = <View style={s.header} fixed><Text>{pdfSafe(r.title)}</Text><Text>Company research</Text></View>;
  const section = (sec: ShareReport["sections"][number]) => (
    <View key={sec.id} id={sec.id}>
      {/* The section title stays with its first short blocks, so it never ends a page on its own. */}
      <View wrap={false}>
        <View style={s.secHead}><Text style={[s.secNum, sec.appendix ? { fontSize: 18 } : {}]}>{label.get(sec.id)}</Text><Text style={s.secTitle}>{pdfSafe(sec.title)}</Text></View>
        {sec.blocks.slice(0, lead(sec.blocks)).map((b, k) => <BlockView key={k} b={b} />)}
      </View>
      {keepWithNext(sec.blocks.slice(lead(sec.blocks)))}
    </View>
  );
  const stats: [string, string, string][] = sm ? [
    ["Reference price", sm.price !== null ? `$${sm.price.toFixed(2)}` : "n/a", sm.priceDate],
    ["Weighted value", sm.weighted !== null ? `$${sm.weighted.toFixed(2)}` : "n/a", sm.horizon ? `by ${sm.horizon}` : "probability-weighted"],
    ["Expected return", sm.annualized !== null ? `${sm.annualized >= 0 ? "+" : ""}${(sm.annualized * 100).toFixed(1)}%` : "n/a", sm.years ? `a year over ${sm.years.toFixed(1)} years` : "a year"],
    ["Confidence", sm.confidence, fact("Completeness")],
  ] : [];
  const contents = (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.tocTitle}>Contents</Text>
      <View style={s.tocCols}>{r.sections.map((sec) => <View key={sec.id} style={s.tocItem}><Text style={s.tocNum}>{label.get(sec.id)}</Text><Link src={`#${sec.id}`} style={s.tocText}>{pdfSafe(sec.title)}</Link></View>)}</View>
    </View>
  );

  return (
    <Document title={pdfSafe(`${r.title} research`)} author="Portfolio Intelligence" subject={pdfSafe(r.subtitle)} creator="Portfolio Intelligence" producer="Portfolio Intelligence">
      {/* Summary page: the verdict, the key numbers and the two charts that carry the decision. */}
      <Page size="LETTER" style={s.cover}>
        <View style={s.band}>
          <Text style={s.bandKicker}>Company research · {pdfSafe(fact("Research type"))}</Text>
          <Text style={s.bandTitle}>{pdfSafe(r.name ?? r.symbol)}</Text>
          <Text style={s.bandSub}>{pdfSafe(`${r.symbol} · Research dated ${fact("Research date")} · ${fact("Approval")}`)}</Text>
        </View>
        <View style={s.coverBody}>
          {(headline || sm?.stance) && (
            <View style={s.verdict}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", marginBottom: 6 }}>{sm?.stance ? <Text style={s.pill}>{pdfSafe(sm.stance)}</Text> : <Text style={s.headlineK}>Conclusion</Text>}</View>
                {headline && <Rich text={headline} style={s.headlineT} />}
              </View>
            </View>
          )}
          {stats.length > 0 && <View style={s.stats}>{stats.map(([k, v, sub]) => <View key={k} style={s.stat}><Text style={s.statK}>{pdfSafe(k)}</Text><Text style={s.statV}>{pdfSafe(v)}</Text><Text style={s.statSub}>{pdfSafe(sub)}</Text></View>)}</View>}
          {r.notices.length > 0 && <View style={s.notice}>{r.notices.map((n, i) => <View key={i} style={s.li}><Text style={[s.bullet, { color: C.warnBar }]}>•</Text><Text style={[s.liText, s.warn, { fontSize: 8.4 }]}>{pdfSafe(n)}</Text></View>)}</View>}
          {sm?.charts.map((c, i) => <ChartView key={i} c={c} full />)}
        </View>
        {footer}
      </Page>
      {groups.map((g, gi) => (
        <Page key={gi} size="LETTER" style={s.page} wrap>
          {header}
          {footer}
          {gi === 0 && contents}
          {g[0].appendix && <Text style={s.part}>Appendix: the full record behind the research</Text>}
          {g.map(section)}
        </Page>
      ))}
    </Document>
  );
}
