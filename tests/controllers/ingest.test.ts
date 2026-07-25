import request from "supertest";

jest.mock("../../src/providers/idealpostcodes");
jest.mock("../../src/providers/postgres-client", () => ({
	postgresClient: { create: jest.fn() },
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

	describe("when create() rejects with a unique-violation on application_reference", () => {
		beforeEach(() => {
			mockedCreate.mockRejectedValue({ code: "23505" });
		});

		it("responds 409", async () => {
			const response = await postIngest(buildIngestedForm());

			expect(response.status).toBe(409);
		});

		it("does not leak DB internals in the response body", async () => {
			const response = await postIngest(buildIngestedForm());

			const serializedBody = JSON.stringify(response.body);
			expect(serializedBody).not.toMatch(/detail|stack|23505|sql/i);
		});

		it("does not write a FormErrors record for a duplicate", async () => {
			await postIngest(buildIngestedForm());

			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(mockedCreate).not.toHaveBeenCalledWith("formerrors", expect.anything());
		});
	});
});
