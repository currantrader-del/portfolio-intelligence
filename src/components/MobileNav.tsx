"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Today" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/research", label: "Research" },
  { href: "/decisions", label: "Decisions" },
];

/** Bottom tab bar on phones; the header nav covers larger screens. */
export function MobileNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main (mobile)" className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-surface border-t border-line grid grid-cols-4 pb-[env(safe-area-inset-bottom)]">
      {ITEMS.map((i) => {
        const active = i.href === "/" ? path === "/" : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={`min-h-14 flex items-center justify-center text-sm no-underline ${active ? "text-ink font-semibold" : "text-muted"}`}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
