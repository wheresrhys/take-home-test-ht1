# db/schema/

One `.sql` file per schema object (table, role, etc). `npm run db:start` applies every
`*.sql` file in this directory, in **filename-sort order**, against the running Postgres
instance — prefix files with a number (e.g. `01_form_ingester_role.sql`) if ordering matters.

Files must be **idempotent** (`CREATE TABLE IF NOT EXISTS`, guarded `CREATE ROLE`, etc.) —
`db:start` re-applies every file on every run, including against an already-provisioned
database.
