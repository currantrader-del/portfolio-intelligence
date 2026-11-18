import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, Chevron, Pill } from "@/components/ui";
import type { Synthesis } from "@/lib/intel/synthesis";

const etDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

/** Today-page entry to the market briefing: today's headline, or a prompt to generate it. */
export async function MarketsTeaser() {
  const db = await createClient();
  const { data } = await db.from("model_runs").select("computed_at, outputs").eq("kind", "market_briefing").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const b = data?.outputs as { generatedAt: string; synthesis: Synthesis } | undefined;
  const fresh = b && etDay(new Date(b.generatedAt)) === etDay(new Date());
  return (
    <Link href="/markets" className="no-underline">
      <Card tight className="!gap-1">
        <span className="flex items-center justify-between gap-2">
          <span className="cap">Markets briefing</span>
          <span className="flex items-center gap-1.5">
            {b && <Pill small>{`Short term ${b.synthesis.shortTerm.stance}`}</Pill>}
            <Chevron />
          </span>
        </span>
        <span className="t-sm text-ink">{fresh ? b!.synthesis.headline : b ? "Today's briefing is not written yet. Open to generate it." : "Open to generate your first market briefing."}</span>
      </Card>
    </Link>
  );
}
