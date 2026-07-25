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

// Postgres unique-violation error code (23505) — raised when Forms.application_reference
// already exists (it's the primary key, per D3). `error` is narrowed from `unknown` since
// pg rejects with plain objects rather than a typed Error subclass we can rely on.
function isUniqueViolationError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

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

export async function ingestForm(data: unknown): Promise<IngestResult<{ id: string }>> {
	const validationResult = validateIngestedForm(data);

	if (!validationResult.valid) {
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
