import Link from "next/link";
import { Nav } from "./Nav";
import { AskPanel } from "./AskPanel";

export function AppHeader({ freshness, ticker }: { freshness: React.ReactNode; ticker?: React.ReactNode }) {
  return (
    <header className="bg-chrome text-chrome-ink">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-8 min-h-[60px] flex flex-wrap items-center gap-x-7 gap-y-2 py-2">
        <Link href="/" className="font-serif text-[19px] font-semibold no-underline text-chrome-ink">Portfolio Intelligence</Link>
        <Nav />
        {ticker}
        <div className="text-[13px] text-chrome-muted flex items-center gap-2 flex-1 md:flex-none">{freshness}</div>
        <AskPanel />
      </div>
    </header>
  );
}
