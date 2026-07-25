import { Pool } from "pg";

const REQUIRED_ENV_VARS = ["PGHOST", "PGPORT", "PGDATABASE", "FORM_INGESTER_DB_PASSWORD"] as const;

export const createPostgresPool = (): Pool => {
	const missingEnvVarNames = REQUIRED_ENV_VARS.filter((envVarName) => !process.env[envVarName]);

	if (missingEnvVarNames.length > 0) {
		throw new Error(`postgres-client: missing required env var(s): ${missingEnvVarNames.join(", ")}`);
	}

	return new Pool({
		host: process.env.PGHOST,
		port: Number(process.env.PGPORT),
		database: process.env.PGDATABASE,
		// Hardcoded, never sourced from env (e.g. a stray PGUSER) — the app must only ever
		// connect as the least-privileged form_ingester role (see db/schema/zz_FormIngesterRole.sql).
		user: "form_ingester",
		password: process.env.FORM_INGESTER_DB_PASSWORD,
	});
};

// Singleton pool, built once at module load. D8 attaches create/getRecords/delete query
// methods onto this via postgresClient.query(...).
export const postgresClient: Pool = createPostgresPool();
