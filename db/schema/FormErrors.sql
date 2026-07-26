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

CREATE INDEX IF NOT EXISTS formerrors_applicationreference_idx
	ON FormErrors ("applicationReference");
