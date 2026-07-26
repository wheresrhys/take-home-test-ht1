import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config({ path: ".env.local", quiet: true });

// Security-adjacent (privilege boundaries), so this exercises the real docker DB rather
// than mocking `pg` — run `npm run db:start` before `npm test` for this suite to pass.
// Raw SQL here quotes every camelCase column identifier, matching db/schema/*.sql — unquoted
// they would fold to lowercase and fail to resolve.

const adminClient = new Client({
	host: process.env.POSTGRES_HOST,
	port: Number(process.env.POSTGRES_PORT),
	database: process.env.POSTGRES_DB,
	user: process.env.POSTGRES_USER,
	password: process.env.POSTGRES_PASSWORD,
});

const formIngesterClient = new Client({
	host: process.env.POSTGRES_HOST,
	port: Number(process.env.POSTGRES_PORT),
	database: process.env.POSTGRES_DB,
	user: "form_ingester",
	password: process.env.FORM_INGESTER_DB_PASSWORD,
});

function buildFormsRow(applicationReference: string) {
	return {
		sessionId: "session-1",
		applicationReference: applicationReference,
		firstName: "Ada",
		lastName: "Lovelace",
		email: "ada@example.com",
		gender: "female",
		dateOfBirth: "1990-01-01",
		mobileNumber: "07000000000",
		addressLine1: "1 Test Street",
		addressLine2: "Testville",
		postcode: "AB1 2CD",
		country: "UK",
		longitude: -0.1,
		latitude: 51.5,
	};
}

const INSERT_FORMS_SQL = `INSERT INTO forms (
	"sessionId", "applicationReference", "firstName", "lastName", "email", "gender",
	"dateOfBirth", "mobileNumber", "addressLine1", "addressLine2", "postcode",
	"country", "longitude", "latitude"
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`;

function formsRowValues(row: ReturnType<typeof buildFormsRow>): unknown[] {
	return [
		row.sessionId,
		row.applicationReference,
		row.firstName,
		row.lastName,
		row.email,
		row.gender,
		row.dateOfBirth,
		row.mobileNumber,
		row.addressLine1,
		row.addressLine2,
		row.postcode,
		row.country,
		row.longitude,
		row.latitude,
	];
}

async function insertFormsRowAsAdmin(applicationReference: string): Promise<void> {
	await adminClient.query(INSERT_FORMS_SQL, formsRowValues(buildFormsRow(applicationReference)));
}

async function deleteFormsRowAsAdmin(applicationReference: string): Promise<void> {
	await adminClient.query('DELETE FROM forms WHERE "applicationReference" = $1', [applicationReference]);
}

async function insertFormErrorAsAdmin(applicationReference: string): Promise<number> {
	const result = await adminClient.query(
		'INSERT INTO formerrors ("applicationReference", "formContent") VALUES ($1, $2) RETURNING id',
		[applicationReference, JSON.stringify({ example: true })],
	);
	return result.rows[0].id;
}

async function deleteFormErrorAsAdmin(id: number): Promise<void> {
	await adminClient.query("DELETE FROM formerrors WHERE id = $1", [id]);
}

beforeAll(async () => {
	await adminClient.connect();
	await formIngesterClient.connect();
});

afterAll(async () => {
	await adminClient.end();
	await formIngesterClient.end();
});

describe("form_ingester role", () => {
	describe("Forms table", () => {
		it("can SELECT existing rows", async () => {
			const applicationReference = "form-ingester-role-test-select";
			await insertFormsRowAsAdmin(applicationReference);

			const result = await formIngesterClient.query(
				'SELECT "applicationReference" FROM forms WHERE "applicationReference" = $1',
				[applicationReference],
			);

			expect(result.rows).toEqual([{ applicationReference: applicationReference }]);

			await deleteFormsRowAsAdmin(applicationReference);
		});

		it("can INSERT a new row", async () => {
			const applicationReference = "form-ingester-role-test-insert";
			const row = buildFormsRow(applicationReference);

			await formIngesterClient.query(INSERT_FORMS_SQL, formsRowValues(row));

			const result = await adminClient.query(
				'SELECT "applicationReference" FROM forms WHERE "applicationReference" = $1',
				[applicationReference],
			);
			expect(result.rowCount).toBe(1);

			await deleteFormsRowAsAdmin(applicationReference);
		});

		it("can UPDATE an existing row", async () => {
			const applicationReference = "form-ingester-role-test-update";
			await insertFormsRowAsAdmin(applicationReference);

			await formIngesterClient.query('UPDATE forms SET "firstName" = $1 WHERE "applicationReference" = $2', [
				"Grace",
				applicationReference,
			]);

			const result = await adminClient.query('SELECT "firstName" FROM forms WHERE "applicationReference" = $1', [
				applicationReference,
			]);
			expect(result.rows[0].firstName).toBe("Grace");

			await deleteFormsRowAsAdmin(applicationReference);
		});

		it("can DELETE a row", async () => {
			const applicationReference = "form-ingester-role-test-delete";
			await insertFormsRowAsAdmin(applicationReference);

			await formIngesterClient.query('DELETE FROM forms WHERE "applicationReference" = $1', [applicationReference]);

			const result = await adminClient.query('SELECT 1 FROM forms WHERE "applicationReference" = $1', [
				applicationReference,
			]);
			expect(result.rowCount).toBe(0);
		});
	});

	describe("FormErrors table", () => {
		it("can INSERT and receive an auto-generated id", async () => {
			const result = await formIngesterClient.query(
				'INSERT INTO formerrors ("applicationReference", "formContent") VALUES ($1, $2) RETURNING id',
				["form-ingester-role-test-formerrors-insert", JSON.stringify({ example: true })],
			);

			expect(typeof result.rows[0].id).toBe("number");

			await deleteFormErrorAsAdmin(result.rows[0].id);
		});

		it("can SELECT, UPDATE and DELETE rows", async () => {
			const id = await insertFormErrorAsAdmin("form-ingester-role-test-formerrors-crud");

			const selectResult = await formIngesterClient.query("SELECT id FROM formerrors WHERE id = $1", [id]);
			expect(selectResult.rowCount).toBe(1);

			await formIngesterClient.query('UPDATE formerrors SET "schemaErrors" = $1 WHERE id = $2', [
				JSON.stringify(["oops"]),
				id,
			]);
			const updateResult = await adminClient.query('SELECT "schemaErrors" FROM formerrors WHERE id = $1', [id]);
			expect(updateResult.rows[0].schemaErrors).toEqual(["oops"]);

			await formIngesterClient.query("DELETE FROM formerrors WHERE id = $1", [id]);
			const deleteResult = await adminClient.query("SELECT 1 FROM formerrors WHERE id = $1", [id]);
			expect(deleteResult.rowCount).toBe(0);
		});
	});

	describe("privilege boundaries", () => {
		it("cannot CREATE TABLE", async () => {
			await expect(formIngesterClient.query("CREATE TABLE form_ingester_role_test_table (id INT)")).rejects.toThrow();
		});

		it("cannot DROP TABLE Forms", async () => {
			await expect(formIngesterClient.query("DROP TABLE forms")).rejects.toThrow();
		});

		it("has no SUPERUSER/CREATEDB/CREATEROLE attributes", async () => {
			const result = await adminClient.query(
				"SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
				["form_ingester"],
			);

			expect(result.rows).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }]);
		});
	});
});
