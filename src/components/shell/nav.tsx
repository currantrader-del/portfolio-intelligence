/** Main sections, their icons, and how a path maps to a section title. */
export const SECTIONS = [
  { href: "/", label: "Today", icon: <><circle cx="11" cy="11" r="7.5" /><path d="M11 7v4l2.5 2" /></> },
  { href: "/portfolio", label: "Portfolio", icon: <><path d="M11 3.5v7.5h7.5A7.5 7.5 0 1 1 11 3.5z" /><path d="M14 3.8a7.5 7.5 0 0 1 4.2 4.2H14z" /></> },
  { href: "/research", label: "Research", icon: <><circle cx="10" cy="10" r="6" /><path d="M14.5 14.5L19 19" /></> },
  { href: "/risk", label: "Risk", icon: <path d="M11 3l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V6z" /> },
  { href: "/decisions", label: "Decisions", icon: <path d="M5 11l4 4 8-9" /> },
] as const;

export const MORE = [
  { href: "/assistant", label: "Your questions" },
  { href: "/markets", label: "Markets briefing" },
  { href: "/brief", label: "Daily brief" },
  { href: "/brief?period=week", label: "Weekly brief" },
  { href: "/policy", label: "Policy" },
  { href: "/portfolio/reconcile", label: "Reconcile" },
  { href: "/import", label: "Import" },
] as const;

const TITLES: [RegExp, string][] = [
  [/^\/portfolio\/reconcile/, "Reconcile"],
  [/^\/decisions\/new-capital/, "New cash"],
  [/^\/decisions\/review\//, "Position review"],
  [/^\/research\/[^/]+/, "Company"],
  [/^\/brief/, "Brief"],
  [/^\/markets/, "Markets"],
  [/^\/policy/, "Policy"],
  [/^\/import/, "Import"],
];

export function sectionOf(path: string) {
  return SECTIONS.find((s) => (s.href === "/" ? path === "/" : path === s.href || path.startsWith(s.href + "/"))) ?? null;
}

export function titleOf(path: string): string {
  return TITLES.find(([re]) => re.test(path))?.[1] ?? sectionOf(path)?.label ?? "Portfolio Intelligence";
}

/** Sub-pages show a back link to their section instead of the section title. */
export function backOf(path: string): { href: string; label: string } | null {
  if (/^\/research\/[^/]+/.test(path)) return { href: "/research", label: "Research" };
  if (/^\/decisions\/.+/.test(path)) return { href: "/decisions", label: "Decisions" };
  if (/^\/portfolio\/.+/.test(path)) return { href: "/portfolio", label: "Portfolio" };
  return null;
}

export function NavIcon({ children, size = 22 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{children}</svg>
  );
}
