// Builds the browser-only "Share full research" PDF renderer into public/share-pdf/renderer.js.
// It is loaded at run time with a plain import() that Next.js does not bundle, so the PDF engine
// (@react-pdf/renderer) never ends up in the Next.js server on Netlify: including it there stalled
// every page of the live site (PR #36 and PR #44).
import { build } from "esbuild";

await build({
  entryPoints: ["src/lib/research/share/pdfBrowser.tsx"],
  outfile: "public/share-pdf/renderer.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
console.log("share-pdf renderer built");
