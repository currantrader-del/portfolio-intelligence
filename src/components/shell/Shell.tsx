"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MORE, SECTIONS, SETUP, NavIcon, backOf, sectionOf, titleOf } from "./nav";
import { Chevron } from "@/components/ui";
import { usePendingPath } from "./NavProgress";

/** The section to highlight: the one being opened (lit the instant it is tapped), else the current one. */
function useActiveSection() {
  const path = usePathname();
  const pending = usePendingPath();
  const target = pending ?? path;
  return { active: sectionOf(target)?.href, loading: pending ? sectionOf(pending)?.href ?? null : null, path: target };
}

/** Desktop sidebar (1024px and up). */
export function Sidebar({ status }: { status: React.ReactNode }) {
  const { active, loading, path } = useActiveSection();
  return (
    <aside className="hidden lg:flex sticky top-0 h-dvh w-[232px] shrink-0 flex-col gap-1 border-r border-line px-3.5 py-5">
      <Link href="/" className="px-3 pb-4 font-semibold tracking-tight no-underline">Portfolio Intelligence</Link>
      <nav aria-label="Main" className="flex flex-col gap-1">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} aria-current={active === s.href ? "page" : undefined}
            className={`nav-item flex items-center gap-2.5 min-h-10 px-3 rounded-[10px] no-underline transition-colors ${active === s.href ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"} ${loading === s.href ? "is-loading" : ""}`}>
            <NavIcon size={18}>{s.icon}</NavIcon>{s.label}
          </Link>
        ))}
      </nav>
      <div className="flex-1" />
      <nav aria-label="More" className="flex flex-col">
        {[...MORE, ...SETUP].map((m, i) => (
          <span key={m.href} className="contents">
            {i === MORE.length && <span className="cap px-3 pt-3 pb-1">Setup</span>}
            <Link href={m.href} aria-current={path === m.href.split("?")[0] ? "page" : undefined}
              className="nav-item flex items-center min-h-9 px-3 rounded-[10px] text-sm no-underline text-muted hover:text-ink aria-[current=page]:text-ink">{m.label}</Link>
          </span>
        ))}
      </nav>
      <div className="px-3 pt-3 min-h-8">{status}</div>
    </aside>
  );
}

/** Phone and tablet top bar: page title (or a back link), data status and a menu for the less-used pages. */
export function TopBar({ status }: { status: React.ReactNode }) {
  const path = usePathname();
  const back = backOf(path);
  return (
    <header className="lg:hidden sticky top-0 z-30 bg-ground/90 backdrop-blur-md border-b border-line pt-[env(safe-area-inset-top)]">
      <div className="h-[52px] px-4 flex items-center justify-between gap-3">
        {back ? (
          <Link href={back.href} className="nav-item inline-flex items-center gap-1 -ml-1.5 min-h-11 pr-2 t-sm no-underline"><Chevron dir="left" />{back.label}</Link>
        ) : (
          <span className="font-semibold tracking-tight" aria-hidden="true">{titleOf(path)}</span>
        )}
        <div className="flex items-center gap-1 min-w-0">
          <div className="min-w-0 max-w-[170px] overflow-hidden">{status}</div>
          <details className="relative group">
            <summary className="list-none cursor-pointer min-h-11 min-w-11 grid place-items-center rounded-lg text-ink-2 [&::-webkit-details-marker]:hidden" aria-label="More pages">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4.5" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="15.5" cy="10" r="1.5" /></svg>
            </summary>
            <nav aria-label="More" className="absolute right-0 top-12 w-52 card card-tight p-1.5 gap-0 shadow-2xl shadow-black/60">
              {[...MORE, ...SETUP].map((m, i) => (
                <span key={m.href} className="contents">
                  {i === MORE.length && <span className="cap px-3 pt-2 pb-1 border-t border-line mt-1">Setup</span>}
                  <Link href={m.href} className="nav-item min-h-11 px-3 flex items-center rounded-lg no-underline text-ink-2 hover:bg-surface-2"
                    onClick={(e) => (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open")}>{m.label}</Link>
                </span>
              ))}
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

/** Phone and tablet tab bar. */
export function TabBar() {
  const { active, loading } = useActiveSection();
  return (
    <nav aria-label="Main" className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[rgba(14,15,18,0.92)] backdrop-blur-md border-t border-line grid grid-cols-5 pb-[env(safe-area-inset-bottom)]">
      {SECTIONS.map((s) => (
        <Link key={s.href} href={s.href} aria-current={active === s.href ? "page" : undefined}
          className={`tab-item h-[var(--tabbar-h)] flex flex-col items-center justify-center gap-[3px] text-[10.5px] font-medium no-underline ${active === s.href ? "text-ink" : "text-muted"} ${loading === s.href ? "is-loading" : ""}`}>
          <NavIcon>{s.icon}</NavIcon>{s.label}
        </Link>
      ))}
    </nav>
  );
}
