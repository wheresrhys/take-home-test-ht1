-- FormErrors: captured failed forms, replayable via /retry after a fix ships. Columns are
-- quoted camelCase identifiers, matching the Forms table's convention (see Forms.sql) so the
-- whole data layer shares one column-naming convention and postgresClient call sites pass
-- camelCase keys directly. `id` stays lowercase (no fold risk). Quoting is load-bearing — an
-- unquoted camelCase identifier folds to lowercase; the postgres client quotes to match.

CREATE TABLE IF NOT EXISTS FormErrors (
	id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"applicationReference" TEXT,
	"formContent" JSONB NOT NULL,
	"schemaErrors" JSONB,
	"runtimeErrors" JSONB,
	"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
	"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent migration for a DB provisioned before the camelCase rename (per the db/schema/
-- re-apply-on-every-db:start rule). Each RENAME is guarded by an information_schema check on the
-- OLD column name: against a fresh/already-migrated DB the old names don't exist and every block
-- is a no-op; against a snake_case DB each column is renamed in place, preserving data.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'formerrors' AND column_name = 'application_reference') THEN
		ALTER TABLE FormErrors RENAME COLUMN application_reference TO "applicationReference";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'formerrors' AND column_name = 'form_content') THEN
		ALTER TABLE FormErrors RENAME COLUMN form_content TO "formContent";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'formerrors' AND column_name = 'schema_errors') THEN
		ALTER TABLE FormErrors RENAME COLUMN schema_errors TO "schemaErrors";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'formerrors' AND column_name = 'runtime_errors') THEN
		ALTER TABLE FormErrors RENAME COLUMN runtime_errors TO "runtimeErrors";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'formerrors' AND column_name = 'created_at') THEN
		ALTER TABLE FormErrors RENAME COLUMN created_at TO "createdAt";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'formerrors' AND column_name = 'updated_at') THEN
		ALTER TABLE FormErrors RENAME COLUMN updated_at TO "updatedAt";
	END IF;
END
$$;

-- Backfill the timestamp columns for a DB provisioned before they existed at all (neither the
-- snake_case nor the camelCase name present) — the CREATE TABLE above only fires on a fresh DB,
-- and the renames above only fire when the old name exists. updatedAt is bumped by
-- postgresClient.update whenever /retry persists the latest error onto a still-failing row.
ALTER TABLE FormErrors ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE FormErrors ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();

-- Index on the camelCase column; the pre-rename name (formerrors_application_reference_idx) is
-- dropped so the index name tracks the new column name.
DROP INDEX IF EXISTS formerrors_application_reference_idx;
CREATE INDEX IF NOT EXISTS formerrors_applicationreference_idx
	ON FormErrors ("applicationReference");
