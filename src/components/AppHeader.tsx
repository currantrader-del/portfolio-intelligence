import Link from "next/link";
import { Nav } from "./Nav";

export function AppHeader({ freshness }: { freshness: React.ReactNode }) {
  return (
    <header className="bg-chrome text-chrome-ink">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-8 min-h-[60px] flex flex-wrap items-center gap-x-7 gap-y-2 py-2">
        <Link href="/" className="font-serif text-[19px] font-semibold no-underline text-chrome-ink">Portfolio Intelligence</Link>
        <Nav />
        <div className="text-[13px] text-chrome-muted flex items-center gap-2">{freshness}</div>
        <button type="button" disabled title="The assistant arrives in Stage 4"
          className="min-h-10 px-3.5 rounded-lg bg-chrome-ink text-chrome text-sm font-medium inline-flex items-center gap-2 disabled:opacity-60">
          Ask <span className="font-mono text-xs opacity-70">⌘J</span>
        </button>
      </div>
    </header>
  );
}
