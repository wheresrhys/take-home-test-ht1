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
  incl. its `create`/`getRecords`/`update`/`delete` query methods, are wired up.

## Layout

- `src/app.ts` — Express app + routes; `POST /ingest` is wired to `src/controllers/ingest.ts` and
  `POST /retry` is wired to `src/controllers/retry.ts`, both via `asyncHandler`
  (`src/lib/asyncHandler.ts`), so a rejected promise reaches the error-handling middleware instead
  of crashing the process (Express 4 doesn't forward rejections on its own). A 4-arg
  error-handling middleware is registered last: it always logs the error (message, stack,
  `application_reference` read defensively off `req.body.data`, method, path) and responds with a
  generic `5xx` body that never leaks internals. If the error is **not** a DB error
  (`isDatabaseError`, from `postgres-client.ts`), it also writes a best-effort `FormErrors` row
  (`application_reference`, `form_content` = raw request body, `runtime_errors` populated,
  `schema_errors` left blank) via `postgresClient.create` so the form can be reprocessed via
  `/retry`; DB errors skip that write (the DB is presumably down, so writing would just throw
  again and mask the original error). `src/index.ts` — server bootstrap (`PORT`, default 3000).
- `src/lib/asyncHandler.ts` — generic Express 4 helper: wraps an async route handler so a
  rejection is forwarded via `next(err)`. Not forms-specific — shared by `/ingest` and `/retry`.
- `src/controllers/ingest.ts` — thin controller: reads `req.body.data`, calls `ingestForm`, maps
  the `IngestResult` onto the HTTP response (`res.status(result.statusCode).json(...)`, narrowing
  via `'data' in result`). No validation/geocode/transform/persist logic lives here. On a failure
  result the response body is a fixed, generic `{ message: string }` — the lib's `errors` array
  is deliberately dropped here, never forwarded to the caller (no validator diagnostics, no raw
  submitted data).
- `src/controllers/retry.ts` — `retryFailedForms`, wired up as `POST /retry`. Accepts
  `{ references: string[] }` (each a `FormErrors.application_reference`); `400` on any other
  shape. An empty `references` array short-circuits to `200 []` before any DB/ingest call. For
  each reference it fetches the matching `FormErrors` row (`getRecords("formerrors",
  "application_reference", references)`), replays `form_content` through the same `ingestForm`
  (I2) `/ingest` uses — no duplicated validation/transform/geocode logic — as one independent
  promise per reference inside a single `Promise.allSettled` (so one still-failing reference
  never aborts the batch), and deletes the `FormErrors` row (`delete("formerrors", "id", id)`)
  only when ingest succeeds. On a still-failing retry, the row is **not** left untouched: it
  calls `update("formerrors", "id", id, { schema_errors, runtime_errors })` (#34) writing a
  **full snapshot of the current failure across both columns** — the column matching this
  attempt's failure type (`schema_errors` for a `statusCode: 400` I1 validation failure,
  `runtime_errors` for anything else, e.g. a `409` duplicate) gets the latest errors and the
  other column is **cleared to null** — so the row always represents why the form is failing
  *now* rather than a stale mix of past and present failures (e.g. a prior runtime failure that's
  since been fixed is nulled when the form now fails schema validation). The `update` also bumps
  `updated_at`. A failure to persist that update is logged but doesn't change
  the reference's already-rejected outcome. Responds `200` with an array, one entry per input
  reference, **preserving input order**. Each entry carries its `application_reference` plus a
  `status` (`{status, application_reference, value}` on success / `{status, application_reference}`
  on failure); an unmatched reference settles rejected without ever calling the ingest lib,
  `update`, or `delete`. Failure reasons are **deliberately withheld from the response** for
  security/privacy reasons (they can leak validator internals or stack traces) — the exact
  failure shape a caller should see still needs more thought. Unexpected errors (ingest lib
  throwing, `update`/`delete` throwing, the initial `getRecords` fetch throwing) are logged via
  `console.error` with `application_reference`/`references` metadata but only ever surface a
  `500` generic body to the caller — never the underlying error. Deliberately
  **not transactional** (delete/update and re-ingest are separate operations, not one DB
  transaction) — a follow-up ticket specs that.
- `src/forms/schemas/` — `ingested_schema.ts` (inbound shape), `transformed_schema.ts` (outbound shape).
  Note the mismatch is deliberate: snake_case→camelCase, `name`→`firstName`/`lastName`,
  `date_of_birth: string`→`dateOfBirth: Date`, gender `"other"`→`"prefer-not-to-say"`,
  address flattened, lat/long added.
  `ingested_schema.schema.json` is generated, not hand-written — see Conventions below for the
  workflow to change it.
- `src/forms/examples/` — sample form JSON.
- `src/forms/lib/validator.ts` — `validateIngestedForm`, validates unknown input against the
  generated `ingested_schema.schema.json` via Ajv.
- `src/forms/lib/ingest.ts` — `ingestForm(data: unknown): Promise<IngestResult<{ id: string }>>`,
  the single library entry point every ingest/retry caller hangs off, plus `transformData`
  (pure ingested→transformed mapping, same file). `IngestResult<T = TransformedFormSchema>` is a
  discriminated union — `{ statusCode, data: T }` on success (no `errors` key) or
  `{ statusCode, errors: string[] }` on failure (no `data` key) — so callers narrow via
  `'data' in result` / `'errors' in result` rather than checking whether `errors` is
  undefined/empty. Happy path (I3): I1 validation → `idealpostcodes.lookupPostcode` on the
  postcode → `transformData` → `postgresClient.create("forms", toFormsRow(transformedRow))` →
  `{ statusCode: 201, data: { id: transformedRow.applicationReference } }`. `transformData` yields
  the camelCase outbound shape; `toFormsRow` (same file) is the persistence boundary that maps it
  onto the `forms` table's snake_case column names — without it, `create` builds
  `INSERT INTO forms (sessionId, ...)`, whose unquoted identifiers fold to `sessionid` and no such
  column exists. Schema-invalid path
  (I4): on I1 validator failure, before returning `{ statusCode: 400, errors }`, writes a
  `FormErrors` row via `postgresClient.create("formerrors", { application_reference, form_content,
  schema_errors, runtime_errors: null })` — `form_content` (the raw submitted `data`) and
  `schema_errors` (the validator's error array) are `JSON.stringify`'d for their JSONB columns
  (a raw JS array would be sent as a Postgres array literal, invalid JSON for JSONB), and `application_reference` is defensively
  extracted from the unvalidated payload (coerced to a string when truthy but not already a
  string, `null` when missing/falsy) so the row is written even when validation itself failed
  on that field — captured so the record can be fixed and replayed via `/retry` (R1) after a
  deploy. Duplicate handling (I5): a `create()` rejection is checked with the colocated
  `isUniqueViolationError(error)` (matches Postgres unique-violation code `23505`, raised on a
  repeat `Forms.application_reference` — the PK, per D3); on a match, `ingestForm` short-circuits
  to `{ statusCode: 409, errors: [...] }` without writing a `FormErrors` record (a duplicate
  delivery is expected, not a failure to retry) and without leaking the raw pg error. Any other
  rejection is rethrown unchanged, caught by the `app.ts` error-handling middleware (I6). Geocode
  failure handling remains a later ticket — this lib currently assumes `lookupPostcode` succeeds.
- `src/providers/` — external-system stubs. Each returns `HttpResponse<T>` (`httpresponse.ts`).
  - `idealpostcodes.ts` — `lookupPostcode` geocoder; **fails ~5% of calls** (returns 500) by design.
  - `sendgrid.ts` — `sendEmail`; also **fails ~5%** by design.
  - `postgres-client.ts` — `createPostgresPool()` builds a `pg` `Pool` from `PGHOST`/`PGPORT`/
    `PGDATABASE`/`FORM_INGESTER_DB_PASSWORD` (throws naming every missing/empty var, never the
    password value); `user` is hardcoded to `"form_ingester"` in code, never read from env. The
    `postgresClient` singleton is built by calling it once at module load. Deliberately does not
    return `HttpResponse<T>` — `pg`'s `Pool` has no HTTP status to wrap. Four generic CRUD
    methods are attached onto the singleton (not exported standalone): `create<T>(tableName,
    data)` (INSERT ... RETURNING \*), `getRecords<T>(tableName, idColumn, ids)` (SELECT ... WHERE
    idColumn IN (...), with an early-return `[]` guard for an empty `ids` array — avoids an
    invalid empty `IN ()`), `update<T>(tableName, idColumn, id, data)` (UPDATE ... SET <data's
    columns>, updated_at = now() WHERE idColumn = id RETURNING \*; `updated_at` is always bumped
    regardless of which columns the caller passes, so call sites never have to remember it),
    and `delete(tableName, idColumn, id)` (DELETE ... WHERE idColumn = id;
    rejects with an Error naming the table/idColumn/id if `rowCount` is 0 — no silent no-op;
    `update` mirrors this same 0-row guard on its `RETURNING` rows). All four use parameterised
    queries for values; `tableName`/
    `idColumn` are only ever passed by trusted internal call sites (`Forms`/`FormErrors`), never
    from request bodies, so they're interpolated directly. `delete` is attached as an object
    property (not a `function delete` declaration) since `delete` is a reserved word as a
    standalone identifier but a valid property key. None of the four catch/transform `pg`
    errors — callers (ingest/retry) branch on error shape (e.g. `error.code === '23505'` for a
    primary-key conflict). Also exports `isDatabaseError(err)`, a `err instanceof DatabaseError`
    guard (pg's own class, re-exported from `pg-protocol` — a first-party, stable signal, not
    string-matching) — reused by the `app.ts` error middleware to distinguish "the DB call itself
    failed" from every other runtime error. Only covers protocol-level failures (constraint
    violations, syntax errors); a fully unreachable DB (connection refused) isn't a
    `DatabaseError` instance — accepted as out of scope for now (no full DB-failure taxonomy).
- `tests/` — mirrors `src/`. `tests/controllers/ingest.test.ts` is the BDD/supertest suite for
  `POST /ingest`, mocking `idealpostcodes.lookupPostcode` and the db client's `create` — no real
  network/DB; its `postgres-client` mock reimplements `isDatabaseError` against pg's real
  `DatabaseError` class (rather than `jest.requireActual`) so the suite never loads the real
  module and its env-var-backed `Pool`. Covers the error-handling middleware's three paths: a
  runtime error mid-ingest, a DB error (skips the `FormErrors` write), and an error before
  `application_reference` is parseable (malformed JSON body).
  `tests/providers/postgres-client.test.ts` unit-tests
  `createPostgresPool()`/the singleton with `pg` mocked; `tests/providers/postgres-client-crud.test.ts`
  integration-tests `create`/`getRecords`/`update`/`delete` against the real docker DB (kept in a
  separate file since the two approaches — mocked vs real `pg` — can't coexist in one jest file
  once `pg` is auto-mocked at the top). `tests/e2e/ingest.e2e.test.ts` drives the real app through
  `supertest` against the real docker DB (only `idealpostcodes`/`sendgrid` mocked), proving the
  persistence contract the mocked BDD suites assume (happy path, 409 conflict, 400 schema error).
  Like the crud suite it never `TRUNCATE`s the shared DB — it uses a unique `application_reference`
  per test with reference-scoped assertions and per-row teardown, so it's parallel-worker-safe.
- `db/schema/` — one `.sql` file per schema object (table, role, etc), applied by
  `npm run db:start` in **filename-sort order** via `db/apply-schema.sh`. Prefix files if
  ordering matters, relative to the existing uppercase-leading names (e.g.
  `zz_FormIngesterRole.sql` runs after `Forms.sql`/`FormErrors.sql` since its grants target
  those tables — a numeric prefix would sort *before* them instead). Files must be
  **idempotent** (`CREATE TABLE IF NOT EXISTS`, guarded `CREATE ROLE`, etc.) — every file is
  re-applied on every `db:start`, including against an already-provisioned database. A column
  added to a table after its initial `CREATE TABLE` ships as an `ALTER TABLE ... ADD COLUMN IF
  NOT EXISTS` appended to that table's file, per the same idempotency rule (e.g.
  `FormErrors.sql`'s `created_at`/`updated_at`, added post-creation to back `postgresClient`'s
  `update` method — see #34).
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
- `npm test` — jest, with `.env.local` preloaded (`DOTENV_CONFIG_PATH=.env.local` + jest's
  `setupFiles: ["dotenv/config"]`) before any test file's module graph evaluates — needed
  because `src/app.ts` now transitively imports `src/providers/postgres-client.ts` (via the
  `/retry` controller), which throws at import time if its required env vars aren't already
  set. So every suite that imports the app, not just DB-integration suites, needs a live
  `npm run db:start` (or an already-running docker Postgres) for its module graph to load —
  even ones that mock `postgresClient`'s methods.
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
