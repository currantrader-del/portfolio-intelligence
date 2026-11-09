/** @jsxRuntime automatic */
/** Draws the share PDF in the browser. Loaded only when someone clicks "Download PDF". */
import { pdf } from "@react-pdf/renderer";
import { ShareDocument, registerShareFonts } from "./document";
import type { ShareReport } from "./report";

export async function renderSharePdfBlob(r: ShareReport): Promise<Blob> {
  registerShareFonts((f) => new URL(`/share-fonts/${f}`, window.location.origin).toString());
  return pdf(<ShareDocument r={r} />).toBlob();
}
