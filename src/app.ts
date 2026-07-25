import express, { NextFunction, Request, Response } from "express";

import { ingestFormController } from "./controllers/ingest";
import { asyncHandler } from "./lib/asyncHandler";
import { isDatabaseError, postgresClient } from "./providers/postgres-client";

import { retryFailedForms } from "./controllers/retry";

const app = express();

app.use(express.json());

app.post("/ingest", asyncHandler(ingestFormController));

// Reads application_reference off the parsed ingested-form body, defensively — the error being
// handled might be a JSON parse failure or occur before validation, so req.body's shape is never
// guaranteed here. Must not itself throw, since it runs from inside the error handler.
function extractApplicationReference(req: Request): string | null {
	const body = req.body as { data?: { application_reference?: unknown } } | undefined;
	const applicationReference = body?.data?.application_reference;

	return typeof applicationReference === "string" ? applicationReference : null;
}

// Best-effort capture of a failed form so it can be reprocessed via /retry once a fix ships.
// Skipped entirely when the triggering error was itself a DB error (isDatabaseError) — the DB
// is presumably unavailable/broken, so attempting this write would just throw again and mask
// the original error with a second, unrelated one.
async function writeFormError(req: Request, applicationReference: string | null, error: Error): Promise<void> {
	try {
		await postgresClient.create("formerrors", {
			application_reference: applicationReference,
			form_content: JSON.stringify(req.body),
			runtime_errors: JSON.stringify({ message: error.message, stack: error.stack }),
		});
	} catch (writeError) {
		console.error("Failed to write FormErrors row for a runtime error", {
			message: writeError instanceof Error ? writeError.message : String(writeError),
			applicationReference,
		});
	}
}

// 4-arg error-handling middleware, registered last so Express treats it as the error handler and
// it catches everything thrown/rejected upstream — including rejections that asyncHandler
// forwards via next(err). Always logs with request metadata; never leaks error detail to the
// client.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(async (err: unknown, req: Request, res: Response, next: NextFunction): Promise<void> => {
	const error = err instanceof Error ? err : new Error(String(err));
	const applicationReference = extractApplicationReference(req);

	console.error("Unhandled error while processing request", {
		message: error.message,
		stack: error.stack,
		applicationReference,
		method: req.method,
		path: req.path,
	});

	if (!isDatabaseError(err)) {
		await writeFormError(req, applicationReference, error);
	}

	res.status(500).json({ message: "Something went wrong processing your request" });
});

app.post("/retry", retryFailedForms);

export default app;
