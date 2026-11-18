#!/usr/bin/env bash
# Builds a throwaway Postgres database with every migration, then runs the append-only staging test.
# Usage: PGHOST=/tmp PGPORT=55432 PGUSER=postgres supabase/tests/run-staging.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=staging_$$
psql -v ON_ERROR_STOP=1 -q -c "create database $DB"
trap 'psql -q -c "drop database if exists $DB"' EXIT
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/supabase_stub.sql
for f in $(ls supabase/migrations/*.sql | grep -v research_append_only); do psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"; done
psql -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/research_append_only.test.sql
