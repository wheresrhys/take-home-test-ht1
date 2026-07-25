import { validateIngestedForm } from "./validator";
import { IngestedFormSchema } from "../schemas/ingested_schema";
import { TransformedFormSchema } from "../schemas/transformed_schema";
import { lookupPostcode } from "../../providers/idealpostcodes";
import { postgresClient } from "../../providers/postgres-client";

// Discriminated union: success and failure are mutually exclusive at the type level.
// A success result never carries `errors`; a failure result never carries `data`.
export type IngestResult<T = TransformedFormSchema> =
	| { statusCode: number; data: T }
	| { statusCode: number; errors: string[] };

// Splits `name` on the last space: the final whitespace-separated token is lastName, and
// everything before it is firstName (so firstName may itself contain spaces, e.g. a
// 3-part name like "Mary Jane Watson" -> firstName "Mary Jane", lastName "Watson").
// lastName is an empty string when there's no space, e.g. a single-word name.
function splitName(name: string): { firstName: string; lastName: string } {
	const lastSpaceIndex = name.lastIndexOf(" ");

	if (lastSpaceIndex === -1) {
		return { firstName: name, lastName: "" };
	}

	return {
		firstName: name.slice(0, lastSpaceIndex),
		lastName: name.slice(lastSpaceIndex + 1),
	};
}

// Pure mapping from the inbound ingested_schema shape to the outbound transformed_schema
// shape — no I/O. Geocode coordinates are supplied by the caller (ingestForm), since
// looking up the postcode is the only part of this transform that isn't pure data mapping.
export function transformData(
	ingestedForm: IngestedFormSchema,
	geo: { latitude: number; longitude: number },
): TransformedFormSchema {
	const { firstName, lastName } = splitName(ingestedForm.name);

	return {
		sessionId: ingestedForm.session_id,
		applicationReference: ingestedForm.application_reference,
		firstName,
		lastName,
		email: ingestedForm.email,
		gender: ingestedForm.gender === "other" ? "prefer-not-to-say" : ingestedForm.gender,
		dateOfBirth: new Date(ingestedForm.date_of_birth),
		phoneNumber: ingestedForm.phone_number,
		mobileNumber: ingestedForm.mobile_number,
		addressLine1: ingestedForm.address.address_line_1,
		addressLine2: ingestedForm.address.address_line_2,
		addressLine3: ingestedForm.address.address_line_3,
		postcode: ingestedForm.address.postcode,
		country: ingestedForm.address.country,
		longitude: geo.longitude,
		latitude: geo.latitude,
	};
}

// Best-effort extraction of application_reference from an as-yet-unvalidated payload, for
// tagging the FormErrors row. Defensive because validation may itself have failed on this
// field (or the payload may not be an object at all) — FormErrors.application_reference is
// nullable (D4) precisely to allow that.
function extractApplicationReference(data: unknown): string | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}

	const applicationReference = (data as Record<string, unknown>).application_reference;

	return typeof applicationReference === "string" ? applicationReference : null;
}

export async function ingestForm(data: unknown): Promise<IngestResult<{ id: string }>> {
	const validationResult = validateIngestedForm(data);

	if (!validationResult.valid) {
		await postgresClient.create("formerrors", {
			application_reference: extractApplicationReference(data),
			form_content: data,
			schema_errors: validationResult.errors,
			runtime_errors: null,
		});

		return { statusCode: 400, errors: validationResult.errors };
	}

	const validatedForm = data as IngestedFormSchema;

	// Geocode failures (idealpostcodes fails ~5% of calls by design) get full retry/error
	// capture in a later ticket (I6); this ticket's scope assumes lookupPostcode succeeds.
	const geocodeResponse = await lookupPostcode(validatedForm.address.postcode);
	const geo = geocodeResponse.body as { latitude: number; longitude: number };

	const transformedRow = transformData(validatedForm, geo);

	await postgresClient.create("forms", transformedRow);

	return { statusCode: 201, data: { id: transformedRow.applicationReference } };
}
