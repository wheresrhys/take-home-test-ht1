#!/usr/bin/env bash
# Applies every db/schema/*.sql file (filename-sort order) against the running
# `postgres` compose service, waiting for it to accept connections first so this
# is safe to run immediately after `docker compose up -d`.
#
# No host-machine psql required — schema files run via `docker compose exec -T`
# into the container's own `psql`. Files are expected to be idempotent; a
# genuine SQL error fails the whole run, naming the offending file.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
schema_dir="$script_dir/schema"
env_file="$repo_root/.env.local"
service="postgres"
max_wait_seconds=30

if [ -f "$env_file" ]; then
	set -a
	# shellcheck disable=SC1090
	source "$env_file"
	set +a
fi

echo "Waiting for Postgres to accept connections..."
waited=0
until docker compose --env-file "$env_file" exec -T "$service" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" > /dev/null 2>&1; do
	waited=$((waited + 1))
	if [ "$waited" -ge "$max_wait_seconds" ]; then
		echo "Postgres did not become ready within ${max_wait_seconds}s" >&2
		exit 1
	fi
	sleep 1
done
echo "Postgres is ready."

shopt -s nullglob
schema_files=("$schema_dir"/*.sql)
shopt -u nullglob

if [ "${#schema_files[@]}" -eq 0 ]; then
	echo "No schema files found in $schema_dir — nothing to apply."
	exit 0
fi

# Sort explicitly (filename-sort order) rather than relying on glob order.
IFS=$'\n' sorted_files=($(printf '%s\n' "${schema_files[@]}" | sort))
unset IFS

for file in "${sorted_files[@]}"; do
	name="$(basename "$file")"
	echo "Applying $name..."
	if ! docker compose --env-file "$env_file" exec -T "$service" \
		psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$file"; then
		echo "Failed applying schema file: $name" >&2
		exit 1
	fi
done

echo "Schema applied successfully."
