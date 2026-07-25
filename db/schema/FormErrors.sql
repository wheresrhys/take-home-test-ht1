CREATE TABLE IF NOT EXISTS FormErrors (
	id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	application_reference TEXT,
	form_content JSONB NOT NULL,
	schema_errors JSONB,
	runtime_errors JSONB
);

CREATE INDEX IF NOT EXISTS formerrors_application_reference_idx
	ON FormErrors (application_reference);
