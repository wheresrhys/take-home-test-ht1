import { ingestForm, transformData } from "../../../src/forms/lib/ingest";
import { validateIngestedForm } from "../../../src/forms/lib/validator";
import { lookupPostcode } from "../../../src/providers/idealpostcodes";
import { postgresClient } from "../../../src/providers/postgres-client";
import { IngestedFormSchema } from "../../../src/forms/schemas/ingested_schema";

jest.mock("../../../src/forms/lib/validator");
jest.mock("../../../src/providers/idealpostcodes");
jest.mock("../../../src/providers/postgres-client", () => ({
	postgresClient: { create: jest.fn() },
}));

const mockedValidateIngestedForm = validateIngestedForm as jest.MockedFunction<typeof validateIngestedForm>;
const mockedLookupPostcode = lookupPostcode as jest.MockedFunction<typeof lookupPostcode>;
const mockedCreate = postgresClient.create as jest.Mock;

const GEOCODE_RESULT = { latitude: -5.05, longitude: 50.05 };

function buildValidIngestedForm(overrides: Partial<IngestedFormSchema> = {}): IngestedFormSchema {
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

describe("ingestForm", () => {
	beforeEach(() => {
		mockedLookupPostcode.mockResolvedValue({ statusCode: 200, body: GEOCODE_RESULT });
		mockedCreate.mockResolvedValue({});
	});

	afterEach(() => {
		jest.resetAllMocks();
	});

	it("resolves with a 4xx statusCode and populated errors when the validator reports invalid data", async () => {
		mockedValidateIngestedForm.mockReturnValue({
			valid: false,
			errors: ["(root) must have required property 'email'"],
		});

		const result = await ingestForm({ some: "invalid data" });

		expect(result.statusCode).toBeGreaterThanOrEqual(400);
		expect(result.statusCode).toBeLessThan(500);
		expect("errors" in result && result.errors).toEqual(["(root) must have required property 'email'"]);
	});

	it("resolves with a 201 statusCode and the persisted record's id when the validator reports valid data", async () => {
		mockedValidateIngestedForm.mockReturnValue({ valid: true, errors: [] });
		const validForm = buildValidIngestedForm();

		const result = await ingestForm(validForm);

		expect(result.statusCode).toBe(201);
		expect("data" in result && result.data).toEqual({ id: validForm.application_reference });
	});

	it("geocodes the submitted postcode and persists the transformed row via postgresClient.create", async () => {
		mockedValidateIngestedForm.mockReturnValue({ valid: true, errors: [] });
		const validForm = buildValidIngestedForm();

		await ingestForm(validForm);

		expect(mockedLookupPostcode).toHaveBeenCalledWith(validForm.address.postcode);
		expect(mockedCreate).toHaveBeenCalledWith("forms", transformData(validForm, GEOCODE_RESULT));
	});

	describe("discriminated union shape", () => {
		it("failure result has an errors array of the validator's messages and no data key", async () => {
			mockedValidateIngestedForm.mockReturnValue({ valid: false, errors: ["bad field"] });

			const result = await ingestForm({});

			expect(result).toEqual({ statusCode: 400, errors: ["bad field"] });
			expect("data" in result).toBe(false);
		});

		it("success result has a data value and no errors key", async () => {
			mockedValidateIngestedForm.mockReturnValue({ valid: true, errors: [] });
			const validForm = buildValidIngestedForm();

			const result = await ingestForm(validForm);

			expect("data" in result).toBe(true);
			expect("errors" in result).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("treats null input as invalid, resolving with a 4xx failure result", async () => {
			mockedValidateIngestedForm.mockReturnValue({ valid: false, errors: ["(root) must be object"] });

			const result = await ingestForm(null);

			expect(result.statusCode).toBeGreaterThanOrEqual(400);
			expect(result.statusCode).toBeLessThan(500);
			expect("errors" in result).toBe(true);
		});

		it("surfaces all validator messages for an empty object, not just the first", async () => {
			const errors = [
				"(root) must have required property 'session_id'",
				"(root) must have required property 'email'",
			];
			mockedValidateIngestedForm.mockReturnValue({ valid: false, errors });

			const result = await ingestForm({});

			expect("errors" in result && result.errors).toEqual(errors);
		});

		it("does not swallow an unexpected error thrown by the validator", async () => {
			mockedValidateIngestedForm.mockImplementation(() => {
				throw new Error("validator exploded");
			});

			await expect(ingestForm({})).rejects.toThrow("validator exploded");
		});
	});
});

describe("transformData", () => {
	it("maps session_id to sessionId and application_reference to applicationReference", () => {
		const result = transformData(buildValidIngestedForm(), GEOCODE_RESULT);

		expect(result.sessionId).toBe("session-1");
		expect(result.applicationReference).toBe("GRU-123089-2026");
	});

	it("splits name into firstName and lastName on the last space", () => {
		const result = transformData(buildValidIngestedForm({ name: "John Doe" }), GEOCODE_RESULT);

		expect(result.firstName).toBe("John");
		expect(result.lastName).toBe("Doe");
	});

	it("treats a 3-part name's last token as lastName, allowing spaces in firstName", () => {
		const result = transformData(buildValidIngestedForm({ name: "Mary Jane Watson" }), GEOCODE_RESULT);

		expect(result.firstName).toBe("Mary Jane");
		expect(result.lastName).toBe("Watson");
	});

	it("passes gender 'male' straight through", () => {
		const result = transformData(buildValidIngestedForm({ gender: "male" }), GEOCODE_RESULT);

		expect(result.gender).toBe("male");
	});

	it("passes gender 'female' straight through", () => {
		const result = transformData(buildValidIngestedForm({ gender: "female" }), GEOCODE_RESULT);

		expect(result.gender).toBe("female");
	});

	it("remaps gender 'other' to 'prefer-not-to-say'", () => {
		const result = transformData(buildValidIngestedForm({ gender: "other" }), GEOCODE_RESULT);

		expect(result.gender).toBe("prefer-not-to-say");
	});

	it("converts the date_of_birth string to a dateOfBirth Date instance", () => {
		const result = transformData(buildValidIngestedForm({ date_of_birth: "1990-01-01" }), GEOCODE_RESULT);

		expect(result.dateOfBirth).toBeInstanceOf(Date);
		expect(result.dateOfBirth).toEqual(new Date("1990-01-01"));
	});

	it("maps phone_number to phoneNumber and mobile_number to mobileNumber", () => {
		const result = transformData(
			buildValidIngestedForm({ phone_number: "07111111111", mobile_number: "07222222222" }),
			GEOCODE_RESULT,
		);

		expect(result.phoneNumber).toBe("07111111111");
		expect(result.mobileNumber).toBe("07222222222");
	});

	it("flattens address_line_1/2/3, postcode and country onto the transformed row", () => {
		const result = transformData(buildValidIngestedForm(), GEOCODE_RESULT);

		expect(result.addressLine1).toBe("Stratford Village Surgery");
		expect(result.addressLine2).toBe("50C Romford Road");
		expect(result.addressLine3).toBe("London");
		expect(result.postcode).toBe("E15 4BZ");
		expect(result.country).toBe("United Kingdom");
	});

	it("adds longitude and latitude from the geocode response", () => {
		const result = transformData(buildValidIngestedForm(), { latitude: 1.23, longitude: 4.56 });

		expect(result.latitude).toBe(1.23);
		expect(result.longitude).toBe(4.56);
	});

	describe("edge cases", () => {
		it("treats a single-word name as firstName with an empty-string lastName", () => {
			const result = transformData(buildValidIngestedForm({ name: "Cher" }), GEOCODE_RESULT);

			expect(result.firstName).toBe("Cher");
			expect(result.lastName).toBe("");
		});

		it("preserves phoneNumber as undefined when phone_number is absent", () => {
			const result = transformData(buildValidIngestedForm({ phone_number: undefined }), GEOCODE_RESULT);

			expect(result.phoneNumber).toBeUndefined();
		});

		it("preserves addressLine3 as undefined when address_line_3 is absent", () => {
			const validForm = buildValidIngestedForm();
			const result = transformData(
				{ ...validForm, address: { ...validForm.address, address_line_3: undefined } },
				GEOCODE_RESULT,
			);

			expect(result.addressLine3).toBeUndefined();
		});
	});
});
