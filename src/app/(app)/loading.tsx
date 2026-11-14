import { Skel, SkelCard } from "@/components/ui";

/** Shown instantly on navigation while the page's data loads. Shaped like a typical page. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-3 lg:gap-4" aria-busy="true" aria-label="Loading">
      <div className="hidden lg:block"><Skel w={180} h={26} /></div>
      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8"><SkelCard lines={3} h={188} /></div>
        <div className="lg:col-span-4"><SkelCard lines={3} h={188} /></div>
        <div className="lg:col-span-7"><SkelCard lines={4} h={220} /></div>
        <div className="lg:col-span-5"><SkelCard lines={4} h={220} /></div>
      </div>
    </div>
  );
}
