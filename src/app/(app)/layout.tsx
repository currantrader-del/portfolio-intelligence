import { Suspense } from "react";
import { Sidebar, TabBar, TopBar } from "@/components/shell/Shell";
import { Status } from "@/components/shell/Status";
import { AskPanel } from "@/components/AskPanel";
import { NavProgress } from "@/components/shell/NavProgress";
import { Toaster } from "@/components/forms";

export const dynamic = "force-dynamic";

/**
 * The shell renders immediately: nothing here waits for data. The price status streams in,
 * and each page shows its own loading skeleton while its data arrives.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const status = <Suspense fallback={null}><Status /></Suspense>;
  return (
    <NavProgress>
    <div className="flex min-h-dvh">
      <Sidebar status={status} />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar status={status} />
        <main className="w-full max-w-[1200px] mx-auto px-4 lg:px-8 pt-4 lg:pt-6 pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+88px)] lg:pb-10">
          {children}
        </main>
      </div>
      <TabBar />
      <AskPanel />
      <Toaster />
    </div>
    </NavProgress>
  );
}
