import request from "supertest";

import app from "../../src/app";
import { ingestForm } from "../../src/forms/lib/ingest";
import { postgresClient } from "../../src/providers/postgres-client";

jest.mock("../../src/forms/lib/ingest");
jest.mock("../../src/providers/postgres-client", () => ({
	postgresClient: {
		getRecords: jest.fn(),
		delete: jest.fn(),
	},
}));

const mockedIngestForm = ingestForm as jest.MockedFunction<typeof ingestForm>;
const mockedGetRecords = postgresClient.getRecords as jest.MockedFunction<typeof postgresClient.getRecords>;
const mockedDelete = postgresClient.delete as jest.MockedFunction<typeof postgresClient.delete>;

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
	afterEach(() => {
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

		it("does not leak internal details in a validation error response", async () => {
			const response = await request(app).post("/retry").send({ references: "not-an-array" });

			expect(response.body).not.toHaveProperty("stack");
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
			expect(response.body).toEqual([{ status: "fulfilled", value: { firstName: "Ada" } }]);
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
			expect(response.body).toEqual([{ status: "rejected", reason: expect.any(String) }]);
			expect(JSON.stringify(response.body)).not.toContain("some sensitive validator internals");
		});
	});
});
