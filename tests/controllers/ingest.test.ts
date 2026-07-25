import request from "supertest";

jest.mock("../../src/providers/idealpostcodes");
jest.mock("../../src/providers/postgres-client", () => ({
	postgresClient: { create: jest.fn() },
}));

import app from "../../src/app";
import { lookupPostcode } from "../../src/providers/idealpostcodes";
import { postgresClient } from "../../src/providers/postgres-client";
import { validateIngestedForm } from "../../src/forms/lib/validator";

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

		it("writes a FormErrors row: form_content = submitted data, schema_errors = validator errors, runtime_errors = null", async () => {
			const invalidForm = buildIngestedForm({ email: undefined });

			await postIngest(invalidForm);

			expect(mockedCreate).toHaveBeenCalledWith(
				"formerrors",
				expect.objectContaining({
					form_content: JSON.parse(JSON.stringify(invalidForm)),
					schema_errors: expectedValidationErrors(invalidForm),
					runtime_errors: null,
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
			it("returns 400 and writes FormErrors with form_content = {}", async () => {
				const response = await postIngest({});

				expect(response.status).toBe(400);
				expect(mockedCreate).toHaveBeenCalledWith("formerrors", expect.objectContaining({ form_content: {} }));
			});
		});

		describe("application_reference missing/not a string", () => {
			it("writes FormErrors with application_reference = null when missing", async () => {
				await postIngest(buildIngestedForm({ application_reference: undefined }));

				expect(mockedCreate).toHaveBeenCalledWith(
					"formerrors",
					expect.objectContaining({ application_reference: null }),
				);
			});

			it("writes FormErrors with application_reference coerced to a string when not a string", async () => {
				await postIngest(buildIngestedForm({ application_reference: 12345 }));

				expect(mockedCreate).toHaveBeenCalledWith(
					"formerrors",
					expect.objectContaining({ application_reference: "12345" }),
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
