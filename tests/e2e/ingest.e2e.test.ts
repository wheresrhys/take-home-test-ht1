import dotenv from "dotenv";
import request from "supertest";

// Load .env.local before requiring the app: src/providers/postgres-client.ts builds a live pg
// Pool from PGHOST/PGPORT/PGDATABASE/FORM_INGESTER_DB_PASSWORD at import time. `npm test` sets
// DOTENV_CONFIG_PATH=.env.local, but loading here too keeps the suite runnable standalone.
dotenv.config({ path: ".env.local", quiet: true });

// idealpostcodes and sendgrid fail ~5% of calls by design; mock them for determinism. Their
// failure behaviour is covered by the mocked BDD suites (I3–I7), out of scope here. (sendgrid
// isn't wired into the ingest path yet — I2/I16 — but is mocked per the ticket for when it is.)
jest.mock("../../src/providers/idealpostcodes");
jest.mock("../../src/providers/sendgrid");

// Required (not statically imported) after dotenv.config() so the singleton pool is built from
// the loaded env. Unlike the mocked BDD suites, this suite exercises the REAL app against the
// REAL docker Postgres (`npm run db:start`) — it proves the persistence contract the mocks assume.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: app } = require("../../src/app") as typeof import("../../src/app");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { postgresClient } = require("../../src/providers/postgres-client") as typeof import("../../src/providers/postgres-client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lookupPostcode } = require("../../src/providers/idealpostcodes") as typeof import("../../src/providers/idealpostcodes");

const mockedLookupPostcode = lookupPostcode as jest.MockedFunction<typeof lookupPostcode>;

const GEOCODE_RESULT = { latitude: -5.05, longitude: 50.05 };

interface FormsRow {
	session_id: string;
	application_reference: string;
	first_name: string;
	last_name: string;
	email: string;
	gender: string;
	date_of_birth: Date;
	phone_number: string | null;
	mobile_number: string;
	address_line_1: string;
	address_line_2: string;
	address_line_3: string | null;
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

// Jest runs test files in parallel workers against the same live DB (see the crud suite's note),
// so this suite never TRUNCATEs — that would clobber rows other real-DB suites are mid-flight
// with. Instead each test uses a unique application_reference, scopes its assertions to that
// reference, and registers it for individual teardown in afterEach.
let referenceCounter = 0;
function uniqueReference(): string {
	referenceCounter += 1;
	return `E2E-${process.pid}-${Date.now()}-${referenceCounter}`;
}

const referencesToClean = new Set<string>();

function buildIngestedForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const applicationReference = (overrides.application_reference as string) ?? uniqueReference();
	referencesToClean.add(applicationReference);

	return {
		session_id: "session-1",
		application_reference: applicationReference,
		name: "John Doe",
		email: "john.doe@example.com",
		gender: "male",
		date_of_birth: "1990-01-01",
		phone_number: "07123456789",
		mobile_number: "07000000000",
		address: {
			address_line_1: "Stratford Village Surgery",
			address_line_2: "50C Romford Road",
			address_line_3: "London",
			postcode: "E15 4BZ",
			country: "United Kingdom",
		},
		...overrides,
	};
}

function postIngest(data: Record<string, unknown>) {
	return request(app).post("/ingest").send({ data });
}

function getFormsRows(applicationReference: string) {
	return postgresClient.getRecords<FormsRow>("forms", "application_reference", [applicationReference]);
}

function getFormErrorsRows(applicationReference: string) {
	return postgresClient.getRecords<FormErrorsRow>("formerrors", "application_reference", [applicationReference]);
}

describe("POST /ingest (e2e, real test db)", () => {
	beforeEach(() => {
		mockedLookupPostcode.mockResolvedValue({ statusCode: 200, body: GEOCODE_RESULT });
	});

	afterEach(async () => {
		for (const applicationReference of referencesToClean) {
			// Best-effort per-row teardown. delete() throws on a 0-row delete (a reference a test
			// registered but never persisted a row for) — benign here, so swallow it.
			await postgresClient.delete("forms", "application_reference", applicationReference).catch(() => undefined);
			await postgresClient
				.delete("formerrors", "application_reference", applicationReference)
				.catch(() => undefined);
		}
		referencesToClean.clear();
		jest.clearAllMocks();
	});

	afterAll(async () => {
		await postgresClient.end();
	});

	describe("Usual: happy path", () => {
		it("returns 201 for a valid payload", async () => {
			const form = buildIngestedForm();

			const response = await postIngest(form);

			expect(response.status).toBe(201);
			expect(response.body).toEqual({ id: form.application_reference });
		});

		it("persists a Forms row matching the transformed schema (camelCase, lat/long from mocked geocode)", async () => {
			const form = buildIngestedForm();

			await postIngest(form);
			const rows = await getFormsRows(form.application_reference as string);

			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				session_id: "session-1",
				application_reference: form.application_reference,
				first_name: "John",
				last_name: "Doe",
				email: "john.doe@example.com",
				gender: "male",
				phone_number: "07123456789",
				mobile_number: "07000000000",
				address_line_1: "Stratford Village Surgery",
				address_line_2: "50C Romford Road",
				address_line_3: "London",
				postcode: "E15 4BZ",
				country: "United Kingdom",
				longitude: GEOCODE_RESULT.longitude,
				latitude: GEOCODE_RESULT.latitude,
			});
		});

		it("does not write a FormErrors row on success", async () => {
			const form = buildIngestedForm();

			await postIngest(form);
			const formErrorsRows = await getFormErrorsRows(form.application_reference as string);

			expect(formErrorsRows).toHaveLength(0);
		});
	});

	describe("Structure: duplicate application_reference (conflict)", () => {
		it("returns 201 on the first submission and 409 on the second of the same application_reference", async () => {
			const form = buildIngestedForm();

			const firstResponse = await postIngest(form);
			const secondResponse = await postIngest(form);

			expect(firstResponse.status).toBe(201);
			expect(secondResponse.status).toBe(409);
		});

		it("leaves exactly one Forms row for that application_reference after the duplicate attempt", async () => {
			const form = buildIngestedForm();

			await postIngest(form);
			await postIngest(form);
			const rows = await getFormsRows(form.application_reference as string);

			expect(rows).toHaveLength(1);
		});
	});

	describe("Structure: schema validation failure", () => {
		it("returns 400 without leaking internal error details", async () => {
			const invalidForm = buildIngestedForm({ email: undefined });

			const response = await postIngest(invalidForm);

			expect(response.status).toBe(400);
			expect(response.body).toEqual({ message: expect.any(String) });
			expect(Object.keys(response.body)).toEqual(["message"]);
		});

		it("writes a FormErrors row with schema_errors populated", async () => {
			const invalidForm = buildIngestedForm({ email: undefined });

			await postIngest(invalidForm);
			const rows = await getFormErrorsRows(invalidForm.application_reference as string);

			expect(rows).toHaveLength(1);
			// schema_errors is a JSONB column; node-pg parses it back to the JS array persisted.
			expect(Array.isArray(rows[0].schema_errors)).toBe(true);
			expect(rows[0].schema_errors as unknown[]).not.toHaveLength(0);
		});

		it("leaves runtime_errors blank on that FormErrors row", async () => {
			const invalidForm = buildIngestedForm({ email: undefined });

			await postIngest(invalidForm);
			const rows = await getFormErrorsRows(invalidForm.application_reference as string);

			expect(rows).toHaveLength(1);
			expect(rows[0].runtime_errors).toBeNull();
		});

		it("does not create a Forms row", async () => {
			const invalidForm = buildIngestedForm({ email: undefined });

			await postIngest(invalidForm);
			const rows = await getFormsRows(invalidForm.application_reference as string);

			expect(rows).toHaveLength(0);
		});
	});

	describe("Edge: application_reference present but another field invalid", () => {
		it("records application_reference on the FormErrors row when present in the invalid payload", async () => {
			const invalidForm = buildIngestedForm({ gender: "not-a-valid-gender" });

			await postIngest(invalidForm);
			const rows = await getFormErrorsRows(invalidForm.application_reference as string);

			expect(rows).toHaveLength(1);
			expect(rows[0].application_reference).toBe(invalidForm.application_reference);
		});
	});
});
