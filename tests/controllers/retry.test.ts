import request from "supertest";

import app from "../../src/app";
import { ingestForm } from "../../src/forms/lib/ingest";
import { postgresClient } from "../../src/providers/postgres-client";

jest.mock("../../src/forms/lib/ingest");
jest.mock("../../src/providers/postgres-client", () => ({
	postgresClient: {
		getRecords: jest.fn(),
		delete: jest.fn(),
		withTransaction: jest.fn(),
	},
}));

const mockedIngestForm = ingestForm as jest.MockedFunction<typeof ingestForm>;
const mockedGetRecords = postgresClient.getRecords as jest.MockedFunction<typeof postgresClient.getRecords>;
const mockedDelete = postgresClient.delete as jest.MockedFunction<typeof postgresClient.delete>;
const mockedWithTransaction = postgresClient.withTransaction as jest.MockedFunction<typeof postgresClient.withTransaction>;

// The one executor withTransaction hands the callback. Asserting BOTH the re-ingest and the
// delete receive THIS same object proves they run inside a single transaction (i.e. atomically).
const TRANSACTION_EXECUTOR = { query: jest.fn() };

function buildFormErrorRecord(applicationReference: string, overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		application_reference: applicationReference,
		form_content: { session_id: "abc" },
		schema_errors: null,
		runtime_errors: null,
		...overrides,
	};
}

describe("POST /retry", () => {
	let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

	beforeEach(() => {
		consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
		// Faithful stand-in for the real helper: run the callback with the transaction executor,
		// resolving with its result and rejecting (a rollback, in the real impl) if it throws.
		mockedWithTransaction.mockImplementation(async (callback) => callback(TRANSACTION_EXECUTOR));
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

			expect(mockedDelete).toHaveBeenCalledWith("formerrors", "id", 42, TRANSACTION_EXECUTOR);
		});

		it("runs the re-ingest and the delete inside a single transaction (both on the same executor)", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-success", { id: 42, form_content: { tag: "reprocess" } });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 200, data: { firstName: "Ada" } as never });
			mockedDelete.mockResolvedValue(undefined);

			await request(app).post("/retry").send({ references: ["ref-success"] });

			expect(mockedWithTransaction).toHaveBeenCalledTimes(1);
			expect(mockedIngestForm).toHaveBeenCalledWith({ tag: "reprocess" }, TRANSACTION_EXECUTOR);
			expect(mockedDelete).toHaveBeenCalledWith("formerrors", "id", 42, TRANSACTION_EXECUTOR);
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
		it("leaves the FormErrors record unchanged when ingest fails again", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-still-failing");
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 400, errors: ["still invalid"] });

			await request(app).post("/retry").send({ references: ["ref-still-failing"] });

			expect(mockedDelete).not.toHaveBeenCalled();
		});

		it("does not leak internal error details in the response for a failed reference", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-still-failing");
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 400, errors: ["some sensitive validator internals"] });

			const response = await request(app).post("/retry").send({ references: ["ref-still-failing"] });

			expect(response.status).toBe(200);
			// note that no error message is returned for security/privacy reasons
			expect(response.body).toEqual([{ status: "rejected", application_reference: "ref-still-failing" }]);
			expect(JSON.stringify(response.body)).not.toContain("some sensitive validator internals");
		});
	});

	describe("Structure: mixed batch of successes and failures", () => {
		const successRecord = buildFormErrorRecord("ref-success", { id: 1, form_content: { tag: "success" } });
		const failureRecord = buildFormErrorRecord("ref-fail", { id: 2, form_content: { tag: "fail" } });

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
			expect(mockedDelete).toHaveBeenCalledWith("formerrors", "id", 1, TRANSACTION_EXECUTOR);
		});
	});

	describe("POST /retry (transactional)", () => {
		it("Structure: rolls back — keeps the FormErrors record and writes no Forms row — when ingest fails again", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-still-failing", { id: 7 });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 400, errors: ["still invalid"] });

			const response = await request(app).post("/retry").send({ references: ["ref-still-failing"] });

			// The transaction was entered (so its rollback-on-throw governs the failed re-ingest),
			// the FormErrors delete never ran, and the reference settled rejected.
			expect(mockedWithTransaction).toHaveBeenCalledTimes(1);
			expect(mockedDelete).not.toHaveBeenCalled();
			expect(response.body).toEqual([{ status: "rejected", application_reference: "ref-still-failing" }]);
		});

		it("Edge: rolls back the whole transaction when the delete throws after a successful re-ingest", async () => {
			const formErrorRecord = buildFormErrorRecord("ref-delete-throws", { id: 8 });
			mockedGetRecords.mockResolvedValue([formErrorRecord]);
			mockedIngestForm.mockResolvedValue({ statusCode: 200, data: { firstName: "Ada" } as never });
			mockedDelete.mockRejectedValue(new Error("delete failed mid-transaction"));

			const response = await request(app).post("/retry").send({ references: ["ref-delete-throws"] });

			// The delete threw inside the transaction, so withTransaction rejected (a rollback in the
			// real impl — see the withTransaction unit tests): no orphaned Forms row is left committed
			// for this reference, and it settles rejected without leaking the underlying error.
			expect(response.status).toBe(200);
			expect(response.body).toEqual([{ status: "rejected", application_reference: "ref-delete-throws" }]);
			expect(JSON.stringify(response.body)).not.toContain("delete failed mid-transaction");
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ application_reference: "ref-delete-throws" }),
			);
		});

		it("Edge: commits and rolls back references independently in a mixed batch", async () => {
			const successRecord = buildFormErrorRecord("ref-ok", { id: 10, form_content: { tag: "ok" } });
			const failureRecord = buildFormErrorRecord("ref-bad", { id: 11, form_content: { tag: "bad" } });
			mockedGetRecords.mockResolvedValue([successRecord, failureRecord]);
			mockedIngestForm.mockImplementation(async (data) =>
				(data as { tag: string }).tag === "ok"
					? { statusCode: 200, data: { firstName: "Ada" } as never }
					: { statusCode: 400, errors: ["still invalid"] },
			);
			mockedDelete.mockResolvedValue(undefined);

			const response = await request(app).post("/retry").send({ references: ["ref-ok", "ref-bad"] });

			// One transaction per reference; the rolled-back one ("ref-bad") does not affect the
			// committed one ("ref-ok") — only ref-ok's FormErrors row is deleted.
			expect(mockedWithTransaction).toHaveBeenCalledTimes(2);
			expect(mockedDelete).toHaveBeenCalledTimes(1);
			expect(mockedDelete).toHaveBeenCalledWith("formerrors", "id", 10, TRANSACTION_EXECUTOR);
			expect(response.body).toEqual([
				{ status: "fulfilled", application_reference: "ref-ok", value: { firstName: "Ada" } },
				{ status: "rejected", application_reference: "ref-bad" },
			]);
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
});
