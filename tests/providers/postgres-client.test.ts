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

describe("withTransaction", () => {
	// Loads the module with `pg` mocked, then stubs the singleton pool's `connect` to hand back a
	// fake client whose `query`/`release` we can assert on. postgresClient IS the pool (Object.assign),
	// so overriding its `connect` overrides the connection withTransaction checks out.
	function loadWithMockClient(): {
		withTransaction: PostgresClientModule["postgresClient"]["withTransaction"];
		client: { query: jest.Mock; release: jest.Mock };
	} {
		const { postgresClientModule } = loadPostgresClientModule();
		const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: jest.fn() };
		const { postgresClient } = postgresClientModule;
		(postgresClient.connect as unknown as jest.Mock) = jest.fn().mockResolvedValue(client);

		return { withTransaction: postgresClient.withTransaction, client };
	}

	it("BEGINs, COMMITs and returns the callback's result on success", async () => {
		const { withTransaction, client } = loadWithMockClient();

		const result = await withTransaction(async (executor) => {
			expect(executor).toBe(client);
			return "callback-result";
		});

		expect(result).toBe("callback-result");
		expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
		expect(client.query).toHaveBeenNthCalledWith(2, "COMMIT");
		expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");
	});

	it("ROLLBACKs and rethrows when the callback throws", async () => {
		const { withTransaction, client } = loadWithMockClient();
		const callbackError = new Error("callback exploded");

		await expect(
			withTransaction(async () => {
				throw callbackError;
			}),
		).rejects.toBe(callbackError);

		expect(client.query).toHaveBeenCalledWith("BEGIN");
		expect(client.query).toHaveBeenCalledWith("ROLLBACK");
		expect(client.query).not.toHaveBeenCalledWith("COMMIT");
	});

	it("releases the client on the success path", async () => {
		const { withTransaction, client } = loadWithMockClient();

		await withTransaction(async () => undefined);

		expect(client.release).toHaveBeenCalledTimes(1);
	});

	it("releases the client on the failure path", async () => {
		const { withTransaction, client } = loadWithMockClient();

		await expect(
			withTransaction(async () => {
				throw new Error("callback exploded");
			}),
		).rejects.toThrow("callback exploded");

		expect(client.release).toHaveBeenCalledTimes(1);
	});
});
