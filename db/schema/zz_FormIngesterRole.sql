-- form_ingester: the role the app connects as (never the superuser). Prefixed zz_ so
-- filename-sort order (see db/schema/README.md) applies this after Forms.sql and
-- FormErrors.sql, since the grants below target those tables.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'form_ingester') THEN
		CREATE ROLE form_ingester WITH LOGIN PASSWORD 'ingesterpassword'
			NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	END IF;
END
$$;

-- Idempotent re-run keeps the password in sync with .env.local's FORM_INGESTER_DB_PASSWORD.
ALTER ROLE form_ingester WITH PASSWORD 'ingesterpassword';

GRANT SELECT, INSERT, UPDATE, DELETE ON forms, FormErrors TO form_ingester;

-- Needed for `INSERT ... RETURNING id` against FormErrors under a non-owner role.
-- Forms' PK ("applicationReference") is app-supplied, so no sequence grant there.
GRANT USAGE, SELECT ON SEQUENCE formerrors_id_seq TO form_ingester;
