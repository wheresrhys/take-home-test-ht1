import { validateIngestedForm } from "./validator";
import { IngestedFormSchema } from "../schemas/ingested_schema";
import { TransformedFormSchema } from "../schemas/transformed_schema";

// Discriminated union: success and failure are mutually exclusive at the type level.
// A success result never carries `errors`; a failure result never carries `data`.
export type IngestResult<T = TransformedFormSchema> =
	| { statusCode: number; data: T }
	| { statusCode: number; errors: string[] };

export async function ingestForm(data: unknown): Promise<IngestResult> {
	const validationResult = validateIngestedForm(data);

	if (!validationResult.valid) {
		return { statusCode: 400, errors: validationResult.errors };
	}

	// Placeholder success branch: geocoding, transform and persistence land in a later
	// ticket (I3), which replaces this with the real happy path. For now this only proves
	// the success branch of the discriminated union by echoing back the validated input.
	const validatedForm = data as IngestedFormSchema;

	return { statusCode: 200, data: validatedForm as unknown as TransformedFormSchema };
}
