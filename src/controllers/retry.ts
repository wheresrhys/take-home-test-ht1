import { Request, Response } from "express";

import { ingestForm } from "../forms/lib/ingest";
import { postgresClient } from "../providers/postgres-client";

interface FormErrorRecord {
	id: number;
	applicationReference: string;
	formContent: unknown;
	schemaErrors: unknown;
	runtimeErrors: unknown;
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

// Replays a single captured FormErrors row through the same ingest lib fn /ingest uses. Throws
// (rather than returning a failure value) whenever the reference should settle as a rejected
// entry, so that the caller's single Promise.allSettled naturally sorts successes from
// failures without a still-failing reference aborting the rest of the batch.
async function reprocessFormErrorRecord(applicationReference: string, formErrorRecord: FormErrorRecord): Promise<unknown> {
	let ingestResult;

	try {
		ingestResult = await ingestForm(formErrorRecord.formContent);
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

		// Write a full snapshot of *why the form is failing now* across BOTH error columns,
		// so the row is never a stale mix of past and present failures. A 400 is I1 schema
		// validation rejecting the payload (schema_errors); any other error statusCode from
		// the ingest lib (e.g. a 409 duplicate, or a future geocode failure) is a runtime
		// failure rather than a shape problem (runtime_errors). The column for this attempt's
		// failure type gets the latest errors; the other is cleared to null — e.g. if a prior
		// runtime failure has since been fixed but the form now fails schema validation,
		// runtime_errors is nulled so it doesn't misrepresent the current failure.
		const isSchemaFailure = ingestResult.statusCode === 400;
		const latestErrors = JSON.stringify(ingestResult.errors);

		try {
			await postgresClient.update("formerrors", "id", formErrorRecord.id, {
				schemaErrors: isSchemaFailure ? latestErrors : null,
				runtimeErrors: isSchemaFailure ? null : latestErrors,
			});
		} catch (error) {
			console.error("retry: unexpected error updating the FormErrors record after a still-failing retry", {
				application_reference: applicationReference,
				error,
			});
		}

		throw new Error(REPROCESSING_FAILED_REASON);
	}

	try {
		await postgresClient.delete("formerrors", "id", formErrorRecord.id);
	} catch (error) {
		console.error("retry: unexpected error deleting the FormErrors record after a successful retry", {
			application_reference: applicationReference,
			error,
		});
		throw new Error(UNEXPECTED_ERROR_REASON);
	}

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

	let formErrorRecords: FormErrorRecord[];

	try {
		formErrorRecords = await postgresClient.getRecords<FormErrorRecord>(
			"formerrors",
			"applicationReference",
			references,
		);
	} catch (error) {
		console.error("retry: unexpected error fetching FormErrors records", { references, error });
		res.status(500).json({ error: "unexpected error processing retry request" });
		return;
	}

	const formErrorRecordsByReference = new Map(
		formErrorRecords.map((formErrorRecord) => [formErrorRecord.applicationReference, formErrorRecord]),
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
