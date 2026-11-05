import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function TodayPage() {
  const supabase = await createClient();
  const [{ count: companies }, { count: decisions }] = await Promise.all([
    supabase.from("companies").select("*", { count: "exact", head: true }),
    supabase.from("decisions").select("*", { count: "exact", head: true }),
  ]);

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <h1 className="font-serif text-3xl font-semibold">Today</h1>
      <section className="bg-surface border border-line rounded-2xl p-6 flex flex-col gap-3">
        <h2 className="text-lg font-semibold">The daily brief starts once prices and holdings are connected</h2>
        <p className="text-ink-2">
          This is the foundation release. Your research library ({companies ?? 0} companies) and decision history ({decisions ?? 0} records) are
          stored with their original sources. Live prices and holdings arrive in Stage 2, and the first decision workflow in Stage 4.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/research" className="min-h-11 px-4 inline-flex items-center rounded-lg bg-ink text-ground no-underline font-medium">Open research library</Link>
          <Link href="/decisions" className="min-h-11 px-4 inline-flex items-center rounded-lg border border-line-strong no-underline text-ink font-medium">Decision history</Link>
        </div>
      </section>
    </div>
  );
}
