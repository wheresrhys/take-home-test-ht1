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
- Postgres planned (see `tasks.md`) — not yet wired up.

## Layout

- `src/app.ts` — Express app + routes. `src/index.ts` — server bootstrap (`PORT`, default 3000).
- `src/forms/schemas/` — `ingested_schema.ts` (inbound shape), `transformed_schema.ts` (outbound shape).
  Note the mismatch is deliberate: snake_case→camelCase, `name`→`firstName`/`lastName`,
  `date_of_birth: string`→`dateOfBirth: Date`, gender `"other"`→`"prefer-not-to-say"`,
  address flattened, lat/long added.
  `ingested_schema.schema.json` is generated, not hand-written — see Conventions below for the
  workflow to change it.
- `src/forms/examples/` — sample form JSON.
- `src/providers/` — external-system stubs. Each returns `HttpResponse<T>` (`httpresponse.ts`).
  - `idealpostcodes.ts` — `lookupPostcode` geocoder; **fails ~5% of calls** (returns 500) by design.
  - `sendgrid.ts` — `sendEmail`; also **fails ~5%** by design.
- `tests/` — mirrors `src/`.

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

## Working agreements

- Never work on `main`. Branch per shippable increment (`<feature>/<n>-<slug>`), PR each.
- Aim <400 LOC/branch.
- Tests block deploy. Validator modules get unit tests; endpoints get BDD/supertest tests.
- Log unexpected errors with metadata (esp. `application_reference`).
- Don't leak system internals in user-facing error responses.
