import express, { NextFunction, Request, Response } from "express";

import { ingestFormController } from "./controllers/ingest";
import { asyncHandler } from "./lib/asyncHandler";

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

// 4-arg error-handling middleware, registered last so Express treats it as the error handler and
// it catches everything thrown/rejected upstream — including rejections that asyncHandler
// forwards via next(err). Always logs with request metadata; never leaks error detail to the
// client. The FormErrors write for non-DB errors is added in the next commit.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, next: NextFunction): void => {
	const error = err instanceof Error ? err : new Error(String(err));
	const applicationReference = extractApplicationReference(req);

	console.error("Unhandled error while processing request", {
		message: error.message,
		stack: error.stack,
		applicationReference,
		method: req.method,
		path: req.path,
	});

	res.status(500).json({ message: "Something went wrong processing your request" });
});

export default app;
