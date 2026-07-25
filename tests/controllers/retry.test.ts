import request from "supertest";

import app from "../../src/app";

describe("POST /retry", () => {
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
});
