import { Request, Response } from "express";

import { ingestForm } from "../forms/lib/ingest";

// Generic, non-revealing message for the 400 (schema-invalid) response body. Per CLAUDE.md,
// user-facing error responses must never leak system internals — no validator diagnostics,
// no raw submitted data, no stack/SQL — so the lib's `errors` array is deliberately dropped
// here rather than forwarded onto the response.
const SCHEMA_INVALID_MESSAGE = "The submitted form could not be processed.";

// Thin controller: extract the request payload, hand off to the ingest lib (which owns all
// validation/geocode/transform/persist business logic), and map its IngestResult onto the
// HTTP response. Narrows via `'data' in result` per the discriminated union in ingest.ts.
export async function ingestFormController(req: Request, res: Response): Promise<void> {
	const result = await ingestForm(req.body.data);

	if ("data" in result) {
		res.status(result.statusCode).json(result.data);
		return;
	}

	res.status(result.statusCode).json({ message: SCHEMA_INVALID_MESSAGE });
}
