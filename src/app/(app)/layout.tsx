import { AppHeader } from "@/components/AppHeader";
import { FreshnessDot } from "@/components/FreshnessDot";
import { createClient } from "@/lib/supabase/server";
import { ageLabel, freshness } from "@/lib/freshness";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.from("holding_snapshots").select("as_of").order("as_of", { ascending: false }).limit(1);
  const asOf = data?.[0]?.as_of ? new Date(data[0].as_of) : null;
  const now = new Date();
  const state = freshness("holdings", asOf, now);
  const label = asOf ? `Holdings ${ageLabel(asOf, now)} · prices not connected yet` : "No holdings connected yet";

  return (
    <>
      <AppHeader freshness={<FreshnessDot state={state} label={label} />} />
      <main className="mx-auto max-w-[1280px] px-4 sm:px-8 py-7">{children}</main>
    </>
  );
}
