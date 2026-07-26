import request from "supertest";

import app from "../../src/app";
import { ingestForm } from "../../src/forms/lib/ingest";
import { postgresClient } from "../../src/providers/postgres-client";
import { sendEmail } from "../../src/providers/sendgrid";
import { lookupPostcode } from "../../src/providers/idealpostcodes";

jest.mock("../../src/forms/lib/ingest");
jest.mock("../../src/providers/sendgrid");
jest.mock("../../src/providers/idealpostcodes");
jest.mock("../../src/providers/postgres-client", () => ({
	postgresClient: {
		create: jest.fn(),
		getRecords: jest.fn(),
		update: jest.fn(),
		delete: jest.fn(),
	},
}));

const mockedIngestForm = ingestForm as jest.MockedFunction<typeof ingestForm>;
const mockedGetRecords = postgresClient.getRecords as jest.MockedFunction<typeof postgresClient.getRecords>;
const mockedUpdate = postgresClient.update as jest.MockedFunction<typeof postgresClient.update>;
const mockedDelete = postgresClient.delete as jest.MockedFunction<typeof postgresClient.delete>;
const mockedCreate = postgresClient.create as jest.Mock;
const mockedSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;
const mockedLookupPostcode = lookupPostcode as jest.MockedFunction<typeof lookupPostcode>;

// A minimal but fully schema-valid ingested form, for tests that exercise the *real* ingestForm
// implementation (rather than the module-level jest.mock("../../src/forms/lib/ingest") above) —
// needed to prove the confirmation email is actually wired up end-to-end through /retry, not just
// that the controller passes the right options object.
function buildValidIngestedFormContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function buildFormErrorRecord(applicationReference: string, overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		applicationReference: applicationReference,
		formContent: { session_id: "abc" },
		schemaErrors: null,
		runtimeErrors: null,
		...overrides,
	};
}

describe("POST /retry", () => {
	let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

	beforeEach(() => {
		consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
		jest.resetAllMocks();
	});

	describe("request validation", () => {
		it("returns 400 when references is missing", async () => {
			const response = await request(app).post("/retry").send({});

			expect(response.status).toBe(400);
		});

		it("returns 400 when references is not an array of strings", async () => {
			const response = await request(app)
				.post("/retry")
				.send({ references: ["valid-ref", 123] });

			expect(response.status).toBe(400);
		});
	});

	describe("Usual: single reference reprocesses successfully", () => {
		it("deletes the FormErrors record when ingest succeeds", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-success", { id: 42 });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 200, data: { firstName: "Ada" } as never });
			mockedDelete.mockResolvedValue(undefined);

			await request(app).post("/retry").send({ references: ["ref-success"] });

			expect(mockedDelete).toHaveBeenCalledWith("formerrors", "id", 42);
		});

		it("returns a fulfilled entry for the successful reference", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-success");
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 200, data: { firstName: "Ada" } as never });
			mockedDelete.mockResolvedValue(undefined);

			const response = await request(app).post("/retry").send({ references: ["ref-success"] });

			expect(response.status).toBe(200);
			expect(response.body).toEqual([
				{ status: "fulfilled", application_reference: "ref-success", value: { firstName: "Ada" } },
			]);
		});
	});

	describe("Edge: unknown reference", () => {
		it("returns a rejected entry for a reference with no matching FormErrors record", async () => {
			mockedGetRecords.mockResolvedValue([]);

			const response = await request(app).post("/retry").send({ references: ["ref-unknown"] });

			expect(response.status).toBe(200);
			// note that no error message is returned for security/privacy reasons
			expect(response.body).toEqual([{ status: "rejected", application_reference: "ref-unknown" }]);
		});

		it("does not call the ingest lib or delete for an unmatched reference", async () => {
			mockedGetRecords.mockResolvedValue([]);

			await request(app).post("/retry").send({ references: ["ref-unknown"] });

			expect(mockedIngestForm).not.toHaveBeenCalled();
			expect(mockedDelete).not.toHaveBeenCalled();
		});
	});

	describe("Edge: empty references array", () => {
		it("returns 200 with an empty array", async () => {
			const response = await request(app).post("/retry").send({ references: [] });

			expect(response.status).toBe(200);
			expect(response.body).toEqual([]);
		});

		it("does not call getRecords, the ingest lib, or delete", async () => {
			await request(app).post("/retry").send({ references: [] });

			expect(mockedGetRecords).not.toHaveBeenCalled();
			expect(mockedIngestForm).not.toHaveBeenCalled();
			expect(mockedDelete).not.toHaveBeenCalled();
		});
	});

	describe("Edge: reprocess still fails", () => {
		it("does not delete the FormErrors record when ingest fails again", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-still-failing");
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 400, errors: ["still invalid"] });
			mockedUpdate.mockResolvedValue(formErrorRecord);

			await request(app).post("/retry").send({ references: ["ref-still-failing"] });

			expect(mockedDelete).not.toHaveBeenCalled();
		});

		it("does not leak internal error details in the response for a failed reference", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-still-failing");
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 400, errors: ["some sensitive validator internals"] });
			mockedUpdate.mockResolvedValue(formErrorRecord);

			const response = await request(app).post("/retry").send({ references: ["ref-still-failing"] });

			expect(response.status).toBe(200);
			// note that no error message is returned for security/privacy reasons
			expect(response.body).toEqual([{ status: "rejected", application_reference: "ref-still-failing" }]);
			expect(JSON.stringify(response.body)).not.toContain("some sensitive validator internals");
		});
	});

	describe("POST /retry — still-failing reference", () => {
		it("Usual: writes a full snapshot (schemaErrors set, runtimeErrors cleared) via postgresClient.update, does not delete the row", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-still-failing", { id: 7 });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 400, errors: ["still invalid"] });
			mockedUpdate.mockResolvedValue(formErrorRecord);

			const response = await request(app).post("/retry").send({ references: ["ref-still-failing"] });

			expect(mockedUpdate).toHaveBeenCalledWith("formerrors", "id", 7, {
				schemaErrors: JSON.stringify(["still invalid"]),
				runtimeErrors: null,
			});
			expect(mockedDelete).not.toHaveBeenCalled();
			// still no error reason leaked to the caller
			expect(response.body).toEqual([{ status: "rejected", application_reference: "ref-still-failing" }]);
		});

		it("Structure: a non-400 failure sets runtimeErrors and clears schemaErrors", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-duplicate", { id: 8 });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 409, errors: ["duplicate application_reference"] });
			mockedUpdate.mockResolvedValue(formErrorRecord);

			await request(app).post("/retry").send({ references: ["ref-duplicate"] });

			expect(mockedUpdate).toHaveBeenCalledWith("formerrors", "id", 8, {
				runtimeErrors: JSON.stringify(["duplicate application_reference"]),
				schemaErrors: null,
			});
		});

		it("Edge: a successful retry still deletes the row (regression guard) rather than calling update", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-success", { id: 9 });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 200, data: { firstName: "Ada" } as never });
			mockedDelete.mockResolvedValue(undefined);

			await request(app).post("/retry").send({ references: ["ref-success"] });

			expect(mockedDelete).toHaveBeenCalledWith("formerrors", "id", 9);
			expect(mockedUpdate).not.toHaveBeenCalled();
		});

		it("Edge: a mixed batch settles each reference independently (success deleted, failure updated, no-match untouched)", async () => {
			const successRecord = buildFormErrorRecord("ref-success", { id: 10, formContent: { tag: "success" } });
			const failureRecord = buildFormErrorRecord("ref-fail", { id: 11, formContent: { tag: "fail" } });
			mockedGetRecords.mockResolvedValue([successRecord, failureRecord]);
			mockedIngestForm.mockImplementation(async (data) => {
				if ((data as { tag: string }).tag === "success") {
					return { statusCode: 200, data: { firstName: "Ada" } as never };
				}
				return { statusCode: 400, errors: ["still invalid"] };
			});
			mockedDelete.mockResolvedValue(undefined);
			mockedUpdate.mockResolvedValue(failureRecord);

			await request(app)
				.post("/retry")
				.send({ references: ["ref-success", "ref-fail", "ref-unknown"] });

			expect(mockedDelete).toHaveBeenCalledTimes(1);
			expect(mockedDelete).toHaveBeenCalledWith("formerrors", "id", 10);
			expect(mockedUpdate).toHaveBeenCalledTimes(1);
			expect(mockedUpdate).toHaveBeenCalledWith("formerrors", "id", 11, {
				schemaErrors: JSON.stringify(["still invalid"]),
				runtimeErrors: null,
			});
		});

		it("logs (but does not fail the request) when postgresClient.update itself throws", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-still-failing", { id: 12 });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 400, errors: ["still invalid"] });
			mockedUpdate.mockRejectedValue(new Error("connection terminated unexpectedly"));

			const response = await request(app).post("/retry").send({ references: ["ref-still-failing"] });

			expect(response.status).toBe(200);
			expect(response.body).toEqual([{ status: "rejected", application_reference: "ref-still-failing" }]);
			expect(JSON.stringify(response.body)).not.toContain("connection terminated unexpectedly");
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ application_reference: "ref-still-failing" }),
			);
		});
	});

	describe("Structure: mixed batch of successes and failures", () => {
		const successRecord = buildFormErrorRecord("ref-success", { id: 1, formContent: { tag: "success" } });
		const failureRecord = buildFormErrorRecord("ref-fail", { id: 2, formContent: { tag: "fail" } });

		beforeEach(() => {
			mockedGetRecords.mockResolvedValue([successRecord, failureRecord]);
			mockedIngestForm.mockImplementation(async (data) => {
				if ((data as { tag: string }).tag === "success") {
					return { statusCode: 200, data: { firstName: "Ada" } as never };
				}
				return { statusCode: 400, errors: ["still invalid"] };
			});
			mockedDelete.mockResolvedValue(undefined);
		});

		it("processes every reference even when one fails", async () => {
			const response = await request(app)
				.post("/retry")
				.send({ references: ["ref-success", "ref-fail", "ref-unknown"] });

			expect(response.status).toBe(200);
			expect(response.body).toHaveLength(3);
		});

		it("returns fulfilled entries for successes and rejected for failures, in input order", async () => {
			const response = await request(app)
				.post("/retry")
				.send({ references: ["ref-fail", "ref-success", "ref-unknown"] });

			// note that no error message is returned for security/privacy reasons
			expect(response.body).toEqual([
				{ status: "rejected", application_reference: "ref-fail" },
				{ status: "fulfilled", application_reference: "ref-success", value: { firstName: "Ada" } },
				{ status: "rejected", application_reference: "ref-unknown" },
			]);
		});

		it("deletes only the FormErrors records that succeeded, leaving failed ones untouched", async () => {
			await request(app)
				.post("/retry")
				.send({ references: ["ref-success", "ref-fail", "ref-unknown"] });

			expect(mockedDelete).toHaveBeenCalledTimes(1);
			expect(mockedDelete).toHaveBeenCalledWith("formerrors", "id", 1);
		});
	});

	describe("logging", () => {
		it("logs an unexpected error with application_reference metadata when the ingest lib throws", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-throws", { id: 3 });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockRejectedValue(new Error("boom"));

			await request(app).post("/retry").send({ references: ["ref-throws"] });

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ application_reference: "ref-throws" }),
			);
		});

		it("does not leak the thrown error's message in the response", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-throws", { id: 3 });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockRejectedValue(new Error("sensitive internal detail"));

			const response = await request(app).post("/retry").send({ references: ["ref-throws"] });

			expect(response.status).toBe(200);
			expect(JSON.stringify(response.body)).not.toContain("sensitive internal detail");
		});

		it("returns 500 without leaking internals when fetching FormErrors records unexpectedly fails", async () => {
			mockedGetRecords.mockRejectedValue(new Error("connection terminated unexpectedly"));

			const response = await request(app).post("/retry").send({ references: ["ref-db-down"] });

			expect(response.status).toBe(500);
			expect(JSON.stringify(response.body)).not.toContain("connection terminated unexpectedly");
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ references: ["ref-db-down"] }),
			);
		});
	});

	// These tests exercise the *real* ingestForm implementation (via jest.requireActual) rather
	// than the module-level jest.mock("../../src/forms/lib/ingest") the rest of this suite uses —
	// needed to prove /retry actually wires sendConfirmationEmail: true through to a real send,
	// not just that the controller passes the right options object to a mock. idealpostcodes and
	// sendgrid are mocked the same way tests/controllers/ingest.test.ts mocks them.
	describe("POST /retry — confirmation email", () => {
		const { ingestForm: actualIngestForm } = jest.requireActual("../../src/forms/lib/ingest");

		beforeEach(() => {
			mockedIngestForm.mockImplementation(actualIngestForm);
			mockedLookupPostcode.mockResolvedValue({ statusCode: 200, body: { latitude: 51.5, longitude: -0.1 } });
			mockedSendEmail.mockResolvedValue({ statusCode: 200, body: undefined });
			mockedCreate.mockResolvedValue({});
		});

		it("Usual: sends a confirmation email via sendgrid to happyforms@bots.com when a retried form ingests successfully", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-success", {
				id: 20,
				formContent: buildValidIngestedFormContent(),
			});
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedDelete.mockResolvedValue(undefined);

			await request(app).post("/retry").send({ references: ["ref-success"] });

			expect(mockedSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "happyforms@bots.com" }));
		});

		it("Structure: does not send a confirmation email when the retried form still fails validation", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-still-failing", {
				id: 21,
				formContent: buildValidIngestedFormContent({ email: undefined }),
			});
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedUpdate.mockResolvedValue(formErrorRecord);

			await request(app).post("/retry").send({ references: ["ref-still-failing"] });

			expect(mockedSendEmail).not.toHaveBeenCalled();
		});

		it("Edge: does not send a confirmation email for an unmatched reference", async () => {
			mockedGetRecords.mockResolvedValue([]);

			await request(app).post("/retry").send({ references: ["ref-unknown"] });

			expect(mockedSendEmail).not.toHaveBeenCalled();
		});
	});
});
