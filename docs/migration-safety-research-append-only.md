# Migration safety report: research append-only

Migration: `supabase/migrations/20261106140000_research_append_only.sql`
Rollback: `supabase/migrations/rollback/20261106140000_research_append_only.down.sql`
Staging test: `supabase/tests/research_append_only.test.sql`, run by `supabase/tests/run-staging.sh`
Status: **not applied to production**. Waiting for the owner's approval.

## What it changes

It adds three triggers and two functions. It changes no data, columns, grants or row-level security policies.

| Table | Insert | Update | Delete |
| --- | --- | --- | --- |
| `research_versions` | Allowed | Only `is_current` may change; any other column raises an error | Blocked |
| `research_phases` | Allowed | Blocked | Blocked |
| `research_sources` | Allowed | Blocked | Blocked |

- **Functions:** `public.research_version_guard()` and `public.research_child_guard()`. Both are `plpgsql` with `search_path = ''`, and execute is revoked from `public` and `anon`.
- **Escape hatch:** a deliberate cleanup must run `set local app.allow_research_delete = 'on'` inside a transaction. Without it, nothing can delete.

## Current permissions (production, read 2026-11-06)

Permissions are unchanged by the migration. The triggers apply to every role, including `postgres` and `service_role`.

- **Grants:** `authenticated`, `postgres` and `service_role` hold all privileges on the three tables. `anon` holds none.
- **Row-level security:** one policy per table, `<table>_owner_mfa`, for ALL commands to `authenticated`, using `owner_id = auth.uid() and is_mfa_session()`.
- **Foreign keys into these tables:**
  - `research_phases.version_id` and `research_sources.version_id` cascade from `research_versions`.
  - `research_versions` cascades from `companies` and from `auth.users`.
  - `decisions.research_version_id` uses no action.

## Backup taken before any change (2026-11-06)

A full copy is in schema `backup_20261106` on the same database. The schema is not exposed to the API, and access is revoked from `public`, `anon` and `authenticated`. It holds copies of these tables:

- `research_versions`
- `research_phases`
- `research_sources`
- `companies`
- `source_documents`
- `policy_rules`

Each copy was verified by comparing an ordered checksum (md5 over each row's md5) between the live table and the copy:

| Table | Rows | Checksum (live = backup) |
| --- | --- | --- |
| research_versions | 3 | 4baa935f510f377bd6cf66fcb6c519b1 |
| research_phases | 12 | 0be506dd52929f4795438cc3fdc4fc4c |
| research_sources | 0 | (empty) |
| companies | 39 | 2c24d38ee78239a23dd43ecb9863c827 |
| source_documents | 13 | 2e7e2758bc875095144bc4e1ab74e44b |
| policy_rules | 36 | 9a8afcb312f359c0b0c3c68840e6a5fd |

There are two further copies:

- **Original source files.** The research-import archive (`handoff/research-import.zip`) holds the original ChatGPT exports the rows were imported from, including the IREN archive dated 2026-09-10.
- **Supabase project backups.** Supabase's own backups depend on the plan; the free tier has no point-in-time recovery, so the copies above are the recovery path.

Per-row fingerprints (md5 of the full row) to prove nothing historical changes:

| Record | Row md5 |
| --- | --- |
| IREN 2026-09-10 version `52e61019-8759-423a-acfc-326dbce83dc8` | 0f3648d16b312624f05bd31d96200816 |
| RDDT 2026-09-13 version `8c08e6cd-bc5b-418d-9702-1de8faf256a3` | 0cdfdd92f0a6045993f71ea61ce969af |
| GOOGL 2026-09-12 version `440a691f-c805-4cfa-9816-fa474ad1965a` | 7fc381a4ffae15dc880a4eb9da22f0b4 |
| IREN phases 1–6 | e8b2aed2…, 19a02715…, 4ae6abb6…, c1a0a7d4…, d686f27c…, ffecb07e… |

## Staging test (local PostgreSQL 16.15, 2026-11-06)

The staging database is built from scratch:

1. A stub of the Supabase `auth` and `storage` objects (`supabase/tests/supabase_stub.sql`).
2. All five earlier migrations, in order.
3. Seed data.
4. This migration.

All checks passed:

1. Editing a version's conclusion or date, and deleting a version, phase or source, are blocked. A cascade delete through `companies` is blocked too.
2. A correction becomes a new version, with `supersedes_id` and a new source. The current flag moves to it. The historical version's content is unchanged; only `is_current` differs.
3. The app's own role (`authenticated`, under row-level security) can still read versions and add phases to the new version. It cannot edit the old one.
4. The explicit delete switch works inside a transaction, and rolling back restores the rows.
5. The rollback script removes the triggers and functions, and edits work again.
6. Re-applying the migration after a rollback is idempotent: applying it twice is fine.

Run log: `staging-run.log` (in the project's reliability folder).

## Production functionality check

- **The app never updates or deletes research rows.**
  - `src/lib/import/apply.ts` only inserts versions and phases. It skips versions already imported.
  - `src/lib/assistant/tools.ts` only reads phases.
  - `research/actions.ts` updates `companies` (pipeline stage), which these triggers do not touch.
- **Known effect:** deleting a company, or deleting the owner's auth user, now fails while research exists for it. This is intended, since it preserves history. Removing an account would need the explicit switch or the rollback first.

## Apply and verify

1. Re-run the backup checksums above, and confirm they match.
2. Apply the migration (same SQL as the file).
3. Verify:
    - three rows in `pg_trigger` named `research_%_append_only`;
    - the per-row fingerprints above are unchanged;
    - the app's research pages load.
4. Write the November IREN findings as a new version. The September row's fingerprint must stay `0f3648d1…`.

## Rollback and recovery

- **Remove the guard:** run the rollback script. No data is touched.
- **Restore data from backup**, if ever needed:
    1. Run `set local app.allow_research_delete = 'on'`.
    2. Delete the affected rows.
    3. Run `insert into public.<table> select * from backup_20261106.<table> where id in (...)`.
    4. Re-check the checksums.
- **Drop the backup schema** only after the owner agrees.
