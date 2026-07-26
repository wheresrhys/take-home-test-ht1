import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

// Integration tests for the create/getRecords/update/delete methods attached to the
// postgresClient singleton. These build and run real SQL, so — unlike
// tests/providers/postgres-client.test.ts, which mocks `pg` to unit test createPostgresPool()'s
// env-var handling — this suite exercises the real docker DB. Run `npm run db:start` before
// `npm test` for this suite to pass.
//
// Columns are quoted camelCase (see db/schema/Forms.sql / FormErrors.sql). The postgres client
// quotes every column identifier so these camelCase columns resolve instead of folding to
// lowercase — the describe("postgres-client column quoting") block below is the explicit
// regression guard for that fold-prone bug class.
//
// Jest runs test files in parallel workers against the *same* live DB, so this suite must never
// table-wide TRUNCATE (that would clobber rows tests/db/formIngesterRole.test.ts is mid-flight
// with). Instead every test uses unique applicationReferences and registers exactly the rows it
// creates for individual teardown in afterEach.
//
// postgresClient is a singleton built at module load time from env vars, so it's required here
// (rather than statically imported) only after dotenv.config() has populated process.env.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { postgresClient } = require("../../src/providers/postgres-client") as typeof import("../../src/providers/postgres-client");

interface FormsRow {
	sessionId: string;
	applicationReference: string;
	firstName: string;
	lastName: string;
	email: string;
	gender: string;
	mobileNumber: string;
	addressLine1: string;
	addressLine2: string;
	postcode: string;
	country: string;
	longitude: number;
	latitude: number;
}

interface FormErrorsRow {
	id: number;
	applicationReference: string | null;
	formContent: unknown;
	schemaErrors: unknown;
	runtimeErrors: unknown;
	createdAt: string;
	updatedAt: string;
}

// Rows this suite created, torn down individually in afterEach so parallel workers on the same
// DB never interfere with each other's data.
const createdFormsReferences = new Set<string>();
const createdFormErrorIds = new Set<number>();

function buildFormsRow(applicationReference: string): Record<string, unknown> {
	createdFormsReferences.add(applicationReference);
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

function buildFormErrorRow(
	applicationReference: string,
	extraColumns: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		applicationReference: applicationReference,
		formContent: JSON.stringify({ example: true }),
		...extraColumns,
	};
}

afterEach(async () => {
	for (const applicationReference of createdFormsReferences) {
		await postgresClient.delete("forms", "applicationReference", applicationReference);
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
		expect(result.applicationReference).toBe("create-test-formerrors-generated-id");
	});

	it("returns a row shaped like the forms table for a Forms insert", async () => {
		const result = await postgresClient.create<FormsRow>("forms", buildFormsRow("create-test-forms"));

		expect(result).toMatchObject({
			applicationReference: "create-test-forms",
			firstName: "Ada",
			lastName: "Lovelace",
		});
	});

	it("returns the FormErrors columns for a FormErrors insert", async () => {
		const result = await postgresClient.create<FormErrorsRow>(
			"formerrors",
			buildFormErrorRow("create-test-formerrors-columns", { schemaErrors: JSON.stringify(["oops"]) }),
		);
		createdFormErrorIds.add(result.id);

		expect(result).toMatchObject({
			applicationReference: "create-test-formerrors-columns",
			schemaErrors: ["oops"],
			runtimeErrors: null,
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

		const results = await postgresClient.getRecords<FormsRow>("forms", "applicationReference", [
			"get-records-1",
			"get-records-2",
		]);

		expect(results.map((row) => row.applicationReference).sort()).toEqual(["get-records-1", "get-records-2"]);
	});

	it("works across idColumn values, e.g. id on FormErrors rather than applicationReference", async () => {
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

		const results = await postgresClient.getRecords("forms", "applicationReference", []);

		expect(results).toEqual([]);
		expect(querySpy).not.toHaveBeenCalled();

		querySpy.mockRestore();
	});

	it("resolves with [] when no rows match", async () => {
		const results = await postgresClient.getRecords("forms", "applicationReference", ["get-records-no-match"]);

		expect(results).toEqual([]);
	});
});

describe("postgresClient.update", () => {
	it("updates the named column and returns the updated row", async () => {
		const created = await postgresClient.create<FormErrorsRow>(
			"formerrors",
			buildFormErrorRow("update-test-single-column"),
		);
		createdFormErrorIds.add(created.id);

		const updated = await postgresClient.update<FormErrorsRow>("formerrors", "id", created.id, {
			schemaErrors: JSON.stringify(["still invalid"]),
		});

		expect(updated.schemaErrors).toEqual(["still invalid"]);
	});

	it("bumps updatedAt to strictly after the prior value", async () => {
		const created = await postgresClient.create<FormErrorsRow>(
			"formerrors",
			buildFormErrorRow("update-test-bumps-updated-at"),
		);
		createdFormErrorIds.add(created.id);

		const updated = await postgresClient.update<FormErrorsRow>("formerrors", "id", created.id, {
			schemaErrors: JSON.stringify(["still invalid"]),
		});

		expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
	});

	it("updates multiple columns in one call", async () => {
		const created = await postgresClient.create<FormErrorsRow>(
			"formerrors",
			buildFormErrorRow("update-test-multiple-columns"),
		);
		createdFormErrorIds.add(created.id);

		const updated = await postgresClient.update<FormErrorsRow>("formerrors", "id", created.id, {
			schemaErrors: JSON.stringify(["schema oops"]),
			runtimeErrors: JSON.stringify(["runtime oops"]),
		});

		expect(updated).toMatchObject({
			schemaErrors: ["schema oops"],
			runtimeErrors: ["runtime oops"],
		});
	});

	it("rejects when the id matches 0 rows, leaving other rows untouched", async () => {
		const created = await postgresClient.create<FormErrorsRow>(
			"formerrors",
			buildFormErrorRow("update-test-untouched"),
		);
		createdFormErrorIds.add(created.id);

		await expect(
			postgresClient.update("formerrors", "id", -1, { schemaErrors: JSON.stringify(["oops"]) }),
		).rejects.toThrow(/-1/);

		const results = await postgresClient.getRecords<FormErrorsRow>("formerrors", "id", [created.id]);
		expect(results[0].schemaErrors).toBeNull();
	});
});

describe("postgresClient.delete", () => {
	it("removes the single matching row — a follow-up getRecords resolves []", async () => {
		await postgresClient.create("forms", buildFormsRow("delete-test-existing"));

		await postgresClient.delete("forms", "applicationReference", "delete-test-existing");
		// Deleted here already — unregister so afterEach's own teardown delete doesn't
		// re-attempt it and reject on the now-nonexistent row.
		createdFormsReferences.delete("delete-test-existing");

		const results = await postgresClient.getRecords("forms", "applicationReference", ["delete-test-existing"]);
		expect(results).toEqual([]);
	});

	it("rejects for a non-existent id, leaving other rows untouched", async () => {
		await postgresClient.create("forms", buildFormsRow("delete-test-untouched"));

		await expect(
			postgresClient.delete("forms", "applicationReference", "delete-test-does-not-exist"),
		).rejects.toThrow(/delete-test-does-not-exist/);

		const results = await postgresClient.getRecords("forms", "applicationReference", ["delete-test-untouched"]);
		expect(results).toHaveLength(1);
	});
});

// Regression guard for the silent-fold bug class this ticket closes: an unquoted camelCase
// identifier folds to lowercase (sessionId -> sessionid), which doesn't exist. Every helper here
// runs against the real DB, so an unquoted identifier would raise a "column does not exist" error
// rather than pass — these tests prove the client quotes the INSERT column list, WHERE clause,
// SET clause and RETURNING projection for a fold-prone column.
describe("postgres-client column quoting", () => {
	it("Usual: create then getRecords round-trips a row whose columns are camelCase", async () => {
		await postgresClient.create("forms", buildFormsRow("quoting-round-trip"));

		const results = await postgresClient.getRecords<FormsRow>("forms", "applicationReference", [
			"quoting-round-trip",
		]);

		expect(results).toHaveLength(1);
		expect(results[0].applicationReference).toBe("quoting-round-trip");
	});

	it("Edge: a fold-prone column (sessionId) is written and read back intact", async () => {
		await postgresClient.create("forms", { ...buildFormsRow("quoting-sessionid"), sessionId: "fold-prone-session" });

		// getRecords BY the fold-prone column exercises quoting in the WHERE clause too, not just
		// the INSERT column list — an unquoted "sessionId" here would fold to sessionid and error.
		const results = await postgresClient.getRecords<FormsRow>("forms", "sessionId", ["fold-prone-session"]);

		const row = results.find((r) => r.applicationReference === "quoting-sessionid");
		expect(row?.sessionId).toBe("fold-prone-session");
	});

	it("Structure: update's SET and WHERE quote camelCase identifiers", async () => {
		const created = await postgresClient.create<FormErrorsRow>(
			"formerrors",
			buildFormErrorRow("quoting-update"),
		);
		createdFormErrorIds.add(created.id);

		// schemaErrors in SET + id in WHERE + the auto-bumped updatedAt all need quoting.
		const updated = await postgresClient.update<FormErrorsRow>("formerrors", "id", created.id, {
			schemaErrors: JSON.stringify(["quoted"]),
		});

		expect(updated.schemaErrors).toEqual(["quoted"]);
	});
});
