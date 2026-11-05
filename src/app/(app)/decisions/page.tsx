import { createClient } from "@/lib/supabase/server";
import { Tag } from "@/components/Tag";

export default async function DecisionsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("decisions")
    .select("id, kind, symbol, decided_at, recommendation, user_action")
    .order("decided_at", { ascending: false });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold">Decisions</h1>
        <p className="text-muted">Every recommendation, what you did, and later how it turned out.</p>
      </div>
      {!data?.length ? (
        <p className="text-ink-2">No decisions recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {data.map((d) => {
            const r = d.recommendation as { action?: string; summary?: string };
            return (
              <li key={d.id} className="bg-surface border border-line rounded-xl p-5 flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  {d.symbol && <span className="font-mono font-medium">{d.symbol}</span>}
                  <span className="font-semibold">{r.action ?? "Recommendation"}</span>
                  <Tag>{d.kind === "historical" ? "Imported history" : d.kind.replace("_", " ")}</Tag>
                  <span className="text-sm text-muted ml-auto">{d.decided_at.slice(0, 10)}</span>
                </div>
                {r.summary && <p className="text-sm text-ink-2">{r.summary}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
