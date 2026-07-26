import request from "supertest";
import { DatabaseError } from "pg";

jest.mock("../../src/providers/idealpostcodes");
jest.mock("../../src/providers/sendgrid");
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
import { sendEmail } from "../../src/providers/sendgrid";
import { postgresClient } from "../../src/providers/postgres-client";
import { validateIngestedForm } from "../../src/forms/lib/validator";

const mockedLookupPostcode = lookupPostcode as jest.MockedFunction<typeof lookupPostcode>;
const mockedSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;
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

// The real (unmocked) validator's error messages for a given payload, computed the same way
// the controller does — via a JSON round-trip, since that's what the payload looks like by
// the time it reaches the validator (undefined-valued keys are dropped by JSON.stringify).
function expectedValidationErrors(data: Record<string, unknown>): string[] {
	return validateIngestedForm(JSON.parse(JSON.stringify(data))).errors;
}

describe("POST /ingest", () => {
	beforeEach(() => {
		mockedLookupPostcode.mockResolvedValue({ statusCode: 200, body: GEOCODE_RESULT });
		mockedCreate.mockResolvedValue({});
		mockedSendEmail.mockResolvedValue({ statusCode: 200, body: undefined });
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

	describe("when the submitted form fails schema validation", () => {
		it("returns 400", async () => {
			const response = await postIngest(buildIngestedForm({ email: undefined }));

			expect(response.status).toBe(400);
		});

		it("writes a FormErrors row: formContent = submitted data, schemaErrors = validator errors, runtimeErrors = null", async () => {
			const invalidForm = buildIngestedForm({ email: undefined });

			await postIngest(invalidForm);

			expect(mockedCreate).toHaveBeenCalledWith(
				"formerrors",
				expect.objectContaining({
					formContent: JSON.parse(JSON.stringify(invalidForm)),
					schemaErrors: expectedValidationErrors(invalidForm),
					runtimeErrors: null,
				}),
			);
		});

		it("does not include validator errors, stack traces, or raw form data in the response body", async () => {
			const invalidForm = buildIngestedForm({ email: undefined });

			const response = await postIngest(invalidForm);

			expect(response.body).toEqual({ message: expect.any(String) });
			expect(Object.keys(response.body)).toEqual(["message"]);
		});

		it("does not call the geocoding provider or write to the Forms table", async () => {
			await postIngest(buildIngestedForm({ email: undefined }));

			expect(mockedLookupPostcode).not.toHaveBeenCalled();
			expect(mockedCreate).not.toHaveBeenCalledWith("forms", expect.anything());
		});


		describe("empty request body ({})", () => {
			it("returns 400 and writes FormErrors with formContent = {}", async () => {
				const response = await postIngest({});

				expect(response.status).toBe(400);
				expect(mockedCreate).toHaveBeenCalledWith("formerrors", expect.objectContaining({ formContent: {} }));
			});
		});

		describe("application_reference missing/not a string", () => {
			it("writes FormErrors with applicationReference = null when missing", async () => {
				await postIngest(buildIngestedForm({ application_reference: undefined }));

				expect(mockedCreate).toHaveBeenCalledWith(
					"formerrors",
					expect.objectContaining({ applicationReference: null }),
				);
			});

			it("writes FormErrors with applicationReference coerced to a string when not a string", async () => {
				await postIngest(buildIngestedForm({ application_reference: 12345 }));

				expect(mockedCreate).toHaveBeenCalledWith(
					"formerrors",
					expect.objectContaining({ applicationReference: "12345" }),
				);
			});
		});

		describe("multiple validation errors", () => {
			it("returns a single generic 400 and writes exactly one FormErrors row", async () => {
				const response = await postIngest(buildIngestedForm({ session_id: undefined, email: undefined }));

				expect(response.status).toBe(400);
				expect(response.body).toEqual({ message: expect.any(String) });
				expect(mockedCreate).toHaveBeenCalledTimes(1);
				expect(mockedCreate).toHaveBeenCalledWith("formerrors", expect.anything());
			});
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

			it("writes a FormErrors row with runtimeErrors populated and schemaErrors left blank", async () => {
				await postIngest(buildIngestedForm());

				const formErrorsCall = findFormErrorsCreateCall();

				expect(formErrorsCall).toBeDefined();
				expect(formErrorsCall?.[1]).toMatchObject({
					applicationReference: "GRU-123089-2026",
					runtimeErrors: expect.any(String),
				});
				expect(formErrorsCall?.[1]).not.toHaveProperty("schemaErrors");
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
					applicationReference: null,
					formContent: expect.any(String),
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

	describe("POST /ingest — confirmation email (I7)", () => {
		describe("when the form is ingested successfully (201)", () => {
			it("sends a confirmation email via sendgrid to happyforms@bots.com", async () => {
				await postIngest(buildIngestedForm());

				expect(mockedSendEmail).toHaveBeenCalledWith(
					expect.objectContaining({ to: "happyforms@bots.com" }),
				);
			});

			it("returns the HTTP response without waiting on the confirmation email to resolve", async () => {
				// Never resolves — if ingestForm awaited this before returning, the request
				// below would hang and the test would time out instead of completing promptly.
				mockedSendEmail.mockReturnValue(new Promise(() => {}));

				const response = await postIngest(buildIngestedForm());

				expect(response.status).toBe(201);
			});
		});

		describe("when the request fails schema validation (400, user error)", () => {
			it("does not send a confirmation email", async () => {
				await postIngest(buildIngestedForm({ email: undefined }));

				expect(mockedSendEmail).not.toHaveBeenCalled();
			});
		});

		describe("when ingestion fails with a server error (5xx)", () => {
			let consoleErrorSpy: jest.SpyInstance;

			beforeEach(() => {
				consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
				// Same malformed-geocode-response trick the "error handling" suite above uses to
				// force ingestForm to throw and the middleware to respond 500.
				mockedLookupPostcode.mockResolvedValue({ statusCode: 200, body: undefined });
			});

			afterEach(() => {
				consoleErrorSpy.mockRestore();
			});

			it("does not send a confirmation email", async () => {
				const response = await postIngest(buildIngestedForm());

				expect(response.status).toBe(500);
				expect(mockedSendEmail).not.toHaveBeenCalled();
			});
		});
	});
});
