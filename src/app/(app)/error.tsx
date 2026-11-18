"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";

/** A page failed to load (often a slow or unreachable data source). The shell stays usable. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Refetch the page's data and re-render it; a plain reset would only re-render the old failure.
  const retry = () => start(() => { router.refresh(); reset(); });
  return (
    <section className="card max-w-xl" role="alert">
      <h1 className="h2">This page didn&apos;t load</h1>
      <p className="t-sm">A data source didn&apos;t answer in time. Nothing was changed. Try again, or open another page.</p>
      {error.digest && <p className="t-xs">Reference {error.digest}</p>}
      <div>
        <button type="button" onClick={retry} disabled={pending} aria-busy={pending || undefined} className={`btn ${pending ? "is-pending" : ""}`}>
          {pending ? <><Spinner />Trying again…</> : "Try again"}
        </button>
      </div>
    </section>
  );
}
