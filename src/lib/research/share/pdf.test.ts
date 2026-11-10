import { expect, it } from "vitest";
import { renderSharePdf } from "./pdf";
import type { ShareReport } from "./report";
const para = "Revenue grew 40% to $4.2B (F1) while operating margin expanded to 35%; management guided capex of $15B with about $6B unfunded, so dilution risk remains high. ";
const md = Array.from({ length: 40 }, (_, i) => i % 5 === 0 ? `**Heading ${i}.** ${para.repeat(3)}` : i % 7 === 0 ? `| A | B | C |\n|---|---|---|\n${Array.from({ length: 30 }, (_, k) => `| row ${k} | ${para} | x |`).join("\n")}` : `- ${para.repeat(2)}`).join("\n\n");
const r: ShareReport = { symbol: "A", name: "A", title: "A (A)", subtitle: "s", generatedAt: "2026-11-09T00:00:00Z", facts: [["a", "b"]], notices: ["n"], redactions: [],
  sections: [
    { id: "status", title: "S", blocks: [{ t: "kv", rows: [["Valuation", para.repeat(8)]] }] },
    ...[1,2,3,4,5,6].map((n) => ({ id: `phase-${n}`, title: `Phase ${n}`, blocks: [{ t: "md" as const, text: md }] })),
    { id: "evidence", title: "E", blocks: [{ t: "table" as const, head: ["ID", "Claim", "Src", "Check", "T"], widths: [7, 43, 14, 18, 18], rows: Array.from({ length: 60 }, (_, i) => [`F${i}`, para.repeat(i % 9 === 0 ? 12 : 2), "primary", "Verified", para]) }] },
  ] };
// Regression: long research (many pages, long tables) once crashed the PDF engine ("unsupported number")
// because of a page-number footer, and laid out in super-linear time on a single <Page>.
it("renders a long multi-page report quickly", async () => {
  const t = Date.now();
  const b = await renderSharePdf(r);
  expect(b.subarray(0, 5).toString()).toBe("%PDF-");
  // A guard against layout taking minutes again, not a benchmark: the same code takes 16-21 s on a shared
  // CI runner depending on its load (20.3 s and 20.7 s on 2026-11-10 with the PDF code unchanged).
  expect(Date.now() - t).toBeLessThan(45_000);
}, 90_000);
