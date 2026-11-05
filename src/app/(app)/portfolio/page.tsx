import { createClient } from "@/lib/supabase/server";

export default async function PortfolioPage() {
  const supabase = await createClient();
  const { data: accounts } = await supabase.from("accounts").select("id, name, institution, account_role").order("name");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-serif text-3xl font-semibold">Portfolio</h1>
      {!accounts?.length ? (
        <section className="bg-surface border border-line rounded-2xl p-6 max-w-3xl">
          <h2 className="text-lg font-semibold">No accounts connected yet</h2>
          <p className="text-ink-2 mt-2">Stage 2 adds Schwab sync for Thinkorswim, Acorns statement import and manual cash. Historical values from ChatGPT are kept as history, never shown as current holdings.</p>
        </section>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {accounts.map((a) => (
            <li key={a.id} className="bg-surface border border-line rounded-xl p-5">
              <div className="font-semibold">{a.name}</div>
              <div className="text-sm text-muted">{a.institution} · {a.account_role.replace("_", " ")}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
