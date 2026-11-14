import type { Freshness } from "@/lib/freshness";

const COLOR: Record<Freshness, string> = {
  live: "bg-[#3fb27f]",
  delayed: "bg-[#e0a43a]",
  stale: "bg-[#e0a43a]",
  missing: "bg-[#8a9099]",
};

export function FreshnessDot({ state, label }: { state: Freshness; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className={`w-2 h-2 rounded-full ${COLOR[state]}`} />
      <span>{label}</span>
    </span>
  );
}
