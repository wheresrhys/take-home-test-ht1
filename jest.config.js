/** @type {import('jest').Config} */
module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	// Loads .env.local (DOTENV_CONFIG_PATH, set by the "test" npm script) before any test
	// file's module graph evaluates. Needed because src/app.ts now transitively imports
	// src/providers/postgres-client.ts (via the /retry controller), which throws at import
	// time if PGHOST/PGPORT/PGDATABASE/FORM_INGESTER_DB_PASSWORD aren't already set — so every
	// suite that imports the app (not just DB-integration suites) needs them present.
	setupFiles: ["dotenv/config"],
};
