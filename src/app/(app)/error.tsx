"use client";

/** A page failed to load (often a slow or unreachable data source). The shell stays usable. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="card max-w-xl" role="alert">
      <h1 className="h2">This page didn&apos;t load</h1>
      <p className="t-sm">A data source didn&apos;t answer in time. Nothing was changed. Try again, or open another page.</p>
      {error.digest && <p className="t-xs">Reference {error.digest}</p>}
      <div><button type="button" onClick={reset} className="btn">Try again</button></div>
    </section>
  );
}
