-- Forms table: mirrors the outbound shape in src/forms/schemas/transformed_schema.ts.
-- application_reference is the PRIMARY KEY — this is the dedupe mechanism for
-- at-least-once delivery from the provider (see README.md / CLAUDE.md).

CREATE TABLE IF NOT EXISTS forms (
	session_id TEXT NOT NULL,
	application_reference TEXT PRIMARY KEY,
	first_name TEXT NOT NULL,
	last_name TEXT NOT NULL,
	email TEXT NOT NULL,
	gender TEXT NOT NULL CHECK (gender IN ('male', 'female', 'prefer-not-to-say')),
	date_of_birth DATE NOT NULL,
	phone_number TEXT,
	mobile_number TEXT NOT NULL,
	address_line_1 TEXT NOT NULL,
	address_line_2 TEXT NOT NULL,
	address_line_3 TEXT,
	postcode TEXT NOT NULL,
	country TEXT NOT NULL,
	longitude DOUBLE PRECISION NOT NULL,
	latitude DOUBLE PRECISION NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forms_date_of_birth_idx ON forms (date_of_birth);
CREATE INDEX IF NOT EXISTS forms_postcode_idx ON forms (postcode);
