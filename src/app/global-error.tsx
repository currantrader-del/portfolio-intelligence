"use client";

/**
 * Last-resort screen when the app shell itself fails (the page-level screen is (app)/error.tsx).
 * Replaces Next.js's bare "Application error" page with a way to reload, plus the error text.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ background: "#0b0c0e", color: "#e8e8ea", fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <main style={{ maxWidth: 560, margin: "10vh auto" }} role="alert">
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>The app didn&apos;t load</h1>
          <p style={{ opacity: 0.8, fontSize: 14 }}>Nothing was changed. Reload to try again; if it keeps happening, send a screenshot of this message.</p>
          <p style={{ opacity: 0.6, fontSize: 12, wordBreak: "break-word" }}>{error.message || "Unknown error"}{error.digest ? ` · Reference ${error.digest}` : ""}</p>
          <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 12, minHeight: 44, padding: "0 16px", borderRadius: 12, border: "1px solid #3a3b40", background: "#1b1c20", color: "inherit", fontSize: 15 }}>Reload</button>
        </main>
      </body>
    </html>
  );
}
