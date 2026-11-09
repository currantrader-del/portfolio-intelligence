/** @jsxRuntime automatic */
/** Node rendering of the share PDF (tests and the function's fallback). The app renders in the browser: pdfBrowser.tsx. */
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { ShareDocument, registerShareFonts } from "./document";
import type { ShareReport } from "./report";

export async function renderSharePdf(r: ShareReport): Promise<Buffer> {
  registerShareFonts((f) => path.join(process.cwd(), "public/share-fonts", f));
  return renderToBuffer(<ShareDocument r={r} />);
}
