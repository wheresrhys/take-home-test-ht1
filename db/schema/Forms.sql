-- Forms table: mirrors the outbound shape in src/forms/schemas/transformed_schema.ts.
-- Columns are quoted camelCase identifiers matching TransformedFormSchema exactly, so
-- postgresClient.create("forms", transformedRow) persists the transformed row directly with
-- no snake_case remapping. Quoting is load-bearing: an unquoted camelCase identifier folds to
-- lowercase (e.g. sessionId -> sessionid), so both this schema and the postgres client
-- (src/providers/postgres-client.ts) must quote every column identifier.
-- "applicationReference" is the PRIMARY KEY — the dedupe mechanism for at-least-once delivery
-- from the provider (see README.md / CLAUDE.md).

CREATE TABLE IF NOT EXISTS forms (
	"sessionId" TEXT NOT NULL,
	"applicationReference" TEXT PRIMARY KEY,
	"firstName" TEXT NOT NULL,
	"lastName" TEXT NOT NULL,
	"email" TEXT NOT NULL,
	"gender" TEXT NOT NULL CHECK ("gender" IN ('male', 'female', 'prefer-not-to-say')),
	"dateOfBirth" DATE NOT NULL,
	"phoneNumber" TEXT,
	"mobileNumber" TEXT NOT NULL,
	"addressLine1" TEXT NOT NULL,
	"addressLine2" TEXT NOT NULL,
	"addressLine3" TEXT,
	"postcode" TEXT NOT NULL,
	"country" TEXT NOT NULL,
	"longitude" DOUBLE PRECISION NOT NULL,
	"latitude" DOUBLE PRECISION NOT NULL,
	"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
	"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent migration for a DB provisioned before the camelCase rename (per the db/schema/
-- re-apply-on-every-db:start rule). Each RENAME is guarded by an information_schema check on the
-- OLD column name, so: against a fresh/already-migrated DB the old names don't exist and every
-- block is a no-op; against a snake_case DB each column is renamed in place, preserving data.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'session_id') THEN
		ALTER TABLE forms RENAME COLUMN session_id TO "sessionId";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'application_reference') THEN
		ALTER TABLE forms RENAME COLUMN application_reference TO "applicationReference";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'first_name') THEN
		ALTER TABLE forms RENAME COLUMN first_name TO "firstName";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'last_name') THEN
		ALTER TABLE forms RENAME COLUMN last_name TO "lastName";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'date_of_birth') THEN
		ALTER TABLE forms RENAME COLUMN date_of_birth TO "dateOfBirth";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'phone_number') THEN
		ALTER TABLE forms RENAME COLUMN phone_number TO "phoneNumber";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'mobile_number') THEN
		ALTER TABLE forms RENAME COLUMN mobile_number TO "mobileNumber";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'address_line_1') THEN
		ALTER TABLE forms RENAME COLUMN address_line_1 TO "addressLine1";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'address_line_2') THEN
		ALTER TABLE forms RENAME COLUMN address_line_2 TO "addressLine2";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'address_line_3') THEN
		ALTER TABLE forms RENAME COLUMN address_line_3 TO "addressLine3";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'created_at') THEN
		ALTER TABLE forms RENAME COLUMN created_at TO "createdAt";
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forms' AND column_name = 'updated_at') THEN
		ALTER TABLE forms RENAME COLUMN updated_at TO "updatedAt";
	END IF;
END
$$;

-- Indexes on the camelCase columns. The pre-rename names (forms_date_of_birth_idx,
-- forms_session_id_idx) are dropped so index names track the new column names; forms_postcode_idx
-- is unchanged (postcode needs no rename).
DROP INDEX IF EXISTS forms_date_of_birth_idx;
DROP INDEX IF EXISTS forms_session_id_idx;
CREATE INDEX IF NOT EXISTS forms_dateofbirth_idx ON forms ("dateOfBirth");
CREATE INDEX IF NOT EXISTS forms_postcode_idx ON forms ("postcode");
CREATE INDEX IF NOT EXISTS forms_sessionid_idx ON forms ("sessionId");
