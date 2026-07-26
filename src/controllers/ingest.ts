import { Request, Response } from "express";

import { ingestForm } from "../forms/lib/ingest";

// Generic, non-revealing message for the 400 (schema-invalid) response body. Per CLAUDE.md,
// user-facing error responses must never leak system internals — no validator diagnostics,
// no raw submitted data, no stack/SQL — so the lib's `errors` array is deliberately dropped
// here rather than forwarded onto the response.
const SCHEMA_INVALID_MESSAGE = "The submitted form could not be processed.";

// Generic 409 body. Deliberately signals a conflict without naming application_reference or
// revealing that the form is a duplicate — per CLAUDE.md, responses must not leak internals.
const CONFLICT_MESSAGE = "The submitted form could not be processed due to a conflict.";

// Thin controller: extract the request payload, hand off to the ingest lib (which owns all
// validation/geocode/transform/persist business logic), and map its IngestResult onto the
// HTTP response. Narrows via `'data' in result` per the discriminated union in ingest.ts.
export async function ingestFormController(req: Request, res: Response): Promise<void> {
	const result = await ingestForm(req.body.data, { sendConfirmationEmail: true });

	if ("data" in result) {
		res.status(result.statusCode).json(result.data);
		return;
	}

	if (result.statusCode === 409) {
		res.status(409).json({ message: CONFLICT_MESSAGE });
		return;
	}

	res.status(result.statusCode).json({ message: SCHEMA_INVALID_MESSAGE });
}
