import { validateIngestedForm } from "../../../src/forms/lib/validator";
import validIngestedForm from "../../../src/forms/examples/person_one.json";

function cloneValidIngestedForm(): any {
	return JSON.parse(JSON.stringify(validIngestedForm));
}

describe("validateIngestedForm", () => {
	describe("record level validation", () => {
		it("returns valid: true with no errors for a well-formed ingested form", () => {
			expect(validateIngestedForm(validIngestedForm)).toEqual({ valid: true, errors: [] });
		});

		it("fails for an empty object", () => {
			expect(validateIngestedForm({}).valid).toBe(false);
		});

		it("fails when an unknown top-level property is present", () => {
			const form = cloneValidIngestedForm();
			form.unexpected_field = "surprise";
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("returns one error entry per violated field when multiple fields are invalid at once", () => {
			const form = cloneValidIngestedForm();
			delete form.session_id;
			delete form.email;

			const result = validateIngestedForm(form);

			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("session_id", () => {
		it("fails when missing", () => {
			const form = cloneValidIngestedForm();
			delete form.session_id;
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("fails when a number is sent instead of a string", () => {
			const form = cloneValidIngestedForm();
			form.session_id = 12345;
			expect(validateIngestedForm(form).valid).toBe(false);
		});
	});

	describe("application_reference", () => {
		it("fails when missing", () => {
			const form = cloneValidIngestedForm();
			delete form.application_reference;
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("fails when a number is sent instead of a string", () => {
			const form = cloneValidIngestedForm();
			form.application_reference = 123089;
			expect(validateIngestedForm(form).valid).toBe(false);
		});
	});

	describe("name", () => {
		it("fails when missing", () => {
			const form = cloneValidIngestedForm();
			delete form.name;
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("fails when a number is sent instead of a string", () => {
			const form = cloneValidIngestedForm();
			form.name = 42;
			expect(validateIngestedForm(form).valid).toBe(false);
		});
	});

	describe("email", () => {
		it("fails when missing", () => {
			const form = cloneValidIngestedForm();
			delete form.email;
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("fails when a number is sent instead of a string", () => {
			const form = cloneValidIngestedForm();
			form.email = 12345;
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("fails when an object is sent instead of a string", () => {
			const form = cloneValidIngestedForm();
			form.email = { not: "a string" };
			expect(validateIngestedForm(form).valid).toBe(false);
		});
	});

	describe("gender", () => {
		it.each(["male", "female", "other"])("passes when %s", (gender) => {
			const form = cloneValidIngestedForm();
			form.gender = gender;
			expect(validateIngestedForm(form).valid).toBe(true);
		});

		it("fails on a value outside the allowed set", () => {
			const form = cloneValidIngestedForm();
			form.gender = "unspecified";
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("fails when a number is sent instead of a string", () => {
			const form = cloneValidIngestedForm();
			form.gender = 1;
			expect(validateIngestedForm(form).valid).toBe(false);
		});
	});

	describe("date_of_birth", () => {
		it("fails when missing", () => {
			const form = cloneValidIngestedForm();
			delete form.date_of_birth;
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("fails when a number is sent instead of a string", () => {
			const form = cloneValidIngestedForm();
			form.date_of_birth = 19900101;
			expect(validateIngestedForm(form).valid).toBe(false);
		});
	});

	describe("phone_number (optional)", () => {
		it("passes when absent", () => {
			const form = cloneValidIngestedForm();
			delete form.phone_number;
			expect(validateIngestedForm(form).valid).toBe(true);
		});

		it("fails when present but a number is sent instead of a string", () => {
			const form = cloneValidIngestedForm();
			form.phone_number = 7123456789;
			expect(validateIngestedForm(form).valid).toBe(false);
		});
	});

	describe("mobile_number", () => {
		it("fails when missing", () => {
			const form = cloneValidIngestedForm();
			delete form.mobile_number;
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("fails when a number is sent instead of a string", () => {
			const form = cloneValidIngestedForm();
			form.mobile_number = 7123456789;
			expect(validateIngestedForm(form).valid).toBe(false);
		});
	});

	describe("address", () => {
		it("fails when missing", () => {
			const form = cloneValidIngestedForm();
			delete form.address;
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		it("fails when a string is sent instead of an object", () => {
			const form = cloneValidIngestedForm();
			form.address = "123 Main St";
			expect(validateIngestedForm(form).valid).toBe(false);
		});

		describe("address_line_1", () => {
			it("fails when missing", () => {
				const form = cloneValidIngestedForm();
				delete form.address.address_line_1;
				expect(validateIngestedForm(form).valid).toBe(false);
			});

			it("fails when a number is sent instead of a string", () => {
				const form = cloneValidIngestedForm();
				form.address.address_line_1 = 50;
				expect(validateIngestedForm(form).valid).toBe(false);
			});
		});

		describe("address_line_2", () => {
			it("fails when missing", () => {
				const form = cloneValidIngestedForm();
				delete form.address.address_line_2;
				expect(validateIngestedForm(form).valid).toBe(false);
			});

			it("fails when a number is sent instead of a string", () => {
				const form = cloneValidIngestedForm();
				form.address.address_line_2 = 50;
				expect(validateIngestedForm(form).valid).toBe(false);
			});
		});

		describe("address_line_3 (optional)", () => {
			it("passes when absent", () => {
				const form = cloneValidIngestedForm();
				delete form.address.address_line_3;
				expect(validateIngestedForm(form).valid).toBe(true);
			});

			it("fails when present but a number is sent instead of a string", () => {
				const form = cloneValidIngestedForm();
				form.address.address_line_3 = 50;
				expect(validateIngestedForm(form).valid).toBe(false);
			});
		});

		describe("postcode", () => {
			it("fails when missing", () => {
				const form = cloneValidIngestedForm();
				delete form.address.postcode;
				expect(validateIngestedForm(form).valid).toBe(false);
			});

			it("fails when a number is sent instead of a string", () => {
				const form = cloneValidIngestedForm();
				form.address.postcode = 154;
				expect(validateIngestedForm(form).valid).toBe(false);
			});
		});

		describe("country", () => {
			it("fails when missing", () => {
				const form = cloneValidIngestedForm();
				delete form.address.country;
				expect(validateIngestedForm(form).valid).toBe(false);
			});

			it("fails when a number is sent instead of a string", () => {
				const form = cloneValidIngestedForm();
				form.address.country = 44;
				expect(validateIngestedForm(form).valid).toBe(false);
			});
		});
	});
});
