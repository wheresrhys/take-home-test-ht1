import { Request, Response } from "express";

import { ingestForm } from "../forms/lib/ingest";
import { postgresClient } from "../providers/postgres-client";

interface FormErrorRecord {
	id: number;
	application_reference: string;
	form_content: unknown;
	schema_errors: unknown;
	runtime_errors: unknown;
}

// Mirrors Promise.allSettled's own per-entry shape ({status, value} / {status, reason}), so the
// response body is that shape verbatim — just with `reason` narrowed to a string, since a raw
// Error doesn't serialise usefully over JSON (and could leak a stack trace to the caller).
type RetrySettledEntry = { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: string };

const NO_MATCHING_FORM_ERROR_RECORD_REASON = "no matching FormErrors record";

// Narrows an unknown request body down to the shape /retry requires: an object with a
// `references` array of strings (each entry an `application_reference` to reprocess).
function isRetryRequestBody(body: unknown): body is { references: string[] } {
	if (typeof body !== "object" || body === null) {
		return false;
	}

	const { references } = body as { references?: unknown };

	return Array.isArray(references) && references.every((reference) => typeof reference === "string");
}

// Replays a single captured FormErrors row through the same ingest lib fn /ingest uses. Throws
// (rather than returning a failure value) whenever the reference should settle as a rejected
// entry, so that the caller's single Promise.allSettled naturally sorts successes from
// failures without a still-failing reference aborting the rest of the batch.
async function reprocessFormErrorRecord(applicationReference: string, formErrorRecord: FormErrorRecord): Promise<unknown> {
	const ingestResult = await ingestForm(formErrorRecord.form_content);

	if ("errors" in ingestResult) {
		console.error("retry: form still fails ingest on retry", {
			application_reference: applicationReference,
			errors: ingestResult.errors,
		});
		throw new Error("reprocessing failed");
	}

	await postgresClient.delete("formerrors", "id", formErrorRecord.id);

	return ingestResult.data;
}

export async function retryFailedForms(req: Request, res: Response): Promise<void> {
	const { body } = req;

	if (!isRetryRequestBody(body)) {
		res.status(400).json({ error: "request body must be an object with a `references` array of strings" });
		return;
	}

	const { references } = body;

	// Guard explicitly rather than relying on getRecords' own empty-ids early return: an empty
	// batch must never call getRecords, the ingest lib, or delete at all.
	if (references.length === 0) {
		res.json([]);
		return;
	}

	const formErrorRecords = await postgresClient.getRecords<FormErrorRecord>(
		"formerrors",
		"application_reference",
		references,
	);
	const formErrorRecordsByReference = new Map(
		formErrorRecords.map((formErrorRecord) => [formErrorRecord.application_reference, formErrorRecord]),
	);

	const settledResults = await Promise.allSettled(
		references.map((reference) => {
			const formErrorRecord = formErrorRecordsByReference.get(reference);

			if (!formErrorRecord) {
				return Promise.reject(new Error(NO_MATCHING_FORM_ERROR_RECORD_REASON));
			}

			return reprocessFormErrorRecord(reference, formErrorRecord);
		}),
	);

	const responseBody: RetrySettledEntry[] = settledResults.map((settledResult) => {
		if (settledResult.status === "fulfilled") {
			return { status: "fulfilled", value: settledResult.value };
		}

		const reason = settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason);

		return { status: "rejected", reason };
	});

	res.json(responseBody);
}
