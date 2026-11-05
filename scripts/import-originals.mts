/**
 * Import preserved ChatGPT originals into Supabase from the command line.
 * The same rules run in the app at /import, where the owner's own session does the writing.
 *
 *   npx tsx scripts/import-originals.mts <folder> --out <plan.json>          # dry run: writes the plan and audit report
 *   npx tsx scripts/import-originals.mts <folder> --apply --owner <email>    # inserts rows and uploads originals
 *
 * Nothing from the folder is ever written into the repository.
 * --apply needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in the environment.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildPlan } from "../src/lib/import/plan.ts";
import { classify, toInputs } from "../src/lib/import/files.ts";
import { applyPlan } from "../src/lib/import/apply.ts";

const args = process.argv.slice(2);
const folder = args[0];
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!folder) throw new Error("Usage: import-originals.mts <folder> [--out plan.json] [--apply --owner email]");

const loaded = readdirSync(folder).map((name) => {
  const bytes = new Uint8Array(readFileSync(join(folder, name)));
  return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const { docs, ignored, duplicates } = classify(loaded);
const plan = buildPlan(toInputs(docs));

console.log("Source documents:");
for (const d of docs) console.log(`  ${d.key.padEnd(13)} ${d.sha256.slice(0, 12)}  ${d.fileName}`);
if (ignored.length) console.log(`Not used: ${ignored.join(", ")}`);
if (duplicates.length) console.log(`Duplicates skipped: ${duplicates.join(", ")}`);
console.log("\nAudit:");
for (const line of plan.report) console.log(`  - ${line}`);

const out = flag("--out");
if (out) { writeFileSync(out, JSON.stringify(plan, null, 2)); console.log(`\nPlan written to ${out}`); }

if (args.includes("--apply")) {
  const ownerEmail = flag("--owner");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!ownerEmail || !url || !secret) throw new Error("--apply needs --owner, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
  const db = createClient(url, secret, { auth: { persistSession: false } });
  const { data: users, error } = await db.auth.admin.listUsers();
  if (error) throw error;
  const owner = users.users.find((u) => u.email?.toLowerCase() === ownerEmail.toLowerCase());
  if (!owner) throw new Error(`No user with email ${ownerEmail}`);
  await applyPlan(db, plan, new Map(docs.map((d) => [d.key, d.bytes])), { ownerId: owner.id, log: (l) => console.log(`  ${l}`) });
  console.log("\nImport applied. Re-running is safe: existing rows are skipped.");
}
