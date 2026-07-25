# CLAUDE.md

## What this is

Healthtech-1 take-home. A form-ingestion service. An unreliable 3rd party sends patient
registration forms; we ingest, validate, geocode, transform and hand them off to a
downstream "FORM-BOT" — resiliently (duplicate deliveries, silent schema changes, retries).

Full brief: `README.md`. Build plan / ticket breakdown: `tasks.md`.

## Core requirements (from README)

- `/ingest` endpoint — validate against `ingested_schema`, geocode postcode → lat/long,
  transform to `transformed_schema`, persist to DB.
- `/retry` endpoint — reprocess forms that failed a prior step after a code fix ships.
- At-least-once delivery from provider → **must dedupe**; never hand FORM-BOT the same form twice.
- On successful transform, send a **guaranteed** email to happyforms@bots.com.
- Capture failed forms + error so they can be retried after a deploy.
- Use a real database (schema design is assessed).

## Stack

- TypeScript, strict mode (`tsconfig.json`), target ES2022, commonjs.
- Express 4 HTTP server.
- Jest + ts-jest, supertest for HTTP-level tests.
- Postgres — provisioned locally via Docker Compose (`npm run db:start`); schema, the
  `form_ingester` role, and the app's `pg` connection pool (`src/providers/postgres-client.ts`),
  incl. its `create`/`getRecords`/`delete` query methods, are wired up.

## Layout

- `src/app.ts` — Express app + routes. `src/index.ts` — server bootstrap (`PORT`, default 3000).
- `src/forms/schemas/` — `ingested_schema.ts` (inbound shape), `transformed_schema.ts` (outbound shape).
  Note the mismatch is deliberate: snake_case→camelCase, `name`→`firstName`/`lastName`,
  `date_of_birth: string`→`dateOfBirth: Date`, gender `"other"`→`"prefer-not-to-say"`,
  address flattened, lat/long added.
  `ingested_schema.schema.json` is generated, not hand-written — see Conventions below for the
  workflow to change it.
- `src/forms/examples/` — sample form JSON.
- `src/forms/lib/validator.ts` — `validateIngestedForm`, validates unknown input against the
  generated `ingested_schema.schema.json` via Ajv.
- `src/forms/lib/ingest.ts` — `ingestForm(data: unknown): Promise<IngestResult>`, the single
  library entry point every ingest/retry caller hangs off. `IngestResult<T = TransformedFormSchema>`
  is a discriminated union — `{ statusCode, data: T }` on success (no `errors` key) or
  `{ statusCode, errors: string[] }` on failure (no `data` key) — so callers narrow via
  `'data' in result` / `'errors' in result` rather than checking whether `errors` is
  undefined/empty. Currently only wires up I1 validation (400 + validator messages on failure,
  placeholder 200 echoing the validated input on success); geocode/transform/persist land in a
  later ticket.
- `src/providers/` — external-system stubs. Each returns `HttpResponse<T>` (`httpresponse.ts`).
  - `idealpostcodes.ts` — `lookupPostcode` geocoder; **fails ~5% of calls** (returns 500) by design.
  - `sendgrid.ts` — `sendEmail`; also **fails ~5%** by design.
  - `postgres-client.ts` — `createPostgresPool()` builds a `pg` `Pool` from `PGHOST`/`PGPORT`/
    `PGDATABASE`/`FORM_INGESTER_DB_PASSWORD` (throws naming every missing/empty var, never the
    password value); `user` is hardcoded to `"form_ingester"` in code, never read from env. The
    `postgresClient` singleton is built by calling it once at module load. Deliberately does not
    return `HttpResponse<T>` — `pg`'s `Pool` has no HTTP status to wrap. Three generic CRUD
    methods are attached onto the singleton (not exported standalone): `create<T>(tableName,
    data)` (INSERT ... RETURNING \*), `getRecords<T>(tableName, idColumn, ids)` (SELECT ... WHERE
    idColumn IN (...), with an early-return `[]` guard for an empty `ids` array — avoids an
    invalid empty `IN ()`), and `delete(tableName, idColumn, id)` (DELETE ... WHERE idColumn = id;
    rejects with an Error naming the table/idColumn/id if `rowCount` is 0 — no silent no-op).
    All three use parameterised queries for values; `tableName`/
    `idColumn` are only ever passed by trusted internal call sites (`Forms`/`FormErrors`), never
    from request bodies, so they're interpolated directly. `delete` is attached as an object
    property (not a `function delete` declaration) since `delete` is a reserved word as a
    standalone identifier but a valid property key. None of the three catch/transform `pg`
    errors — callers (ingest/retry) branch on error shape (e.g. `error.code === '23505'` for a
    primary-key conflict).
- `tests/` — mirrors `src/`. `tests/providers/postgres-client.test.ts` unit-tests
  `createPostgresPool()`/the singleton with `pg` mocked; `tests/providers/postgres-client-crud.test.ts`
  integration-tests `create`/`getRecords`/`delete` against the real docker DB (kept in a separate
  file since the two approaches — mocked vs real `pg` — can't coexist in one jest file once `pg`
  is auto-mocked at the top).
- `db/schema/` — one `.sql` file per schema object (table, role, etc), applied by
  `npm run db:start` in **filename-sort order** via `db/apply-schema.sh`. Prefix files if
  ordering matters, relative to the existing uppercase-leading names (e.g.
  `zz_FormIngesterRole.sql` runs after `Forms.sql`/`FormErrors.sql` since its grants target
  those tables — a numeric prefix would sort *before* them instead). Files must be
  **idempotent** (`CREATE TABLE IF NOT EXISTS`, guarded `CREATE ROLE`, etc.) — every file is
  re-applied on every `db:start`, including against an already-provisioned database.
  `zz_FormIngesterRole.sql` creates the `form_ingester` login role (no superuser/createdb/
  createrole) the app connects as, with CRUD-only grants on `Forms`/`FormErrors` — the app's
  `pg` client (`src/providers/postgres-client.ts`) is hardcoded to connect as this role.

Providers are intentionally flaky to force real resilience/retry handling.

## Conventions

- **Tabs** for indentation (existing files). Match surrounding style.
- Named exports for provider functions; default export for the app.
- Provider calls are async and return `HttpResponse<T>` — check `statusCode`, don't throw.
- Long descriptive names.
- Changing the ingested schema: (1) edit the `IngestedFormSchema` type in `ingested_schema.ts`,
  (2) run `npm run generate:schema` to regenerate `ingested_schema.schema.json`, (3) update the
  affected tests. Don't hand-edit the generated `.schema.json` file.

## Scripts

- `npm run dev` — ts-node-dev, respawn on change.
- `npm run build` — tsc → `dist/`.
- `npm start` — run built server.
- `npm test` — jest.
- `npm run db:start` — install Docker, then run this to provision a local Postgres via
  Docker Compose, using the throwaway dev credentials committed in `.env.local`, then
  apply every `db/schema/*.sql` file (see `db:apply-schema` / `db/schema/` above).
- `npm run db:apply-schema` — waits for Postgres to accept connections, then applies
  `db/schema/*.sql` in filename-sort order; run standalone to re-apply schema without
  restarting the container.

## Working agreements

- Never work on `main`. Branch per shippable increment (`<feature>/<n>-<slug>`), PR each.
- Aim <400 LOC/branch.
- Tests block deploy. Validator modules get unit tests; endpoints get BDD/supertest tests.
- Log unexpected errors with metadata (esp. `application_reference`).
- Don't leak system internals in user-facing error responses.
