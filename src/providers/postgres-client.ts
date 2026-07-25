import { Pool, QueryResultRow } from "pg";

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

async function update<T extends QueryResultRow>(
	pool: Pool,
	tableName: string,
	idColumn: string,
	id: string | number,
	data: Record<string, unknown>,
): Promise<T> {
	const columnNames = Object.keys(data);
	const values = Object.values(data);
	// updated_at is always bumped to now() alongside the caller's columns, rather than left to
	// the caller to pass — every update() call represents the row changing, so this keeps
	// call sites from having to remember it.
	const setClauses = columnNames
		.map((columnName, index) => `${columnName} = $${index + 1}`)
		.concat("updated_at = now()");

	const { rows } = await pool.query<T>(
		`UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${idColumn} = $${values.length + 1} RETURNING *`,
		[...values, id],
	);

	if (rows.length === 0) {
		throw new Error(`postgres-client: update affected 0 rows — no ${tableName} row with ${idColumn} = ${id}`);
	}

	return rows[0];
}

async function deleteRecord(pool: Pool, tableName: string, idColumn: string, id: string | number): Promise<void> {
	const { rowCount } = await pool.query(`DELETE FROM ${tableName} WHERE ${idColumn} = $1`, [id]);

	if (!rowCount) {
		throw new Error(`postgres-client: delete affected 0 rows — no ${tableName} row with ${idColumn} = ${id}`);
	}
}

export interface PostgresClient extends Pool {
	create<T extends QueryResultRow>(tableName: string, data: Record<string, unknown>): Promise<T>;
	getRecords<T extends QueryResultRow>(tableName: string, idColumn: string, ids: (string | number)[]): Promise<T[]>;
	update<T extends QueryResultRow>(
		tableName: string,
		idColumn: string,
		id: string | number,
		data: Record<string, unknown>,
	): Promise<T>;
	delete(tableName: string, idColumn: string, id: string | number): Promise<void>;
}

// Singleton pool, built once at module load, with create/getRecords/update/delete query methods
// attached (rather than exported standalone) so callers hang a single postgresClient off
// this module instead of importing the pool and the query helpers separately. `delete` is a
// reserved word as a declared identifier, but is a perfectly valid object property name.
const pool = createPostgresPool();

export const postgresClient: PostgresClient = Object.assign(pool, {
	create: <T extends QueryResultRow>(tableName: string, data: Record<string, unknown>) =>
		create<T>(pool, tableName, data),
	getRecords: <T extends QueryResultRow>(tableName: string, idColumn: string, ids: (string | number)[]) =>
		getRecords<T>(pool, tableName, idColumn, ids),
	update: <T extends QueryResultRow>(
		tableName: string,
		idColumn: string,
		id: string | number,
		data: Record<string, unknown>,
	) => update<T>(pool, tableName, idColumn, id, data),
	delete: (tableName: string, idColumn: string, id: string | number) => deleteRecord(pool, tableName, idColumn, id),
});
