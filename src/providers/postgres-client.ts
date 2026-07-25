import { DatabaseError, Pool, QueryResultRow } from "pg";

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

// Generic CRUD methods attached onto the singleton pool below. Table/column identifiers
// (tableName/idColumn) are only ever passed by trusted internal call sites (Forms/FormErrors
// repositories) — never sourced from request bodies — so they're interpolated directly into
// the query text. All *values* go through as query parameters ($1, $2, ...), never concatenated.
async function create<T extends QueryResultRow>(
	pool: Pool,
	tableName: string,
	data: Record<string, unknown>,
): Promise<T> {
	const columnNames = Object.keys(data);
	const values = Object.values(data);
	const placeholders = values.map((_value, index) => `$${index + 1}`).join(", ");

	const { rows } = await pool.query<T>(
		`INSERT INTO ${tableName} (${columnNames.join(", ")}) VALUES (${placeholders}) RETURNING *`,
		values,
	);

	return rows[0];
}

async function getRecords<T extends QueryResultRow>(
	pool: Pool,
	tableName: string,
	idColumn: string,
	ids: (string | number)[],
): Promise<T[]> {
	// Guard early: an empty IN (...) is invalid SQL, and there can be no matches anyway.
	if (ids.length === 0) {
		return [];
	}

	const placeholders = ids.map((_id, index) => `$${index + 1}`).join(", ");

	const { rows } = await pool.query<T>(`SELECT * FROM ${tableName} WHERE ${idColumn} IN (${placeholders})`, ids);

	return rows;
}

async function deleteRecord(pool: Pool, tableName: string, idColumn: string, id: string | number): Promise<void> {
	const { rowCount } = await pool.query(`DELETE FROM ${tableName} WHERE ${idColumn} = $1`, [id]);

	if (!rowCount) {
		throw new Error(`postgres-client: delete affected 0 rows — no ${tableName} row with ${idColumn} = ${id}`);
	}
}

// Postgres protocol-level failures (constraint violations, syntax errors, etc.) reject as pg's
// own DatabaseError class — a first-party, stable signal that a given error came from the DB
// itself, rather than from application code elsewhere in the request pipeline. Exported so
// callers (e.g. the Express error-handling middleware in app.ts) can branch on "was this a DB
// error" without string-matching on messages or inventing a parallel classification scheme.
// Connection-level failures (DB unreachable) aren't DatabaseError instances — out of scope here,
// see the ticket notes on not building a full DB-failure taxonomy.
export function isDatabaseError(err: unknown): err is DatabaseError {
	return err instanceof DatabaseError;
}

export interface PostgresClient extends Pool {
	create<T extends QueryResultRow>(tableName: string, data: Record<string, unknown>): Promise<T>;
	getRecords<T extends QueryResultRow>(tableName: string, idColumn: string, ids: (string | number)[]): Promise<T[]>;
	delete(tableName: string, idColumn: string, id: string | number): Promise<void>;
}

// Singleton pool, built once at module load, with create/getRecords/delete query methods
// attached (rather than exported standalone) so callers hang a single postgresClient off
// this module instead of importing the pool and the query helpers separately. `delete` is a
// reserved word as a declared identifier, but is a perfectly valid object property name.
const pool = createPostgresPool();

export const postgresClient: PostgresClient = Object.assign(pool, {
	create: <T extends QueryResultRow>(tableName: string, data: Record<string, unknown>) =>
		create<T>(pool, tableName, data),
	getRecords: <T extends QueryResultRow>(tableName: string, idColumn: string, ids: (string | number)[]) =>
		getRecords<T>(pool, tableName, idColumn, ids),
	delete: (tableName: string, idColumn: string, id: string | number) => deleteRecord(pool, tableName, idColumn, id),
});
