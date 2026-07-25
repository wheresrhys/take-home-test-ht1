import request from "supertest";
import { DatabaseError } from "pg";

jest.mock("../../src/providers/idealpostcodes");
// isDatabaseError is reimplemented here (rather than jest.requireActual'd) so this suite never
// loads the real postgres-client module — that module builds a live pg Pool from env vars at
// import time, which this mocked-DB suite has no need for. The logic mirrors the real guard
// exactly: pg's own DatabaseError class, imported directly above.
jest.mock("../../src/providers/postgres-client", () => ({
	postgresClient: { create: jest.fn() },
	isDatabaseError: (err: unknown) => err instanceof require("pg").DatabaseError,
}));

import app from "../../src/app";
import { lookupPostcode } from "../../src/providers/idealpostcodes";
import { postgresClient } from "../../src/providers/postgres-client";

const mockedLookupPostcode = lookupPostcode as jest.MockedFunction<typeof lookupPostcode>;
const mockedCreate = postgresClient.create as jest.Mock;

const GEOCODE_RESULT = { latitude: -5.05, longitude: 50.05 };

function buildIngestedForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		session_id: "session-1",
		application_reference: "GRU-123089-2026",
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

describe("POST /ingest", () => {
	beforeEach(() => {
		mockedLookupPostcode.mockResolvedValue({ statusCode: 200, body: GEOCODE_RESULT });
		mockedCreate.mockResolvedValue({});
	});

	afterEach(() => {
		jest.resetAllMocks();
	});

	describe("happy path", () => {
		it("responds 201 with the created record's id when data is valid", async () => {
			const response = await postIngest(buildIngestedForm());

			expect(response.status).toBe(201);
			expect(response.body).toEqual({ id: "GRU-123089-2026" });
		});

		it("calls idealpostcodes.lookupPostcode with the submitted postcode", async () => {
			await postIngest(buildIngestedForm());

			expect(mockedLookupPostcode).toHaveBeenCalledWith("E15 4BZ");
		});

		it("calls the db client's create with table 'forms' and the transformed row", async () => {
			await postIngest(buildIngestedForm());

			expect(mockedCreate).toHaveBeenCalledWith(
				"forms",
				expect.objectContaining({
					sessionId: "session-1",
					applicationReference: "GRU-123089-2026",
					firstName: "John",
					lastName: "Doe",
					email: "john.doe@example.com",
					gender: "male",
					dateOfBirth: new Date("1990-01-01"),
					phoneNumber: "07123456789",
					mobileNumber: "07000000000",
					addressLine1: "Stratford Village Surgery",
					addressLine2: "50C Romford Road",
					addressLine3: "London",
					postcode: "E15 4BZ",
					country: "United Kingdom",
					longitude: GEOCODE_RESULT.longitude,
					latitude: GEOCODE_RESULT.latitude,
				}),
			);
		});
	});

	describe("error handling", () => {
		let consoleErrorSpy: jest.SpyInstance;

		beforeEach(() => {
			consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
		});

		afterEach(() => {
			consoleErrorSpy.mockRestore();
		});

		function findFormErrorsCreateCall(): unknown[] | undefined {
			return (postgresClient.create as jest.Mock).mock.calls.find(([tableName]) => tableName === "formerrors");
		}

		describe("a runtime error mid-ingest (transform throws on a malformed geocode response)", () => {
			beforeEach(() => {
				// A malformed/empty geocode body (rather than a rejection) is how the provider's
				// HttpResponse<T> convention surfaces a bad result — transformData then throws
				// reading .latitude/.longitude off it, which is the "runtime error" this covers.
				mockedLookupPostcode.mockResolvedValue({ statusCode: 200, body: undefined });
			});

			it("responds 500 with a generic body that does not leak internals", async () => {
				const response = await postIngest(buildIngestedForm());

				expect(response.status).toBe(500);
				expect(response.body).toEqual({ message: "Something went wrong processing your request" });
			});

			it("logs the error together with request metadata including application_reference", async () => {
				await postIngest(buildIngestedForm());

				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Unhandled error while processing request",
					expect.objectContaining({
						message: expect.any(String),
						stack: expect.any(String),
						applicationReference: "GRU-123089-2026",
						method: "POST",
						path: "/ingest",
					}),
				);
			});

			it("writes a FormErrors row with runtime_errors populated and schema_errors left blank", async () => {
				await postIngest(buildIngestedForm());

				const formErrorsCall = findFormErrorsCreateCall();

				expect(formErrorsCall).toBeDefined();
				expect(formErrorsCall?.[1]).toMatchObject({
					application_reference: "GRU-123089-2026",
					runtime_errors: expect.any(String),
				});
				expect(formErrorsCall?.[1]).not.toHaveProperty("schema_errors");
			});
		});

		describe("a DB error (the forms create() call itself rejects)", () => {
			beforeEach(() => {
				mockedCreate.mockRejectedValueOnce(
					new DatabaseError("duplicate key value violates unique constraint", 0, "error"),
				);
			});

			it("logs the error when the DB create() call itself throws/rejects", async () => {
				await postIngest(buildIngestedForm());

				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Unhandled error while processing request",
					expect.objectContaining({ applicationReference: "GRU-123089-2026" }),
				);
			});

			it("does not write an additional FormErrors row when the failing call was itself a DB error", async () => {
				await postIngest(buildIngestedForm());

				expect(findFormErrorsCreateCall()).toBeUndefined();
				expect(mockedCreate).toHaveBeenCalledTimes(1);
			});

			it("responds 500 with a generic body that does not leak DB internals", async () => {
				const response = await postIngest(buildIngestedForm());

				expect(response.status).toBe(500);
				expect(response.body).toEqual({ message: "Something went wrong processing your request" });
			});
		});

		describe("an error before application_reference is known (malformed JSON body)", () => {
			function postMalformedJson() {
				return request(app).post("/ingest").set("Content-Type", "application/json").send("{not-json");
			}

			it("logs the error with application_reference: null when the failure happens before the reference is parsed", async () => {
				await postMalformedJson();

				expect(consoleErrorSpy).toHaveBeenCalledWith(
					"Unhandled error while processing request",
					expect.objectContaining({ applicationReference: null }),
				);
			});

			it("still writes a FormErrors row with application_reference null, capturing whatever form_content was available", async () => {
				await postMalformedJson();

				const formErrorsCall = findFormErrorsCreateCall();

				expect(formErrorsCall).toBeDefined();
				expect(formErrorsCall?.[1]).toMatchObject({
					application_reference: null,
					form_content: expect.any(String),
				});
			});

			it("never includes stack trace / error message in the client-facing response", async () => {
				const response = await postMalformedJson();

				expect(response.status).toBe(500);
				expect(response.body).toEqual({ message: "Something went wrong processing your request" });
			});
		});
	});

	describe("when create() rejects with a unique-violation on application_reference", () => {
		beforeEach(() => {
			mockedCreate.mockRejectedValue({ code: "23505" });
		});

		it("responds 409", async () => {
			const response = await postIngest(buildIngestedForm());

			expect(response.status).toBe(409);
		});

		it("does not write a FormErrors record for a duplicate", async () => {
			await postIngest(buildIngestedForm());

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(mockedCreate).not.toHaveBeenCalledWith("formerrors", expect.anything());
		});
	});
});
