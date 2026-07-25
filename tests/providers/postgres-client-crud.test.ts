import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

// Integration tests for the create/getRecords/delete methods attached to the postgresClient
// singleton. These build and run real SQL, so — unlike tests/providers/postgres-client.test.ts,
// which mocks `pg` to unit test createPostgresPool()'s env-var handling — this suite exercises
// the real docker DB. Run `npm run db:start` before `npm test` for this suite to pass.
//
// Jest runs test files in parallel workers against the *same* live DB, so this suite must never
// table-wide TRUNCATE (that would clobber rows tests/db/formIngesterRole.test.ts is mid-flight
// with). Instead every test uses unique application_references and registers exactly the rows it
// creates for individual teardown in afterEach.
//
// postgresClient is a singleton built at module load time from env vars, so it's required here
// (rather than statically imported) only after dotenv.config() has populated process.env.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { postgresClient } = require("../../src/providers/postgres-client") as typeof import("../../src/providers/postgres-client");

interface FormsRow {
	session_id: string;
	application_reference: string;
	first_name: string;
	last_name: string;
	email: string;
	gender: string;
	mobile_number: string;
	address_line_1: string;
	address_line_2: string;
	postcode: string;
	country: string;
	longitude: number;
	latitude: number;
}

interface FormErrorsRow {
	id: number;
	application_reference: string | null;
	form_content: unknown;
	schema_errors: unknown;
	runtime_errors: unknown;
}

// Rows this suite created, torn down individually in afterEach so parallel workers on the same
// DB never interfere with each other's data.
const createdFormsReferences = new Set<string>();
const createdFormErrorIds = new Set<number>();

function buildFormsRow(applicationReference: string): Record<string, unknown> {
	createdFormsReferences.add(applicationReference);
	return {
		session_id: "session-1",
		application_reference: applicationReference,
		first_name: "Ada",
		last_name: "Lovelace",
		email: "ada@example.com",
		gender: "female",
		date_of_birth: "1990-01-01",
		mobile_number: "07000000000",
		address_line_1: "1 Test Street",
		address_line_2: "Testville",
		postcode: "AB1 2CD",
		country: "UK",
		longitude: -0.1,
		latitude: 51.5,
	};
}

function buildFormErrorRow(
	applicationReference: string,
	extraColumns: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		application_reference: applicationReference,
		form_content: JSON.stringify({ example: true }),
		...extraColumns,
	};
}

afterEach(async () => {
	for (const applicationReference of createdFormsReferences) {
		await postgresClient.delete("forms", "application_reference", applicationReference);
	}
	for (const formErrorId of createdFormErrorIds) {
		await postgresClient.delete("formerrors", "id", formErrorId);
	}
	createdFormsReferences.clear();
	createdFormErrorIds.clear();
});

afterAll(async () => {
	await postgresClient.end();
});

describe("postgresClient.create", () => {
	it("inserts a row for an existing table and resolves with the created row, including DB-generated fields", async () => {
		const result = await postgresClient.create<FormErrorsRow>(
			"formerrors",
			buildFormErrorRow("create-test-formerrors-generated-id"),
		);
		createdFormErrorIds.add(result.id);

		expect(result.id).toEqual(expect.any(Number));
		expect(result.application_reference).toBe("create-test-formerrors-generated-id");
	});

	it("returns a row shaped like the forms table for a Forms insert", async () => {
		const result = await postgresClient.create<FormsRow>("forms", buildFormsRow("create-test-forms"));

		expect(result).toMatchObject({
			application_reference: "create-test-forms",
			first_name: "Ada",
			last_name: "Lovelace",
		});
	});

	it("returns the FormErrors columns for a FormErrors insert", async () => {
		const result = await postgresClient.create<FormErrorsRow>(
			"formerrors",
			buildFormErrorRow("create-test-formerrors-columns", { schema_errors: JSON.stringify(["oops"]) }),
		);
		createdFormErrorIds.add(result.id);

		expect(result).toMatchObject({
			application_reference: "create-test-formerrors-columns",
			schema_errors: ["oops"],
			runtime_errors: null,
		});
	});

	it("rejects with the underlying Postgres conflict error on a primary-key collision", async () => {
		const row = buildFormsRow("create-test-conflict");
		await postgresClient.create("forms", row);

		await expect(postgresClient.create("forms", row)).rejects.toMatchObject({ code: "23505" });
	});
});

describe("postgresClient.getRecords", () => {
	it("resolves with rows whose idColumn matches ids", async () => {
		await postgresClient.create("forms", buildFormsRow("get-records-1"));
		await postgresClient.create("forms", buildFormsRow("get-records-2"));

		const results = await postgresClient.getRecords<FormsRow>("forms", "application_reference", [
			"get-records-1",
			"get-records-2",
		]);

		expect(results.map((row) => row.application_reference).sort()).toEqual(["get-records-1", "get-records-2"]);
	});

	it("works across idColumn values, e.g. id on FormErrors rather than application_reference", async () => {
		const created = await postgresClient.create<FormErrorsRow>(
			"formerrors",
			buildFormErrorRow("get-records-formerrors"),
		);
		createdFormErrorIds.add(created.id);

		const results = await postgresClient.getRecords<FormErrorsRow>("formerrors", "id", [created.id]);

		expect(results).toHaveLength(1);
		expect(results[0].id).toBe(created.id);
	});

	it("resolves with [] and issues no query for an empty ids array", async () => {
		const querySpy = jest.spyOn(postgresClient, "query");

		const results = await postgresClient.getRecords("forms", "application_reference", []);

		expect(results).toEqual([]);
		expect(querySpy).not.toHaveBeenCalled();

		querySpy.mockRestore();
	});

	it("resolves with [] when no rows match", async () => {
		const results = await postgresClient.getRecords("forms", "application_reference", ["get-records-no-match"]);

		expect(results).toEqual([]);
	});
});

describe("postgresClient.delete", () => {
	it("removes the single matching row — a follow-up getRecords resolves []", async () => {
		await postgresClient.create("forms", buildFormsRow("delete-test-existing"));

		await postgresClient.delete("forms", "application_reference", "delete-test-existing");

		const results = await postgresClient.getRecords("forms", "application_reference", ["delete-test-existing"]);
		expect(results).toEqual([]);
	});

	it("resolves without throwing for a non-existent id, leaving other rows untouched", async () => {
		await postgresClient.create("forms", buildFormsRow("delete-test-untouched"));

		await expect(
			postgresClient.delete("forms", "application_reference", "delete-test-does-not-exist"),
		).resolves.toBeUndefined();

		const results = await postgresClient.getRecords("forms", "application_reference", ["delete-test-untouched"]);
		expect(results).toHaveLength(1);
	});
});
