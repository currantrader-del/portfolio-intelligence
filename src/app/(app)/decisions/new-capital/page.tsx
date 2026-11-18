import { getWorkspace } from "@/lib/workspace";
import { PageHeader } from "@/components/ui";
import { NewCapitalView, parseAmount } from "@/components/decisions/NewCapitalView";
import { parseSource } from "@/lib/decision/newCapital";

export default async function NewCapitalPage({ searchParams }: { searchParams: Promise<{ amount?: string; source?: string; confirmed?: string }> }) {
  const sp = await searchParams;
  const ws = await getWorkspace();
  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <PageHeader title="New cash" back={{ href: "/decisions", label: "Decisions" }} />
      <NewCapitalView ws={ws} amount={parseAmount(sp.amount)} source={parseSource(sp.source)} confirmed={sp.confirmed === "1"} action="/decisions/new-capital" />
    </div>
  );
}
