import { Request, Response } from "express";

// Narrows an unknown request body down to the shape /retry requires: an object with a
// `references` array of strings (each entry an `application_reference` to reprocess).
function isRetryRequestBody(body: unknown): body is { references: string[] } {
	if (typeof body !== "object" || body === null) {
		return false;
	}

	const { references } = body as { references?: unknown };

	return Array.isArray(references) && references.every((reference) => typeof reference === "string");
}

export async function retryFailedForms(req: Request, res: Response): Promise<void> {
	const { body } = req;

	if (!isRetryRequestBody(body)) {
		res.status(400).json({ error: "request body must be an object with a `references` array of strings" });
		return;
	}

	// Orchestration (fetching FormErrors rows, reprocessing via the ingest lib, deleting on
	// success) lands in the next commit — for now this only proves the validation branch.
	res.json([]);
}
