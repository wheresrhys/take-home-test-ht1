CREATE TABLE IF NOT EXISTS FormErrors (
	id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	application_reference TEXT,
	form_content JSONB NOT NULL,
	schema_errors JSONB,
	runtime_errors JSONB
);

CREATE INDEX IF NOT EXISTS formerrors_application_reference_idx
	ON FormErrors (application_reference);

-- Added after the table's initial creation, so applied idempotently via ADD COLUMN IF NOT
-- EXISTS (per the db/schema/ idempotency rule) rather than folded into the CREATE TABLE above —
-- re-applying this file against an already-provisioned DB must be a no-op on tables that already
-- have these columns. updated_at is bumped by postgresClient.update (src/providers/postgres-client.ts)
-- whenever /retry persists the latest error onto a still-failing row.
ALTER TABLE FormErrors ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE FormErrors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
