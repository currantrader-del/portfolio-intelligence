"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Navigation feedback. The moment a link or a search form is tapped, a thin bar runs along the top
 * of the screen and the tapped tab lights up, until the new page has actually arrived. The bar never
 * finishes on its own: it completes only when the URL changes (or gives up quietly after 20 seconds).
 */
const Pending = createContext<string | null>(null);
/** The path (no query) of the page being opened, or null when nothing is loading. */
export const usePendingPath = () => useContext(Pending);

function internalTarget(href: string): URL | null {
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return null;
    if (url.pathname === window.location.pathname && url.search === window.location.search) return null; // same page or #hash
    if (/^\/api\//.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

export function NavProgress({ children }: { children: ReactNode }) {
  const path = usePathname();
  const search = useSearchParams();
  const [pending, setPending] = useState<string | null>(null);

  // Arrived: clear.
  useEffect(() => { setPending(null); }, [path, search]);

  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 20000);
    return () => clearTimeout(t);
  }, [pending]);

  useEffect(() => {
    // Capture phase: Next.js <Link> calls preventDefault in its own handler, so listen before it.
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = internalTarget(a.href);
      if (url) setPending(url.pathname);
    };
    const onSubmit = (e: SubmitEvent) => {
      const f = e.target as HTMLFormElement | null;
      // Only search forms that navigate (method GET with a URL action). Server-action forms show their own state.
      if (!f || (f.method && f.method.toLowerCase() !== "get") || !f.getAttribute("action")) return;
      const url = internalTarget(f.action);
      if (url) setPending(url.pathname);
    };
    // iOS Safari only applies :active styles when a touch listener exists.
    const noop = () => {};
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("touchstart", noop, { passive: true });
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("touchstart", noop);
    };
  }, []);

  return (
    <Pending.Provider value={pending}>
      <div className={`nav-progress ${pending ? "is-on" : ""}`} aria-hidden="true"><i /></div>
      {pending && <span className="sr-only" role="status">Loading page</span>}
      {children}
    </Pending.Provider>
  );
}
