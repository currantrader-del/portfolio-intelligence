"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Today" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/research", label: "Research" },
  { href: "/decisions", label: "Decisions" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-wrap gap-0.5 flex-1">
      {ITEMS.map((i) => {
        const active = i.href === "/" ? path === "/" : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={`px-3 py-2 rounded-md no-underline ${active ? "bg-white/10 text-white font-medium" : "text-chrome-muted hover:text-white"}`}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
