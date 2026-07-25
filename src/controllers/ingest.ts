import { Request, Response } from "express";

import { ingestForm } from "../forms/lib/ingest";

// Thin controller: extract the request payload, hand off to the ingest lib (which owns all
// validation/geocode/transform/persist business logic), and map its IngestResult onto the
// HTTP response. Narrows via `'data' in result` per the discriminated union in ingest.ts.
export async function ingestFormController(req: Request, res: Response): Promise<void> {
	const result = await ingestForm(req.body.data);

	res.status(result.statusCode).json("data" in result ? result.data : { errors: result.errors });
}
