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

// One result row per requested reference. Mirrors Promise.allSettled's `status` field and, on
// success, its `value`. Every row carries the `application_reference` it relates to so the caller
// can correlate results back to their input. Deliberately NO `reason`/error field on rejected
// rows: the failure reason is withheld from the caller for security/privacy reasons (it can leak
// validator internals or a stack trace). Exactly what — if anything — a caller should be told
// about a failure still needs more thought; the reason is logged server-side in the meantime.
type RetrySettledEntry =
	| { status: "fulfilled"; application_reference: string; value: unknown }
	| { status: "rejected"; application_reference: string };

const NO_MATCHING_FORM_ERROR_RECORD_REASON = "no matching FormErrors record";
const REPROCESSING_FAILED_REASON = "reprocessing failed";
const UNEXPECTED_ERROR_REASON = "unexpected error while reprocessing";

// Narrows an unknown request body down to the shape /retry requires: an object with a
// `references` array of strings (each entry an `application_reference` to reprocess).
function isRetryRequestBody(body: unknown): body is { references: string[] } {
	if (typeof body !== "object" || body === null) {
		return false;
	}

	const { references } = body as { references?: unknown };

	return Array.isArray(references) && references.every((reference) => typeof reference === "string");
}

// Reasons this fn throws when a reference should settle rejected. They're logged (never returned
// to the caller) inside the transaction callback; the outer catch re-throws them unchanged and
// converts anything else — an unexpected failure from the transaction machinery itself
// (client checkout, BEGIN/COMMIT/ROLLBACK) — into UNEXPECTED_ERROR_REASON so nothing leaks.
const REPROCESS_REJECTION_REASONS = new Set([REPROCESSING_FAILED_REASON, UNEXPECTED_ERROR_REASON]);

// Replays a single captured FormErrors row through the same ingest lib fn /ingest uses, then
// deletes the FormErrors row — both inside a single transaction, so the re-ingest write and the
// delete either both commit or both roll back. If ingest fails (returns errors or throws), the
// transaction rolls back and the FormErrors record is kept; if the delete fails after a
// successful write, the write is rolled back too — never an orphaned Forms row or a deleted
// error record whose write didn't land. Throws (rather than returning a failure value) whenever
// the reference should settle rejected, so the caller's single Promise.allSettled naturally
// sorts successes from failures without a still-failing reference aborting the rest of the batch.
async function reprocessFormErrorRecord(applicationReference: string, formErrorRecord: FormErrorRecord): Promise<unknown> {
	try {
		return await postgresClient.withTransaction(async (executor) => {
			let ingestResult;

			try {
				ingestResult = await ingestForm(formErrorRecord.form_content, executor);
			} catch (error) {
				console.error("retry: unexpected error calling the ingest lib during retry", {
					application_reference: applicationReference,
					error,
				});
				throw new Error(UNEXPECTED_ERROR_REASON);
			}

			if ("errors" in ingestResult) {
				console.error("retry: form still fails ingest on retry", {
					application_reference: applicationReference,
					errors: ingestResult.errors,
				});
				throw new Error(REPROCESSING_FAILED_REASON);
			}

			try {
				await postgresClient.delete("formerrors", "id", formErrorRecord.id, executor);
			} catch (error) {
				console.error("retry: unexpected error deleting the FormErrors record after a successful retry", {
					application_reference: applicationReference,
					error,
				});
				throw new Error(UNEXPECTED_ERROR_REASON);
			}

			return ingestResult.data;
		});
	} catch (error) {
		// Reasons thrown inside the callback are already logged — re-throw them so the reference
		// settles rejected. Anything else is an unexpected failure from the transaction machinery
		// itself (client checkout, BEGIN/COMMIT/ROLLBACK); log it with metadata and surface a
		// generic reason so no internal detail leaks.
		if (error instanceof Error && REPROCESS_REJECTION_REASONS.has(error.message)) {
			throw error;
		}

		console.error("retry: unexpected error running the retry transaction", {
			application_reference: applicationReference,
			error,
		});
		throw new Error(UNEXPECTED_ERROR_REASON);
	}
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

	let formErrorRecords: FormErrorRecord[];

	try {
		formErrorRecords = await postgresClient.getRecords<FormErrorRecord>(
			"formerrors",
			"application_reference",
			references,
		);
	} catch (error) {
		console.error("retry: unexpected error fetching FormErrors records", { references, error });
		res.status(500).json({ error: "unexpected error processing retry request" });
		return;
	}

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

	// settledResults is Promise.allSettled over `references.map(...)`, so it preserves input order:
	// index i corresponds to references[i]. That lets us attach each reference to its result row.
	const responseBody: RetrySettledEntry[] = settledResults.map((settledResult, index) => {
		const applicationReference = references[index];

		if (settledResult.status === "fulfilled") {
			return { status: "fulfilled", application_reference: applicationReference, value: settledResult.value };
		}

		// The rejection reason is intentionally NOT included in the response: it is withheld from the
		// caller for security/privacy reasons (it can carry validator internals or a stack trace).
		// The reason has already been logged server-side; what to surface to callers needs more thought.
		return { status: "rejected", application_reference: applicationReference };
	});

	res.json(responseBody);
}
