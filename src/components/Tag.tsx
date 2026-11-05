const STYLES = {
  neutral: "bg-[#eeede8] text-ink-2 dark:bg-white/10",
  warn: "bg-warn-bg text-warn-ink",
  alert: "bg-alert-bg text-alert-ink",
  accent: "bg-accent-soft text-accent",
} as const;

export function Tag({ tone = "neutral", children }: { tone?: keyof typeof STYLES; children: React.ReactNode }) {
  return <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-md ${STYLES[tone]}`}>{children}</span>;
}
