import { validateIngestedForm } from "./validator";
import { IngestedFormSchema } from "../schemas/ingested_schema";
import { TransformedFormSchema } from "../schemas/transformed_schema";

// Discriminated union: success and failure are mutually exclusive at the type level.
// A success result never carries `errors`; a failure result never carries `data`.
export type IngestResult<T = TransformedFormSchema> =
	| { statusCode: number; data: T }
	| { statusCode: number; errors: string[] };

// Splits `name` on the first space: text before the first space is firstName, the
// remainder is lastName (empty string when there's no space, e.g. a single-word name).
function splitName(name: string): { firstName: string; lastName: string } {
	const firstSpaceIndex = name.indexOf(" ");

	if (firstSpaceIndex === -1) {
		return { firstName: name, lastName: "" };
	}

	return {
		firstName: name.slice(0, firstSpaceIndex),
		lastName: name.slice(firstSpaceIndex + 1),
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

export async function ingestForm(data: unknown): Promise<IngestResult> {
	const validationResult = validateIngestedForm(data);

	if (!validationResult.valid) {
		return { statusCode: 400, errors: validationResult.errors };
	}

	// Placeholder success branch: geocoding and persistence land in the next commit, which
	// replaces this with the real happy path using transformData above. For now this only
	// proves the success branch of the discriminated union by echoing back the validated input.
	const validatedForm = data as IngestedFormSchema;

	return { statusCode: 200, data: validatedForm as unknown as TransformedFormSchema };
}
