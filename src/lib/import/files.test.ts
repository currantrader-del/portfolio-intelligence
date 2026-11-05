import { describe, expect, it } from "vitest";
import { classify } from "./files";

const f = (name: string, size: number, sha = name) => ({ name, bytes: new Uint8Array(size), sha256: sha.padEnd(64, "0").slice(0, 64) });

describe("file classification", () => {
  it("tells the two same-named RDDT archives apart by size", () => {
    const { docs } = classify([f("RDDT_FULL_RESEARCH_ARCHIVE_2026-09-13.json", 131_023, "a"), f("RDDT_FULL_RESEARCH_ARCHIVE_2026-09-13_1.json", 99_277, "b")]);
    expect(docs.map((d) => d.key).sort()).toEqual(["rddt_a", "rddt_b"]);
  });
  it("skips byte-identical duplicates", () => {
    const { docs, duplicates } = classify([f("IREN_FULL_RESEARCH_ARCHIVE_2026-09-10.json", 10, "x"), f("IREN_FULL_RESEARCH_ARCHIVE_2026-09-10(1).json", 10, "x")]);
    expect(docs).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });
  it("ignores files it does not know", () => {
    expect(classify([f("Screenshot.png", 5)]).ignored).toEqual(["Screenshot.png"]);
  });
  it("recognises pasted markdown by its upload name", () => {
    expect(classify([f("Pasted markdown(7).md", 5)]).docs[0].key).toBe("googl_md");
  });
});
