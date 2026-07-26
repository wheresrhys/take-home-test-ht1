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

-- Indexes on the camelCase columns.
CREATE INDEX IF NOT EXISTS forms_dateofbirth_idx ON forms ("dateOfBirth");
CREATE INDEX IF NOT EXISTS forms_postcode_idx ON forms ("postcode");
CREATE INDEX IF NOT EXISTS forms_sessionid_idx ON forms ("sessionId");
