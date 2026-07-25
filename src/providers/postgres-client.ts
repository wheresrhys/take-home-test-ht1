import { Pool, QueryResult, QueryResultRow } from "pg";

const REQUIRED_ENV_VARS = ["PGHOST", "PGPORT", "PGDATABASE", "FORM_INGESTER_DB_PASSWORD"] as const;

// The minimal surface the CRUD helpers need to run a parameterised query. Satisfied by both the
// shared `Pool` (the default, unchanged pool-query behaviour) and a checked-out transactional
// `PoolClient` (from withTransaction), so the same query bodies run either on the pool or inside
// a transaction depending on which executor the caller threads through.
export interface QueryExecutor {
	query<T extends QueryResultRow>(queryText: string, values?: unknown[]): Promise<QueryResult<T>>;
}

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
	executor: QueryExecutor,
	tableName: string,
	data: Record<string, unknown>,
): Promise<T> {
	const columnNames = Object.keys(data);
	const values = Object.values(data);
	const placeholders = values.map((_value, index) => `$${index + 1}`).join(", ");

	const { rows } = await executor.query<T>(
		`INSERT INTO ${tableName} (${columnNames.join(", ")}) VALUES (${placeholders}) RETURNING *`,
		values,
	);

	return rows[0];
}

async function getRecords<T extends QueryResultRow>(
	executor: QueryExecutor,
	tableName: string,
	idColumn: string,
	ids: (string | number)[],
): Promise<T[]> {
	// Guard early: an empty IN (...) is invalid SQL, and there can be no matches anyway.
	if (ids.length === 0) {
		return [];
	}

	const placeholders = ids.map((_id, index) => `$${index + 1}`).join(", ");

	const { rows } = await executor.query<T>(`SELECT * FROM ${tableName} WHERE ${idColumn} IN (${placeholders})`, ids);

	return rows;
}

async function deleteRecord(
	executor: QueryExecutor,
	tableName: string,
	idColumn: string,
	id: string | number,
): Promise<void> {
	const { rowCount } = await executor.query(`DELETE FROM ${tableName} WHERE ${idColumn} = $1`, [id]);

	if (!rowCount) {
		throw new Error(`postgres-client: delete affected 0 rows — no ${tableName} row with ${idColumn} = ${id}`);
	}
}

export interface PostgresClient extends Pool {
	// Each query method takes an optional `executor`: omitted (the default) it runs on the shared
	// pool exactly as before; passed a transactional client (from withTransaction) it runs that
	// query inside the transaction instead. The /ingest path passes nothing, so it is unchanged.
	create<T extends QueryResultRow>(
		tableName: string,
		data: Record<string, unknown>,
		executor?: QueryExecutor,
	): Promise<T>;
	getRecords<T extends QueryResultRow>(
		tableName: string,
		idColumn: string,
		ids: (string | number)[],
		executor?: QueryExecutor,
	): Promise<T[]>;
	delete(tableName: string, idColumn: string, id: string | number, executor?: QueryExecutor): Promise<void>;
	// Runs `callback` inside a single transaction on a dedicated client checked out from the pool:
	// BEGIN, then `callback(client)` (the client is the executor to thread into the CRUD methods),
	// COMMIT on success or ROLLBACK if it throws, and the client is ALWAYS released afterwards.
	withTransaction<T>(callback: (executor: QueryExecutor) => Promise<T>): Promise<T>;
}

// Checks out a dedicated client so BEGIN/COMMIT/ROLLBACK all run on the same connection (pool-level
// queries would each grab an arbitrary connection, defeating the transaction). The client is
// released in a `finally` so a leak can't happen on either the success or the failure path.
async function withTransaction<T>(pool: Pool, callback: (executor: QueryExecutor) => Promise<T>): Promise<T> {
	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		const result = await callback(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

// Singleton pool, built once at module load, with create/getRecords/delete query methods
// attached (rather than exported standalone) so callers hang a single postgresClient off
// this module instead of importing the pool and the query helpers separately. `delete` is a
// reserved word as a declared identifier, but is a perfectly valid object property name.
const pool = createPostgresPool();

export const postgresClient: PostgresClient = Object.assign(pool, {
	create: <T extends QueryResultRow>(tableName: string, data: Record<string, unknown>, executor: QueryExecutor = pool) =>
		create<T>(executor, tableName, data),
	getRecords: <T extends QueryResultRow>(
		tableName: string,
		idColumn: string,
		ids: (string | number)[],
		executor: QueryExecutor = pool,
	) => getRecords<T>(executor, tableName, idColumn, ids),
	delete: (tableName: string, idColumn: string, id: string | number, executor: QueryExecutor = pool) =>
		deleteRecord(executor, tableName, idColumn, id),
	withTransaction: <T>(callback: (executor: QueryExecutor) => Promise<T>) => withTransaction<T>(pool, callback),
});
