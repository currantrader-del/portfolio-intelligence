/** Filing classification from form type and 8-K item codes. Pure; no network. */
export type FilingCategory = "periodic" | "results" | "financing" | "material_event" | "other_event" | "registration" | "resale" | "employee_plan" | "proxy" | "other";

const FINANCING_ITEMS = new Set(["2.03", "3.02"]);
const MATERIAL_ITEMS = new Set(["1.01", "1.02", "2.01", "2.05", "2.06", "4.01", "4.02", "5.01", "5.02"]);
const UNREVIEWED = "Not reviewed: read the document and its exhibits before drawing a conclusion.";

/**
 * Classifies a filing from its form type and 8-K item codes only. The result says what kind of
 * document it is, never what it means: dilution, size and terms need the document itself.
 */
export function classifyFiling(form: string, items: string[]): { category: FilingCategory; note: string } {
  const f = form.replace("/A", "");
  if (f === "10-K" || f === "10-Q" || f === "20-F" || f === "40-F") return { category: "periodic", note: "Financial statements for the period. Compare with your research." };
  if (f === "8-K" || f === "6-K") {
    const fin = items.filter((i) => FINANCING_ITEMS.has(i));
    if (items.includes("2.02")) return { category: "results", note: `Results announcement (item 2.02). The figures are in the exhibit.${fin.length ? ` Also reports items ${fin.join(", ")} (financing); ${UNREVIEWED.toLowerCase()}` : ""}` };
    if (fin.length) {
      const what = fin.map((i) => (i === "2.03" ? "a new direct financial obligation, such as a loan or notes" : "an unregistered sale of equity securities")).join(" and ");
      return { category: "financing", note: `Reports ${what}. Amount, terms and any effect on share count are unknown until the filing is read. ${UNREVIEWED}` };
    }
    if (items.some((i) => MATERIAL_ITEMS.has(i))) return { category: "material_event", note: UNREVIEWED };
    return { category: "other_event", note: items.length ? `Items ${items.join(", ")}. ${UNREVIEWED}` : UNREVIEWED };
  }
  if (f === "S-1" || f === "S-3" || f === "S-3ASR" || f === "F-3") return { category: "registration", note: "Registers securities that may be sold later. By itself it is not a sale and issues no shares." };
  if (f === "424B7") return { category: "resale", note: "Lets existing holders resell securities they already hold. It usually brings no new shares or cash to the company; check the document." };
  if (f.startsWith("424B")) return { category: "financing", note: `Prospectus that may describe a share, convertible or debt offering. Size, price and use of proceeds are not reviewed. ${UNREVIEWED}` };
  if (f === "D") return { category: "financing", note: `Notice of a private (exempt) securities sale. Amount and holder not reviewed. ${UNREVIEWED}` };
  if (f === "S-8") return { category: "employee_plan", note: "Registers shares for employee equity plans. Ongoing dilution is better measured from the share count in periodic reports." };
  if (f === "DEF 14A") return { category: "proxy", note: "Shareholder meeting materials." };
  return { category: "other", note: UNREVIEWED };
}
