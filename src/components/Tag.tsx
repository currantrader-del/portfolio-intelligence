/** Legacy tag API, drawn with the design-system pill so older pages match. */
const TONE = { neutral: "", warn: "pill-warn", alert: "pill-alert", accent: "pill-copper" } as const;

export function Tag({ tone = "neutral", children }: { tone?: keyof typeof TONE; children: React.ReactNode }) {
  return <span className={`pill pill-sm ${TONE[tone]}`}>{children}</span>;
}
