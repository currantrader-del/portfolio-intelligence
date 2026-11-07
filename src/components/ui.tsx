/**
 * Design system primitives. Server-safe (no client JavaScript), styled by the component
 * classes in globals.css so every page shares one look.
 *
 * Rule of thumb for labels: facts are plain; anything estimated, delayed, hypothetical,
 * unverified or in conflict carries a DataLabel so it can never be mistaken for a fact.
 */
import Link from "next/link";
import type { ReactNode } from "react";

type Tone = "neutral" | "warn" | "alert" | "info" | "copper" | "gain" | "solid";
type DotKind = "solid" | "hollow" | "dash";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ icons */

export function Chevron({ dir = "right", className }: { dir?: "right" | "down" | "left"; className?: string }) {
  const d = dir === "down" ? "M4 6l4 4 4-4" : dir === "left" ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5";
  return (
    <svg className={cx("chev", className)} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/* ------------------------------------------------------------------ text */

export function Cap({ children, className, as: As = "span", id }: { children: ReactNode; className?: string; as?: "span" | "h2" | "h3" | "div"; id?: string }) {
  return <As id={id} className={cx("cap", className)}>{children}</As>;
}

/* ------------------------------------------------------------------ pills and status */

export function Dot({ kind = "solid", className, style }: { kind?: DotKind; className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden="true" className={cx("dot", kind === "hollow" && "dot-hollow", kind === "dash" && "dot-dash", className)} style={style} />;
}

export function Pill({ tone = "neutral", dot, small, children, className, title }: { tone?: Tone; dot?: DotKind; small?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("pill", small && "pill-sm", tone !== "neutral" && `pill-${tone}`, className)}>
      {dot && <Dot kind={dot} />}
      {children}
    </span>
  );
}

/**
 * Status Indicator for the nature of a number. One vocabulary across the app:
 * solid dot = a recorded fact, hollow = estimated or needs refresh, dashed = modelled or hypothetical.
 */
export type DataKind =
  | "verified" | "estimated" | "delayed" | "live" | "hypothetical" | "model" | "estimate"
  | "unverified" | "conflict" | "stale" | "placeholder" | "recommendation" | "illustrative";

const DATA: Record<DataKind, { tone: Tone; dot: DotKind; label: string; title: string }> = {
  verified: { tone: "gain", dot: "solid", label: "Verified", title: "Reconciled against account data" },
  estimated: { tone: "info", dot: "hollow", label: "Estimated", title: "Built from statements and delayed prices; not reconciled" },
  delayed: { tone: "neutral", dot: "hollow", label: "Delayed", title: "Quotes can be 15 minutes or more behind" },
  live: { tone: "gain", dot: "solid", label: "Live", title: "Quote from the last few minutes" },
  hypothetical: { tone: "info", dot: "dash", label: "Hypothetical", title: "Today's holdings priced in the past; not your actual return" },
  model: { tone: "info", dot: "dash", label: "Model estimate", title: "Calculated from your research scenarios" },
  estimate: { tone: "info", dot: "dash", label: "Estimate", title: "An approximation; real outcomes can differ" },
  unverified: { tone: "warn", dot: "hollow", label: "Unverified", title: "From a third party; not checked" },
  conflict: { tone: "warn", dot: "solid", label: "Policy conflict", title: "Sources disagree; the stricter value is used until you choose" },
  stale: { tone: "warn", dot: "hollow", label: "Stale", title: "Older than the freshness window" },
  placeholder: { tone: "warn", dot: "hollow", label: "Placeholder", title: "An app default you have not approved" },
  recommendation: { tone: "copper", dot: "solid", label: "Recommendation", title: "The app's judgement from current evidence" },
  illustrative: { tone: "neutral", dot: "dash", label: "Not a recommendation", title: "Shown to explain the mechanics only" },
};

export function DataLabel({ kind, children, small }: { kind: DataKind; children?: ReactNode; small?: boolean }) {
  const d = DATA[kind];
  return <Pill tone={d.tone} dot={d.dot} small={small} title={d.title}>{children ?? d.label}</Pill>;
}

/** Data Freshness Indicator: a coloured dot and a plain-language age. */
export function Freshness({ state, children }: { state: "live" | "delayed" | "stale" | "missing"; children: ReactNode }) {
  const color = state === "live" ? "var(--gain)" : state === "delayed" ? "var(--gain)" : state === "stale" ? "var(--warn-ink)" : "var(--muted)";
  return (
    <span className="src">
      <Dot kind={state === "live" || state === "delayed" ? "solid" : "hollow"} style={{ color }} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Source / Evidence Reference: where a number came from. */
export function SourceRef({ kind, children, href }: { kind: string; children?: ReactNode; href?: string }) {
  const body = (<><i>{kind}</i>{children && <span className="truncate">{children}</span>}</>);
  return href ? <a href={href} target="_blank" rel="noreferrer" className="src no-underline">{body}</a> : <span className="src">{body}</span>;
}

/* ------------------------------------------------------------------ surfaces */

export function Card({ children, className, tight, flush, as: As = "section", id, label, labelledBy }: {
  children: ReactNode; className?: string; tight?: boolean; flush?: boolean; as?: "section" | "div" | "article" | "form"; id?: string; label?: string; labelledBy?: string;
}) {
  return (
    <As id={id} aria-label={label} aria-labelledby={labelledBy} className={cx("card", tight && "card-tight", flush && "card-flush", className)}>
      {children}
    </As>
  );
}

/** A card heading row: title on the left, an optional pill, note or action on the right. */
export function CardHead({ title, cap, id, right }: { title?: ReactNode; cap?: ReactNode; id?: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 min-w-0">
      {cap ? <Cap as="h2" id={id}>{cap}</Cap> : <h2 id={id} className="h2 min-w-0">{title}</h2>}
      {right && <div className="flex items-center gap-2 shrink-0 text-right">{right}</div>}
    </div>
  );
}

export function LinkRow({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cx("link-row", className)}>
      <span className="min-w-0">{children}</span>
      <Chevron />
    </Link>
  );
}

/** Expandable Detail: native <details>, so it works before JavaScript loads. */
export function Disclose({ summary, children, open, className }: { summary: ReactNode; children: ReactNode; open?: boolean; className?: string }) {
  return (
    <details className={cx("disclose", className)} open={open}>
      <summary><span className="min-w-0">{summary}</span><Chevron dir="down" /></summary>
      <div className="disclose-body">{children}</div>
    </details>
  );
}

/* ------------------------------------------------------------------ numbers */

/** Metric: a label, a value and an optional note. Value tone is passed in, never inferred. */
export function Metric({ label, value, note, tone, size = "md", align = "left", className }: {
  label: ReactNode; value: ReactNode; note?: ReactNode; tone?: "gain" | "loss" | "warn" | null; size?: "sm" | "md" | "lg" | "xl"; align?: "left" | "right"; className?: string;
}) {
  const v = size === "xl" ? "t-big" : size === "lg" ? "t-mid" : size === "md" ? "t-val" : "num font-semibold";
  return (
    <div className={cx("flex flex-col gap-0.5 min-w-0", align === "right" && "text-right items-end", className)}>
      <span className="t-xs">{label}</span>
      <span className={cx(v, tone)}>{value}</span>
      {note && <span className="t-xs">{note}</span>}
    </div>
  );
}

/**
 * Progress / Exposure Bar. `value` and `max` are fractions on the same scale; markers are extra
 * reference lines (for example the normal range). Over the max the bar fills and turns red.
 */
export function Bar({ value, max, scale, tone, thin, markers = [], label }: {
  value: number; max?: number | null; scale?: number; tone?: "copper" | "warn" | "loss" | "gain" | "muted"; thin?: boolean; markers?: number[]; label?: string;
}) {
  const s = scale ?? (max && max > 0 ? max : Math.max(value, 0.0001));
  const pct = Math.max(0, Math.min(100, (value / s) * 100));
  const over = max != null && value > max + 1e-9;
  const t = tone ?? (over ? "loss" : max != null && value >= max * 0.95 ? "warn" : "copper");
  const color = { copper: "var(--accent)", warn: "var(--warn-ink)", loss: "var(--loss)", gain: "var(--gain)", muted: "var(--muted)" }[t];
  return (
    <div className={cx("bar", thin && "bar-thin")} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <i style={{ width: `${pct}%`, background: color }} />
      {markers.filter((m) => m > 0 && m < s).map((m) => <b key={m} style={{ left: `${(m / s) * 100}%` }} />)}
    </div>
  );
}

/* ------------------------------------------------------------------ layout */

/** Page header. On phones the top bar already names the page, so the visible title is desktop only. */
export function PageHeader({ title, kicker, actions, back, actionsDesktopOnly }: { title: ReactNode; kicker?: ReactNode; actions?: ReactNode; back?: { href: string; label: string }; actionsDesktopOnly?: boolean }) {
  return (
    <div className={cx("flex flex-wrap items-end justify-between gap-3 min-w-0", actionsDesktopOnly && !kicker && !back && "max-lg:-mb-3")}>
      <div className="flex flex-col gap-1 min-w-0">
        {back && (
          <Link href={back.href} className="hidden md:inline-flex items-center gap-1 t-sm no-underline -ml-1 min-h-8"><Chevron dir="left" />{back.label}</Link>
        )}
        {kicker && <span className="cap">{kicker}</span>}
        <h1 className="h1 max-md:sr-only">{title}</h1>
      </div>
      {actions && <div className={cx("flex flex-wrap gap-2", actionsDesktopOnly && "max-lg:hidden")}>{actions}</div>}
    </div>
  );
}

/** Segmented control made of links, so each choice is a URL that survives refresh and back. */
export function Seg({ items, current, label }: { items: { key: string; label: ReactNode; href: string }[]; current: string; label: string }) {
  return (
    <nav className="seg" aria-label={label}>
      {items.map((i) => (
        <Link key={i.key} href={i.href} scroll={false} aria-current={i.key === current ? "page" : undefined}>{i.label}</Link>
      ))}
    </nav>
  );
}

export function Chips({ items, current, label }: { items: { key: string; label: ReactNode; href: string }[]; current: string; label: string }) {
  return (
    <nav className="chips" aria-label={label}>
      {items.map((i) => (
        <Link key={i.key} href={i.href} scroll={false} className="chip" aria-current={i.key === current ? "page" : undefined}>{i.label}</Link>
      ))}
    </nav>
  );
}

/** Ticker monogram. */
export function Tick({ symbol }: { symbol: string }) {
  return <span className="tick" aria-hidden="true">{symbol.replace(/[^A-Z]/gi, "").slice(0, 2).toUpperCase()}</span>;
}

/** Skeleton block for loading states. Sized to the content it stands in for, so nothing jumps. */
export function Skel({ w = "100%", h = 14, className }: { w?: number | string; h?: number; className?: string }) {
  return <span aria-hidden="true" className={cx("skel block", className)} style={{ width: w, height: h }} />;
}

export function SkelCard({ lines = 3, h }: { lines?: number; h?: number }) {
  return (
    <div className="card" aria-hidden="true" style={h ? { minHeight: h } : undefined}>
      <Skel w="40%" h={12} />
      {Array.from({ length: lines }, (_, i) => <Skel key={i} w={i === 0 ? "60%" : `${90 - i * 12}%`} h={i === 0 ? 28 : 12} />)}
    </div>
  );
}

export { cx };
