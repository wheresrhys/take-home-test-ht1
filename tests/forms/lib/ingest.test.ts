import { ingestForm } from "../../../src/forms/lib/ingest";
import { validateIngestedForm } from "../../../src/forms/lib/validator";

jest.mock("../../../src/forms/lib/validator");

const mockedValidateIngestedForm = validateIngestedForm as jest.MockedFunction<typeof validateIngestedForm>;

describe("ingestForm", () => {
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

	it("resolves with a 2xx statusCode and data when the validator reports valid data", async () => {
		mockedValidateIngestedForm.mockReturnValue({ valid: true, errors: [] });
		const validForm = { session_id: "abc" };

		const result = await ingestForm(validForm);

		expect(result.statusCode).toBeGreaterThanOrEqual(200);
		expect(result.statusCode).toBeLessThan(300);
		expect("data" in result && result.data).toEqual(validForm);
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
			const validForm = { session_id: "abc" };

			const result = await ingestForm(validForm);

			expect(result).toEqual({ statusCode: 200, data: validForm });
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
