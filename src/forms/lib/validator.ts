import Ajv, { ErrorObject } from "ajv";

import ingestedFormJsonSchema from "../schemas/ingested_schema.schema.json";

const ajv = new Ajv({ allErrors: true });

// Compiled once at module load and reused across calls.
const validateAgainstIngestedFormJsonSchema = ajv.compile(ingestedFormJsonSchema);

export function validateIngestedForm(data: unknown): { valid: boolean; errors: string[] } {
	const valid = validateAgainstIngestedFormJsonSchema(data);

	if (valid) {
		return { valid: true, errors: [] };
	}

	const errors = (validateAgainstIngestedFormJsonSchema.errors ?? []).map(formatAjvError);

	return { valid: false, errors };
}

function formatAjvError(error: ErrorObject): string {
	const location = error.instancePath || "(root)";

	return `${location} ${error.message}`.trim();
}
