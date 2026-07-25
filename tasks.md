# Data layer

1. Introduce postgres with docker, and a `npm db:start` command and put the address, username and password in a .env.local file.
2. Introduce a mechanism to maintain schema .sql files in a db/schema/ directory and have them run against the postgres instance on db:start.
3. Generate an SQL file that creates table `Forms` which reflects the transformed_schema, saved as ./db/schema/Forms.sql. application_reference should be the primary key.
4. Similarly, create a table `FormErrors` which contains the following columns
  - id - auto-incrementing id
  - application_reference - indexed, but nullable
  - form_content - json
  - schema_errors - json
  - runtime_errors - json
5. Add a form_ingester role to the db schema. This role should allow reads and writes on both the tables you created. Ensure the user executes using this role.
6. Introduce dot-env in order to set credentials (use it in the dev and start npm scripts commands)
7. Create a postgres-client.ts file (using https://www.npmjs.com/package/pg) in providers which expects credentials for the local db to be set in env vars, and errors informatively if they are not. it forces calling the db with the form_ingester role.
8. Add create, getRecords and delete methods to the client:
  - create(tableName, data) - returns a promise for the db row
  - getRecords(tableName, idColumn, ids) - returns the data rows that match the ids
  - delete(tableName, idColumn, id)


# Ingest API
1. Use https://www.npmjs.com/package/ts-json-schema-generator to generate a jsonschema from @src/schemas/ingested_schema.ts. Create src/forms/lib/validator.ts that wraps this in a function. Include unit tests.
2. Create a /lib/ingest.ts file exporting an async function that takes a single parameter, data, and returns an object {statusCode, data, errors}. This is where all subsequent business logic for handling ingesting success/failure should live. All the tickets below should interact with or modify this file.
3. Happy path: In a ./src/controllers/ingest.ts file run the request body's data property against the generated json schema. If it passes use @src/providers/idealpostcodes to generate a latlng, then transform the ingested data into the transformed_schema shape via a `transformData` utility function (same file), and use the create method of the db client to create a record in the Forms table. Respond with 201 & the id of the record created. Include an BDD test for this happy path (using supertest or a modern equivalent) which mock the geo and db calls.
4. User error: If the input does not match the schema, write to FormErrors and respond with 400 but do not expose any system information. Extend the BDD tests to cover this case.
5. Duplicate record: If the DB responds with a conflict error respond to the user with a 409 to the user.
6. Critical Error handling: Add an error handling middleware to the application that logs the error along with metadata about the request (application_reference in particular). If the error is not a DB error, also write to the FormErrors table (but write runtime_errors, leaving schema_errors blank). Extend the BDD tests to cover these cases.
7. Email confirmation: In parallel with sending the successful response, also send a confirmation email using @src/providers/sendgrid.ts. If this fails, simple log the failure with the application_reference. Extend BDD with 3 additional tests to check the email does/doesn't get sent on success, user error or server error. Note that this behaviour should live in the ingest lib file, not the controller, but it can be gated behind a sendConfirmationEmail option (passed in an options object in the second input parameter)
8. e2e tests: Mock the geo and email providers for now as they are stub implementations anyway. But write tests - for happy path, conflict, schema error - that check the record actually does/doesn't get written to the db

# Retry API

1. Create a POST /retry endpoint that when passed {references: [application_reference]} fetches each of those from the FormErrors table (using getRecords), and then runs them through the ingest library function. Wrap in a Promise.allSettled. For each success delete the corresponding FormErrors record. For each failure leave the record unchanged. Respond with an array, essentially the Promise.allSettled result.
2. Make each per-reference retry atomic: add transaction support to the postgres client and wrap the successful re-ingest write and the FormErrors delete in a single transaction, so a crash between them can neither lose a form nor leave a stale error record.
