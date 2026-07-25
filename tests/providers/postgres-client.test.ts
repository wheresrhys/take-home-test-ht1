jest.mock("pg");

type PostgresClientModule = typeof import("../../src/providers/postgres-client");

const ORIGINAL_ENV = { ...process.env };

const VALID_ENV = {
	PGHOST: "db.internal",
	PGPORT: "5432",
	PGDATABASE: "take_home_test",
	FORM_INGESTER_DB_PASSWORD: "ingesterpassword",
};

// Re-requires src/providers/postgres-client.ts (and its "pg" import) in a fresh module
// registry with the given env applied on top of VALID_ENV, so each test controls exactly
// which vars are present without leaking state into other tests. `undefined` deletes a var.
function loadPostgresClientModule(envOverrides: Record<string, string | undefined> = {}): {
	postgresClientModule: PostgresClientModule;
	MockedPool: jest.Mock;
} {
	let postgresClientModule!: PostgresClientModule;
	let MockedPool!: jest.Mock;

	jest.isolateModules(() => {
		process.env = { ...ORIGINAL_ENV, ...VALID_ENV };
		for (const [envVarName, envVarValue] of Object.entries(envOverrides)) {
			if (envVarValue === undefined) {
				delete process.env[envVarName];
			} else {
				process.env[envVarName] = envVarValue;
			}
		}

		// eslint-disable-next-line @typescript-eslint/no-var-requires
		MockedPool = require("pg").Pool as jest.Mock;
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		postgresClientModule = require("../../src/providers/postgres-client");
	});

	process.env = ORIGINAL_ENV;
	return { postgresClientModule, MockedPool };
}

afterEach(() => {
	process.env = ORIGINAL_ENV;
});

describe("createPostgresPool", () => {
	it("creates a Pool with host/port/database from env, password from FORM_INGESTER_DB_PASSWORD, and a hardcoded form_ingester user even when a stray PGUSER is set", () => {
		const { MockedPool } = loadPostgresClientModule({ PGUSER: "someone-else" });

		expect(MockedPool).toHaveBeenCalledWith({
			host: VALID_ENV.PGHOST,
			port: Number(VALID_ENV.PGPORT),
			database: VALID_ENV.PGDATABASE,
			user: "form_ingester",
			password: VALID_ENV.FORM_INGESTER_DB_PASSWORD,
		});
	});

	describe.each(["PGHOST", "PGPORT", "PGDATABASE", "FORM_INGESTER_DB_PASSWORD"])("%s", (missingEnvVarName) => {
		it(`throws when ${missingEnvVarName} is missing`, () => {
			expect(() => loadPostgresClientModule({ [missingEnvVarName]: undefined })).toThrow(
				`postgres-client: missing required env var(s): ${missingEnvVarName}`,
			);
		});
	});

	it("lists all missing var names when several are unset", () => {
		expect(() => loadPostgresClientModule({ PGHOST: undefined, PGDATABASE: undefined })).toThrow(
			"postgres-client: missing required env var(s): PGHOST, PGDATABASE",
		);
	});

	it("treats an empty-string env var as missing", () => {
		expect(() => loadPostgresClientModule({ PGPORT: "" })).toThrow(
			"postgres-client: missing required env var(s): PGPORT",
		);
	});

	it("never includes the password value in the error message", () => {
		let thrownError: Error | undefined;

		try {
			loadPostgresClientModule({ PGHOST: undefined, FORM_INGESTER_DB_PASSWORD: "super-secret-value" });
		} catch (error) {
			thrownError = error as Error;
		}

		expect(thrownError).toBeDefined();
		expect(thrownError?.message).not.toContain("super-secret-value");
	});
});

describe("postgresClient", () => {
	it("is a Pool constructed via createPostgresPool() using process.env at import time", () => {
		const { postgresClientModule, MockedPool } = loadPostgresClientModule();

		expect(MockedPool).toHaveBeenCalledWith({
			host: VALID_ENV.PGHOST,
			port: Number(VALID_ENV.PGPORT),
			database: VALID_ENV.PGDATABASE,
			user: "form_ingester",
			password: VALID_ENV.FORM_INGESTER_DB_PASSWORD,
		});
		expect(postgresClientModule.postgresClient).toBeInstanceOf(MockedPool);
	});
});
