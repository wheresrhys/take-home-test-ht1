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

	describe("transformData field mapping", () => {
		it("maps session_id to sessionId and application_reference to applicationReference", async () => {
			await postIngest(buildIngestedForm());

			const transformedRow = mockedCreate.mock.calls[0][1];
			expect(transformedRow).toMatchObject({ sessionId: "session-1", applicationReference: "GRU-123089-2026" });
		});

		it("splits name into firstName and lastName on the first space", async () => {
			await postIngest(buildIngestedForm({ name: "John Middle Doe" }));

			const transformedRow = mockedCreate.mock.calls[0][1];
			expect(transformedRow).toMatchObject({ firstName: "John", lastName: "Middle Doe" });
		});

		it("passes gender 'male' and 'female' straight through", async () => {
			await postIngest(buildIngestedForm({ gender: "male" }));
			expect(mockedCreate.mock.calls[0][1]).toMatchObject({ gender: "male" });

			mockedCreate.mockClear();

			await postIngest(buildIngestedForm({ gender: "female" }));
			expect(mockedCreate.mock.calls[0][1]).toMatchObject({ gender: "female" });
		});

		it("remaps gender 'other' to 'prefer-not-to-say'", async () => {
			await postIngest(buildIngestedForm({ gender: "other" }));

			expect(mockedCreate.mock.calls[0][1]).toMatchObject({ gender: "prefer-not-to-say" });
		});

		it("converts the date_of_birth string to a dateOfBirth Date instance", async () => {
			await postIngest(buildIngestedForm({ date_of_birth: "1990-01-01" }));

			const transformedRow = mockedCreate.mock.calls[0][1];
			expect(transformedRow.dateOfBirth).toBeInstanceOf(Date);
			expect(transformedRow.dateOfBirth).toEqual(new Date("1990-01-01"));
		});

		it("maps phone_number to phoneNumber and mobile_number to mobileNumber", async () => {
			await postIngest(buildIngestedForm({ phone_number: "07111111111", mobile_number: "07222222222" }));

			expect(mockedCreate.mock.calls[0][1]).toMatchObject({
				phoneNumber: "07111111111",
				mobileNumber: "07222222222",
			});
		});

		it("flattens address_line_1/2/3, postcode and country onto the transformed row", async () => {
			await postIngest(buildIngestedForm());

			expect(mockedCreate.mock.calls[0][1]).toMatchObject({
				addressLine1: "Stratford Village Surgery",
				addressLine2: "50C Romford Road",
				addressLine3: "London",
				postcode: "E15 4BZ",
				country: "United Kingdom",
			});
		});

		it("adds longitude and latitude from the geocode response", async () => {
			mockedLookupPostcode.mockResolvedValue({ statusCode: 200, body: { latitude: 1.23, longitude: 4.56 } });

			await postIngest(buildIngestedForm());

			expect(mockedCreate.mock.calls[0][1]).toMatchObject({ longitude: 4.56, latitude: 1.23 });
		});
	});

	describe("edge cases", () => {
		it("treats a single-word name as firstName with an empty-string lastName", async () => {
			await postIngest(buildIngestedForm({ name: "Cher" }));

			expect(mockedCreate.mock.calls[0][1]).toMatchObject({ firstName: "Cher", lastName: "" });
		});

		it("preserves phoneNumber as undefined when phone_number is absent", async () => {
			const formWithoutPhoneNumber = buildIngestedForm();
			delete formWithoutPhoneNumber.phone_number;

			await postIngest(formWithoutPhoneNumber);

			expect(mockedCreate.mock.calls[0][1].phoneNumber).toBeUndefined();
		});

		it("preserves addressLine3 as undefined when address_line_3 is absent", async () => {
			const form = buildIngestedForm();
			const address = form.address as Record<string, unknown>;
			delete address.address_line_3;

			await postIngest(form);

			expect(mockedCreate.mock.calls[0][1].addressLine3).toBeUndefined();
		});
	});
});
