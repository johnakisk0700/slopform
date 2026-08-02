#!/usr/bin/env bash
set -Eeuo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

readonly seal_confirmation_value=slopform.example.com
readonly push_confirmation_value=slopform.example.com
readonly local_quiescence_confirmation_value=I_HAVE_STOPPED_ALL_JOIN_THE_SIX_LOCAL_WRITERS
readonly seal_marker=/var/lib/join-the-six/data-import-window.sealed

usage() {
  cat <<'EOF'
Usage: production-data.sh <push|status|seal> [remote-environment-file]

Promote the current local PostgreSQL and MongoDB application data to the
currently deployed, exact Git release. Docker volumes and local Redis state are
never transferred.

Commands:
  status  Read-only local/remote release, data, writer and seal status.
  push    Replace production application data from guarded logical dumps.
  seal    Permanently close the pre-launch import window for this CLI.

Required confirmations:
  CONFIRM_PRODUCTION_DATA_PUSH=slopform.example.com      (push)
  CONFIRM_SEAL_DATA_IMPORT_WINDOW=slopform.example.com   (seal)

Every push requires the operator to stop every local writer and attest that
cross-database quiescence with this exact value. API/worker containers, API
listeners and database sessions are checked as a second guard:
  CONFIRM_LOCAL_DATA_QUIESCED=I_HAVE_STOPPED_ALL_JOIN_THE_SIX_LOCAL_WRITERS

Connection configuration:
  PRODUCTION_SSH_TARGET             default root@203.0.113.10
  PRODUCTION_ROOT                   default /opt/slopform
  PRODUCTION_SSH_KEY                default $HOME/.ssh/id_ed25519
  PRODUCTION_SSH_CONNECT_TIMEOUT    default 10
  PRODUCTION_SSH_OPTIONS            optional extra whitespace-split SSH args
  PRODUCTION_ENV_FILE               default .env.production
  PRODUCTION_DATA_BACKUP_ROOT       default /var/backups/join-the-six
  PRODUCTION_DATA_BACKUP_RETENTION  default 5, accepted range 1..20
EOF
}

die() {
  echo "production-data: $*" >&2
  exit 1
}

note() {
  echo "production-data: $*" >&2
}

if (( $# < 1 || $# > 2 )); then
  usage >&2
  exit 2
fi

command_name=$1

case "$command_name" in
  push | status | seal) ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

case "$command_name" in
  push)
    [[ ${CONFIRM_PRODUCTION_DATA_PUSH:-} == "$push_confirmation_value" ]] ||
      die "push requires CONFIRM_PRODUCTION_DATA_PUSH=$push_confirmation_value"
    [[ ${CONFIRM_LOCAL_DATA_QUIESCED:-} == "$local_quiescence_confirmation_value" ]] ||
      die "push requires CONFIRM_LOCAL_DATA_QUIESCED=$local_quiescence_confirmation_value after every local writer is stopped"
    ;;
  seal)
    [[ ${CONFIRM_SEAL_DATA_IMPORT_WINDOW:-} == "$seal_confirmation_value" ]] ||
      die "seal requires CONFIRM_SEAL_DATA_IMPORT_WINDOW=$seal_confirmation_value"
    ;;
esac

remote_environment_file=${2:-${PRODUCTION_ENV_FILE:-.env.production}}
production_ssh_target=${PRODUCTION_SSH_TARGET:-root@203.0.113.10}
production_root=${PRODUCTION_ROOT:-/opt/slopform}
production_ssh_key=${PRODUCTION_SSH_KEY:-${HOME:?HOME is required}/.ssh/id_ed25519}
production_ssh_connect_timeout=${PRODUCTION_SSH_CONNECT_TIMEOUT:-10}
production_ssh_options=${PRODUCTION_SSH_OPTIONS:-}
production_backup_root=${PRODUCTION_DATA_BACKUP_ROOT:-/var/backups/join-the-six}
production_backup_retention=${PRODUCTION_DATA_BACKUP_RETENTION:-5}

if [[ $production_root != / ]]; then production_root=${production_root%/}; fi
if [[ $production_backup_root != / ]]; then production_backup_root=${production_backup_root%/}; fi

[[ -n $production_ssh_target && $production_ssh_target != -* && $production_ssh_target != *[[:space:]]* ]] ||
  die "PRODUCTION_SSH_TARGET is invalid"
[[ $production_root =~ ^/[a-zA-Z0-9._/-]+$ ]] ||
  die "PRODUCTION_ROOT must be an absolute path containing only letters, digits, '.', '_' '/' or '-'"
[[ $production_root != / && $production_root != */../* && $production_root != */.. && $production_root != */./* && $production_root != */. ]] ||
  die "PRODUCTION_ROOT is unsafe"
[[ $production_backup_root =~ ^/[a-zA-Z0-9._/-]+$ ]] ||
  die "PRODUCTION_DATA_BACKUP_ROOT must be an absolute safe path"
[[ $production_backup_root != / && $production_backup_root != */../* && $production_backup_root != */.. && $production_backup_root != */./* && $production_backup_root != */. ]] ||
  die "PRODUCTION_DATA_BACKUP_ROOT is unsafe"
[[ $production_backup_root != "$production_root" && $production_backup_root != "$production_root/"* ]] ||
  die "PRODUCTION_DATA_BACKUP_ROOT must be outside PRODUCTION_ROOT"
[[ $remote_environment_file =~ ^[a-zA-Z0-9._/-]+$ ]] ||
  die "remote environment file must contain only letters, digits, '.', '_' '/' or '-'"
[[ $remote_environment_file != ../* && $remote_environment_file != */../* && $remote_environment_file != */.. && $remote_environment_file != */./* && $remote_environment_file != */. ]] ||
  die "remote environment file path is unsafe"
[[ $production_ssh_connect_timeout =~ ^[1-9][0-9]*$ ]] ||
  die "PRODUCTION_SSH_CONNECT_TIMEOUT must be a positive integer"
[[ $production_backup_retention =~ ^[1-9][0-9]?$ ]] ||
  die "PRODUCTION_DATA_BACKUP_RETENTION must be an integer from 1 to 20"
(( production_backup_retention <= 20 )) ||
  die "PRODUCTION_DATA_BACKUP_RETENTION must not exceed 20"

[[ $production_ssh_options != *$'\n'* && $production_ssh_options != *$'\r'* ]] ||
  die "PRODUCTION_SSH_OPTIONS must be a single line"

for required_command in docker git ssh; do
  command -v "$required_command" >/dev/null 2>&1 ||
    die "required command not found: $required_command"
done

[[ -r $production_ssh_key ]] || die "SSH private key is not readable: $production_ssh_key"

ssh_arguments=(
  -i "$production_ssh_key"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o "ConnectTimeout=$production_ssh_connect_timeout"
)

if [[ -n $production_ssh_options ]]; then
  # This deliberately follows the production CLI contract: additional options
  # are whitespace-split, not evaluated as shell source.
  read -r -a additional_ssh_arguments <<<"$production_ssh_options"
  ssh_arguments+=("${additional_ssh_arguments[@]}")
fi

remote_run() {
  local remote_source=$1
  shift

  {
    printf 'set --'
    printf ' %q' "$@"
    printf '\n'
    printf '%s\n' "$remote_source"
  } | ssh "${ssh_arguments[@]}" "$production_ssh_target" bash -s
}

remote_upload() {
  local local_file=$1
  local remote_file=$2
  local remote_command

  [[ -f $local_file ]] || die "upload source is not a regular file"
  [[ $remote_file =~ ^/[a-zA-Z0-9._/-]+$ ]] || die "refusing unsafe remote upload path"

  printf -v remote_command 'umask 077; cat > %q && chmod 0600 %q' "$remote_file" "$remote_file"
  ssh "${ssh_arguments[@]}" "$production_ssh_target" "$remote_command" <"$local_file"
}

journal_file="$repository_root/packages/database/drizzle/meta/_journal.json"
migration_directory="$repository_root/packages/database/drizzle"

repository_migration_count() {
  local journal_count
  local sql_count
  local sql_file
  local tag_count
  local tag

  [[ -f $journal_file ]] || die "migration journal not found"

  journal_count=$(awk '/"idx"[[:space:]]*:/ { count += 1 } END { print count + 0 }' "$journal_file")
  sql_count=0
  for sql_file in "$migration_directory"/*.sql; do
    [[ -f $sql_file ]] || continue
    sql_count=$((sql_count + 1))
  done
  tag_count=$(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$journal_file" | awk 'END { print NR + 0 }')

  (( journal_count > 0 )) || die "migration journal is empty"
  [[ $journal_count == "$sql_count" && $journal_count == "$tag_count" ]] ||
    die "migration contract is inconsistent: entries=$journal_count tags=$tag_count sql=$sql_count"

  while IFS= read -r tag; do
    [[ -f "$migration_directory/$tag.sql" ]] ||
      die "migration journal entry has no SQL file: $tag"
  done < <(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$journal_file")

  printf '%s\n' "$journal_count"
}

local_compose=(docker compose --project-directory "$repository_root" -f "$repository_root/compose.yaml")

container_health() {
  local container_id=$1
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id"
}

local_service_container() {
  local service=$1
  "${local_compose[@]}" ps -q "$service" | awk 'NR == 1 { print; exit }'
}

require_local_data_services() {
  local service
  local container_id
  local health

  for service in postgres mongo; do
    container_id=$(local_service_container "$service")
    [[ -n $container_id ]] || die "local Docker service is not running: $service"
    health=$(container_health "$container_id")
    [[ $health == healthy ]] || die "local Docker service is not healthy: $service ($health)"
  done
}

local_postgres_scalar() {
  local query=$1
  "${local_compose[@]}" exec -T postgres sh -eu -c \
    'exec psql -X --no-align --tuples-only --quiet --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="$1"' \
    sh "$query"
}

configured_local_api_port() {
  local value=${API_HOST_PORT:-}
  local env_file="$repository_root/.env"

  if [[ -z $value && -f $env_file ]]; then
    value=$(sed -n 's/^[[:space:]]*API_HOST_PORT[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -n 1)
    value=${value#\"}
    value=${value%\"}
    value=${value#\'}
    value=${value%\'}
  fi

  if [[ -z $value ]]; then
    value=4000
  fi

  [[ $value =~ ^[1-9][0-9]{0,4}$ ]] || die "local API_HOST_PORT is not a valid TCP port"
  (( value <= 65535 )) || die "local API_HOST_PORT is greater than 65535"
  printf '%s\n' "$value"
}

port_has_listener() {
  local port=$1

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "sport = :$port" 2>/dev/null | awk 'NR == 1 { found = 1 } END { exit(found ? 0 : 1) }'
    return
  fi

  die "cannot inspect local listeners: install lsof or ss"
}

local_writer_signals() {
  local service
  local container_id
  local api_port
  local client_count

  for service in api worker; do
    container_id=$(local_service_container "$service")
    if [[ -n $container_id ]]; then
      printf 'running Compose service %s\n' "$service"
    fi
  done

  api_port=$(configured_local_api_port)
  if port_has_listener "$api_port"; then
    printf 'TCP listener on local API port %s\n' "$api_port"
  fi

  client_count=$(local_postgres_scalar \
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend';")
  client_count=${client_count//[[:space:]]/}
  [[ $client_count =~ ^[0-9]+$ ]] || die "could not determine local PostgreSQL client count"

  if (( client_count > 0 )); then
    printf '%s other PostgreSQL client session(s)\n' "$client_count"
  fi
}

assert_local_quiescent() {
  local signals

  signals=$(local_writer_signals)
  if [[ -z $signals ]]; then
    return
  fi

  while IFS= read -r signal; do
    note "writer signal: $signal"
  done <<<"$signals"
  die "local data is not demonstrably quiescent; stop every reported writer before retrying"
}

write_local_postgres_inventory() {
  local destination=$1

  "${local_compose[@]}" exec -T postgres sh -eu -c \
    'exec psql -X --no-align --tuples-only --quiet --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    >"$destination" <<'SQL'
SELECT format(
  'SELECT %L || E''\t'' || count(*)::text FROM %I.%I;',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname IN ('public', 'drizzle')
ORDER BY schemaname, tablename
\gexec
SELECT 'INDEX' || E'\t' || schemaname || '.' || indexname || E'\t' ||
       md5(regexp_replace(indexdef, E'\\s+', ' ', 'g'))
FROM pg_indexes
WHERE schemaname IN ('public', 'drizzle')
ORDER BY schemaname, indexname;
SQL
}

write_local_mongo_inventory() {
  local destination=$1

  "${local_compose[@]}" exec -T mongo sh -eu -c '
    exec mongosh --quiet \
      --username "$MONGODB_APP_USER" \
      --password "$MONGODB_APP_PASSWORD" \
      --authenticationDatabase "$MONGO_INITDB_DATABASE" \
      "$MONGO_INITDB_DATABASE" \
      --eval "$1"
  ' sh '
    function canonical(value) {
      if (Array.isArray(value)) return value.map(canonical);
      if (value !== null && typeof value === "object") {
        return Object.keys(value).sort().reduce((result, key) => {
          if (key !== "ns") result[key] = canonical(value[key]);
          return result;
        }, {});
      }
      return value;
    }
    const collections = db.getCollectionInfos()
      .filter((entry) => !entry.name.startsWith("system."))
      .sort((left, right) => left.name.localeCompare(right.name));
    const inventory = collections.map((entry) => ({
      name: entry.name,
      type: entry.type,
      options: canonical(entry.options ?? {}),
      count: db.getCollection(entry.name).countDocuments({}),
      indexes: entry.type === "collection"
        ? db.getCollection(entry.name).getIndexes()
          .map(canonical)
          .sort((left, right) => left.name.localeCompare(right.name))
        : [],
    }));
    print(EJSON.stringify(canonical(inventory), { relaxed: false }));
  ' >"$destination"
}

make_local_dumps() {
  local temporary_directory=$1

  note "creating local PostgreSQL custom dump"
  "${local_compose[@]}" exec -T postgres sh -eu -c '
    exec pg_dump \
      --format=custom \
      --compress=9 \
      --no-owner \
      --no-acl \
      --schema=public \
      --schema=drizzle \
      --username="$POSTGRES_USER" \
      "$POSTGRES_DB"
  ' >"$temporary_directory/postgres.dump"

  note "creating local MongoDB gzip archive"
  "${local_compose[@]}" exec -T mongo sh -eu -c '
    exec mongodump \
      --quiet \
      --gzip \
      --archive \
      --username "$MONGODB_APP_USER" \
      --password "$MONGODB_APP_PASSWORD" \
      --authenticationDatabase "$MONGO_INITDB_DATABASE" \
      --excludeCollectionsWithPrefix system. \
      --db "$MONGO_INITDB_DATABASE"
  ' >"$temporary_directory/mongo.archive.gz"

  write_local_postgres_inventory "$temporary_directory/postgres.inventory"
  write_local_mongo_inventory "$temporary_directory/mongo.inventory"

  for dump_file in postgres.dump mongo.archive.gz postgres.inventory mongo.inventory; do
    [[ -s "$temporary_directory/$dump_file" ]] || die "local export is empty: $dump_file"
    chmod 0600 "$temporary_directory/$dump_file"
  done
}

sha256_for_file() {
  local file=$1

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1 }'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1 }'
    return
  fi

  die "required command not found: sha256sum or shasum"
}

write_manifest() {
  local temporary_directory=$1
  local file
  local digest

  : >"$temporary_directory/sha256.manifest"
  for file in postgres.dump mongo.archive.gz postgres.inventory mongo.inventory; do
    digest=$(sha256_for_file "$temporary_directory/$file")
    [[ $digest =~ ^[a-fA-F0-9]{64}$ ]] || die "failed to calculate SHA-256 for $file"
    printf '%s  %s\n' "$digest" "$file" >>"$temporary_directory/sha256.manifest"
  done
  chmod 0600 "$temporary_directory/sha256.manifest"
}

remote_status_source=
IFS= read -r -d '' remote_status_source <<'REMOTE' || true
set -Eeuo pipefail

production_root=$1
requested_environment_file=$2
expected_sha=$3
backup_root=$4
seal_marker=$5
current_link="$production_root/current"
state_file="$production_root/shared/release-state.env"

[[ -L $current_link ]] || { echo "production-data: production has no active current release" >&2; exit 1; }
current_release=$(cd -- "$current_link" && pwd -P)
[[ $current_release == "$production_root/releases/"* ]] || { echo "production-data: current release resolves outside the release root" >&2; exit 1; }
current_name=${current_release##*/}
[[ $current_name =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$ ]] || { echo "production-data: current release name is malformed" >&2; exit 1; }
current_sha=${current_name##*-}
[[ -f $current_link/scripts/production-common.sh ]] || { echo "production-data: current release has no production helpers" >&2; exit 1; }

source "$current_link/scripts/production-common.sh"
production_load_state "$state_file"
production_export_state
production_resolve_environment_file "$current_link" "$requested_environment_file"
production_compose_init "$current_link" "$production_environment_file"
production_validate_compose

if [[ $MIGRATE_RELEASE_TAG == "$expected_sha" && $API_RELEASE_TAG == "$expected_sha" && $WORKER_RELEASE_TAG == "$expected_sha" ]]; then
  backend_match=yes
else
  backend_match=no
fi
if [[ $current_sha == "$expected_sha" ]]; then
  current_match=yes
else
  current_match=no
fi
if [[ $backend_match == yes && $current_match == yes ]]; then
  data_compatible=yes
  blocked_reason=none
elif [[ $backend_match != yes ]]; then
  data_compatible=no
  blocked_reason=active_backend_tags_do_not_match_local_head
else
  data_compatible=no
  blocked_reason=current_release_differs_from_backend_run_deploy_backend_or_all_first
fi

if [[ -e $seal_marker ]]; then
  sealed=yes
else
  sealed=no
fi

printf 'remote.current_release=%s\n' "$current_release"
printf 'remote.current_release_sha=%s\n' "$current_sha"
printf 'remote.release.migrate=%s\n' "$MIGRATE_RELEASE_TAG"
printf 'remote.release.api=%s\n' "$API_RELEASE_TAG"
printf 'remote.release.worker=%s\n' "$WORKER_RELEASE_TAG"
printf 'remote.release.web=%s\n' "$WEB_RELEASE_TAG"
printf 'remote.backend_matches_local_sha=%s\n' "$backend_match"
printf 'remote.current_matches_local_sha=%s\n' "$current_match"
printf 'remote.data_operations_compatible=%s\n' "$data_compatible"
printf 'remote.data_operations_blocked_reason=%s\n' "$blocked_reason"
printf 'remote.import_window_sealed=%s\n' "$sealed"

for service in postgres mongo redis api worker; do
  container_id=$("${production_compose[@]}" ps --all -q "$service" | awk 'NR == 1 { print; exit }')
  if [[ -z $container_id ]]; then
    printf 'remote.service.%s=absent\n' "$service"
    continue
  fi

  docker inspect --format "remote.service.${service}=state={{.State.Status}},health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}},image={{.Config.Image}}" "$container_id"
done

postgres_id=$("${production_compose[@]}" ps -q postgres | awk 'NR == 1 { print; exit }')
if [[ -n $postgres_id ]] && [[ $(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_id") == healthy ]]; then
  applied=$("${production_compose[@]}" exec -T postgres sh -eu -c \
    'exec psql -X --no-align --tuples-only --quiet --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="SELECT count(*) FROM drizzle.__drizzle_migrations;"' </dev/null)
  applied=${applied//[[:space:]]/}
  printf 'remote.applied_migrations=%s\n' "$applied"
else
  printf 'remote.applied_migrations=unknown\n'
fi

if [[ -d $backup_root ]]; then
  backup_count=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name 'pre-import-*' -print | awk 'END { print NR + 0 }')
  latest_backup=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name 'pre-import-*' -printf '%f\n' | LC_ALL=C sort | tail -n 1)
  if [[ -d $backup_root/.staging ]]; then
    staging_count=$(find "$backup_root/.staging" -mindepth 1 -maxdepth 1 -type d -name 'import-*' -print | awk 'END { print NR + 0 }')
  else
    staging_count=0
  fi
else
  backup_count=0
  latest_backup=none
  staging_count=0
fi

printf 'remote.pre_import_backups=%s\n' "$backup_count"
printf 'remote.latest_pre_import_backup=%s\n' "${latest_backup:-none}"
printf 'remote.staged_imports=%s\n' "$staging_count"
REMOTE

remote_preflight_source=
IFS= read -r -d '' remote_preflight_source <<'REMOTE' || true
set -Eeuo pipefail

production_root=$1
requested_environment_file=$2
expected_sha=$3
expected_migration_count=$4
seal_marker=$5
current_link="$production_root/current"
state_file="$production_root/shared/release-state.env"

for required_command in docker sha256sum; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "production-data: remote required command not found: $required_command" >&2
    exit 1
  }
done

[[ -d $production_root ]] || { echo "production-data: production root does not exist" >&2; exit 1; }
[[ -L $current_link ]] || { echo "production-data: production has no active current release" >&2; exit 1; }
[[ ! -e $seal_marker ]] || {
  echo "production-data: production data import window is sealed" >&2
  exit 1
}

current_release=$(cd -- "$current_link" && pwd -P)
[[ $current_release == "$production_root/releases/"* ]] || { echo "production-data: current release resolves outside the release root" >&2; exit 1; }
current_name=${current_release##*/}
[[ $current_name =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$ ]] || { echo "production-data: current release name is malformed" >&2; exit 1; }
[[ ${current_name##*-} == "$expected_sha" ]] || {
  echo "production-data: current release differs from the backend release; run deploy backend or all before data push" >&2
  exit 1
}
[[ -f $current_link/scripts/production-common.sh ]] || { echo "production-data: current release has no production helpers" >&2; exit 1; }

source "$current_link/scripts/production-common.sh"
production_load_state "$state_file"
production_export_state

[[ $MIGRATE_RELEASE_TAG == "$expected_sha" && $API_RELEASE_TAG == "$expected_sha" && $WORKER_RELEASE_TAG == "$expected_sha" ]] || {
  echo "production-data: local SHA does not match all active backend release tags" >&2
  exit 1
}

production_resolve_environment_file "$current_link" "$requested_environment_file"
production_compose_init "$current_link" "$production_environment_file"
production_validate_compose

for service in postgres mongo redis; do
  container_id=$("${production_compose[@]}" ps -q "$service" | awk 'NR == 1 { print; exit }')
  [[ -n $container_id ]] || {
    echo "production-data: remote data service is not running: $service" >&2
    exit 1
  }
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
  [[ $health == healthy ]] || {
    echo "production-data: remote data service is not healthy: $service ($health)" >&2
    exit 1
  }
done

docker image inspect "join-the-six-migrate:$MIGRATE_RELEASE_TAG" >/dev/null

for service in api worker; do
  container_id=$("${production_compose[@]}" ps --all -q "$service" | awk 'NR == 1 { print; exit }')
  if [[ -n $container_id ]]; then
    image=$(docker inspect --format '{{.Config.Image}}' "$container_id")
    [[ $image == "join-the-six-${service}:$expected_sha" ]] || {
      echo "production-data: remote $service container is not the active backend release" >&2
      exit 1
    }
  fi
done

applied=$("${production_compose[@]}" exec -T postgres sh -eu -c \
  'exec psql -X --no-align --tuples-only --quiet --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="SELECT count(*) FROM drizzle.__drizzle_migrations;"' </dev/null)
applied=${applied//[[:space:]]/}
[[ $applied == "$expected_migration_count" ]] || {
  echo "production-data: remote migration count does not match the repository contract" >&2
  exit 1
}

unexpected_schemas=$("${production_compose[@]}" exec -T postgres sh -eu -c \
  'exec psql -X --no-align --tuples-only --quiet --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="$1"' \
  sh "SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public', 'drizzle', 'information_schema') AND nspname !~ '^pg_';" </dev/null)
unexpected_schemas=${unexpected_schemas//[[:space:]]/}
[[ $unexpected_schemas == 0 ]] || {
  echo "production-data: remote database has schemas outside the explicit public/drizzle application contract" >&2
  exit 1
}
REMOTE

remote_create_stage_source=
IFS= read -r -d '' remote_create_stage_source <<'REMOTE' || true
set -Eeuo pipefail

production_root=$1
expected_sha=$2
backup_root=$3
seal_marker=$4
current_link="$production_root/current"
state_file="$production_root/shared/release-state.env"

[[ ! -e $seal_marker ]] || { echo "production-data: production data import window is sealed" >&2; exit 1; }
[[ -L $current_link ]] || { echo "production-data: production has no current release" >&2; exit 1; }
current_release=$(cd -- "$current_link" && pwd -P)
[[ $current_release == "$production_root/releases/"* ]] || { echo "production-data: current release resolves outside the release root" >&2; exit 1; }
current_name=${current_release##*/}
[[ $current_name =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$ ]] || { echo "production-data: current release name is malformed" >&2; exit 1; }
[[ ${current_name##*-} == "$expected_sha" ]] || {
  echo "production-data: current release changed or is not the active backend release" >&2
  exit 1
}
[[ -f $current_link/scripts/production-common.sh ]] || { echo "production-data: current release has no production helpers" >&2; exit 1; }
source "$current_link/scripts/production-common.sh"
production_load_state "$state_file"
production_export_state
[[ $MIGRATE_RELEASE_TAG == "$expected_sha" && $API_RELEASE_TAG == "$expected_sha" && $WORKER_RELEASE_TAG == "$expected_sha" ]] || {
  echo "production-data: active backend release changed before staging" >&2
  exit 1
}

if [[ -e $backup_root && (! -d $backup_root || -L $backup_root) ]]; then
  echo "production-data: backup root exists but is not a real directory" >&2
  exit 1
fi
install -d -m 0700 "$backup_root" "$backup_root/.staging"
[[ -d $backup_root && ! -L $backup_root && -d $backup_root/.staging && ! -L $backup_root/.staging ]] || {
  echo "production-data: backup staging root is unsafe" >&2
  exit 1
}
stage=$(mktemp -d "$backup_root/.staging/import-$(date -u +%Y%m%dT%H%M%SZ)-${expected_sha:0:12}.XXXXXX")
chmod 0700 "$stage"
printf '%s\n' "$stage"
REMOTE

remote_cleanup_stage_source=
IFS= read -r -d '' remote_cleanup_stage_source <<'REMOTE' || true
set -Eeuo pipefail

backup_root=$1
stage=$2

[[ -d $backup_root && ! -L $backup_root ]] || { echo "production-data: backup root is missing or unsafe" >&2; exit 1; }
case "$stage" in
  "$backup_root"/.staging/import-*) ;;
  *) echo "production-data: refusing unsafe staging cleanup" >&2; exit 1 ;;
esac

if [[ -d $stage && ! -L $stage ]]; then
  rm -rf -- "$stage"
fi
REMOTE

remote_import_source=
IFS= read -r -d '' remote_import_source <<'REMOTE' || true
set -Eeuo pipefail

production_root=$1
requested_environment_file=$2
expected_sha=$3
expected_migration_count=$4
backup_root=$5
backup_retention=$6
stage=$7
seal_marker=$8
local_mongodb_database=$9
current_link="$production_root/current"
state_file="$production_root/shared/release-state.env"
compose_ready=no
destructive_phase=no
backup_directory=
partial_backup_directory=
stage_cleanup_allowed=no

case "$stage" in
  "$backup_root"/.staging/import-*) stage_cleanup_allowed=yes ;;
esac

cleanup_stage() {
  [[ $stage_cleanup_allowed == yes ]] || return 0
  [[ -d $backup_root && ! -L $backup_root ]] || return 1
  if [[ -e $stage ]]; then
    [[ -d $stage && ! -L $stage ]] || return 1
    rm -rf -- "$stage"
  fi
}

finish_import() {
  local exit_code=${1:-1}
  local cleanup_exit=0
  local backup_cleanup_exit=0

  trap - EXIT INT TERM HUP
  set +e
  cleanup_stage || cleanup_exit=$?
  production_cleanup_partial_backup "$backup_root" "$partial_backup_directory" || backup_cleanup_exit=$?
  if (( (cleanup_exit != 0 || backup_cleanup_exit != 0) && exit_code == 0 )); then
    exit_code=$cleanup_exit
    (( exit_code != 0 )) || exit_code=$backup_cleanup_exit
  fi

  if (( exit_code != 0 )); then
    if [[ $destructive_phase == yes && $compose_ready == yes ]]; then
      "${compose[@]}" stop api worker >/dev/null 2>&1
      echo "production-data: IMPORT DID NOT COMPLETE CLEANLY; API and worker were left stopped" >&2
      if [[ -n $backup_directory ]]; then
        echo "production-data: pre-import logical backup: $backup_directory" >&2
      fi
      echo "production-data: no automatic rollback was attempted; inspect and restore deliberately" >&2
    else
      echo "production-data: import failed before the application stop/data replacement phase; API and worker were not changed by this importer" >&2
    fi
    if (( cleanup_exit != 0 )); then
      echo "production-data: staged import cleanup also failed; remove it only after inspecting the guarded staging path" >&2
    fi
    if (( backup_cleanup_exit != 0 )); then
      echo "production-data: partial backup cleanup also failed; inspect it before any manual removal" >&2
    fi
  fi

  exit "$exit_code"
}

trap 'finish_import $?' EXIT
trap 'finish_import 130' INT
trap 'finish_import 143' TERM
trap 'finish_import 129' HUP

deployment_lock=/var/lock/join-the-six-production.lock
exec 9>"$deployment_lock"
flock --nonblock 9 || { echo "production-data: another production operation holds the deploy lock" >&2; exit 1; }

[[ -L $current_link ]] || { echo "production-data: production has no current release" >&2; exit 1; }
current_release=$(cd -- "$current_link" && pwd -P)
[[ $current_release == "$production_root/releases/"* ]] || { echo "production-data: current release resolves outside the release root" >&2; exit 1; }
current_name=${current_release##*/}
[[ $current_name =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$ ]] || { echo "production-data: current release name is malformed" >&2; exit 1; }
[[ ${current_name##*-} == "$expected_sha" ]] || {
  echo "production-data: current release changed or is not the active backend release" >&2
  exit 1
}
[[ -f $current_link/scripts/production-common.sh ]] || { echo "production-data: current release has no production helpers" >&2; exit 1; }
source "$current_link/scripts/production-common.sh"

[[ ! -e $seal_marker ]] || { echo "production-data: production data import window is sealed" >&2; exit 1; }
production_load_state "$state_file"
production_export_state
[[ $MIGRATE_RELEASE_TAG == "$expected_sha" && $API_RELEASE_TAG == "$expected_sha" && $WORKER_RELEASE_TAG == "$expected_sha" ]] || {
  echo "production-data: active backend release changed after upload" >&2
  exit 1
}

production_resolve_environment_file "$current_link" "$requested_environment_file"
production_compose_init "$current_link" "$production_environment_file"
production_validate_compose
compose=("${production_compose[@]}")
compose_ready=yes

[[ -d $backup_root && ! -L $backup_root && -d $backup_root/.staging && ! -L $backup_root/.staging ]] || {
  echo "production-data: backup or staging root is missing or unsafe" >&2
  exit 1
}

case "$stage" in
  "$backup_root"/.staging/import-*) ;;
  *) echo "production-data: refusing unsafe staging path" >&2; exit 1 ;;
esac
[[ -d $stage && ! -L $stage ]] || { echo "production-data: staged import is missing or unsafe" >&2; exit 1; }
[[ $(stat -c '%a' "$stage") == 700 ]] || { echo "production-data: staged import directory must have mode 0700" >&2; exit 1; }

cd "$stage"
expected_files=(postgres.dump mongo.archive.gz postgres.inventory mongo.inventory sha256.manifest)
for file in "${expected_files[@]}"; do
  [[ -f $file && ! -L $file ]] || { echo "production-data: staged file is missing or unsafe: $file" >&2; exit 1; }
  [[ $(stat -c '%a' "$file") == 600 ]] || { echo "production-data: staged file must have mode 0600: $file" >&2; exit 1; }
done

manifest_entries=$(awk '
  NF != 2 || $1 !~ /^[0-9a-fA-F]{64}$/ || $2 !~ /^(postgres\.dump|mongo\.archive\.gz|postgres\.inventory|mongo\.inventory)$/ { bad = 1 }
  { count += 1; seen[$2] += 1 }
  END {
    if (bad || count != 4 || seen["postgres.dump"] != 1 || seen["mongo.archive.gz"] != 1 || seen["postgres.inventory"] != 1 || seen["mongo.inventory"] != 1) exit 1;
    print count
  }
' sha256.manifest) || { echo "production-data: staged SHA-256 manifest is invalid" >&2; exit 1; }
[[ $manifest_entries == 4 ]] || { echo "production-data: staged manifest is incomplete" >&2; exit 1; }
sha256sum --check --strict sha256.manifest >/dev/null

cd "$current_link"

for service in postgres mongo redis; do
  container_id=$("${compose[@]}" ps -q "$service" | awk 'NR == 1 { print; exit }')
  [[ -n $container_id ]] || { echo "production-data: remote data service stopped before import: $service" >&2; exit 1; }
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
  [[ $health == healthy ]] || { echo "production-data: remote data service is not healthy: $service ($health)" >&2; exit 1; }
done

docker image inspect "join-the-six-migrate:$MIGRATE_RELEASE_TAG" >/dev/null

"${compose[@]}" exec -T postgres pg_restore --list <"$stage/postgres.dump" >/dev/null
"${compose[@]}" exec -T mongo sh -eu -c '
  exec mongorestore \
    --quiet \
    --stopOnError \
    --dryRun \
    --gzip \
    --archive \
    --username "$MONGODB_APP_USER" \
    --password "$(cat /run/secrets/mongodb_app_password)" \
    --authenticationDatabase "$MONGO_INITDB_DATABASE" \
    --nsInclude "$1.*" \
    --nsFrom "$1.*" \
    --nsTo "$MONGO_INITDB_DATABASE.*"
' sh "$local_mongodb_database" <"$stage/mongo.archive.gz" >/dev/null

previous_api=stopped
previous_worker=stopped
if [[ -n $("${compose[@]}" ps -q api) ]]; then previous_api=running; fi
if [[ -n $("${compose[@]}" ps -q worker) ]]; then previous_worker=running; fi

destructive_phase=yes
"${compose[@]}" stop api worker

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
production_prepare_partial_backup "$backup_root" "pre-import-${timestamp}-${expected_sha:0:12}"
partial_backup_directory=$production_partial_backup_directory

note_remote() { echo "production-data: $*" >&2; }
note_remote "taking pre-import PostgreSQL logical backup"
"${compose[@]}" exec -T postgres sh -eu -c '
  exec pg_dump \
    --format=custom \
    --compress=9 \
    --no-owner \
    --no-acl \
    --schema=public \
    --schema=drizzle \
    --username="$POSTGRES_USER" \
    "$POSTGRES_DB"
  ' </dev/null >"$partial_backup_directory/postgres.dump"

note_remote "taking pre-import MongoDB logical backup"
"${compose[@]}" exec -T mongo sh -eu -c '
  exec mongodump \
    --quiet \
    --gzip \
    --archive \
    --username "$MONGODB_APP_USER" \
    --password "$(cat /run/secrets/mongodb_app_password)" \
    --authenticationDatabase "$MONGO_INITDB_DATABASE" \
    --excludeCollectionsWithPrefix system. \
    --db "$MONGO_INITDB_DATABASE"
  ' </dev/null >"$partial_backup_directory/mongo.archive.gz"

chmod 0600 "$partial_backup_directory/postgres.dump" "$partial_backup_directory/mongo.archive.gz"
(
  cd "$partial_backup_directory"
  sha256sum postgres.dump mongo.archive.gz >sha256.manifest
  chmod 0600 sha256.manifest
  sha256sum --check --strict sha256.manifest >/dev/null
)
"${compose[@]}" exec -T postgres pg_restore --list <"$partial_backup_directory/postgres.dump" >/dev/null
"${compose[@]}" exec -T mongo sh -eu -c '
  exec mongorestore \
    --quiet \
    --stopOnError \
    --dryRun \
    --gzip \
    --archive \
    --username "$MONGODB_APP_USER" \
    --password "$(cat /run/secrets/mongodb_app_password)" \
    --authenticationDatabase "$MONGO_INITDB_DATABASE" \
    --nsInclude "$MONGO_INITDB_DATABASE.*"
' <"$partial_backup_directory/mongo.archive.gz" >/dev/null

production_commit_partial_backup "$backup_root" "$partial_backup_directory"
backup_directory=$production_backup_directory
partial_backup_directory=

backup_count=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name 'pre-import-*' -print | awk 'END { print NR + 0 }')
while (( backup_count > backup_retention )); do
  oldest=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name 'pre-import-*' -printf '%f\n' | LC_ALL=C sort | head -n 1)
  [[ $oldest =~ ^pre-import-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.[a-zA-Z0-9]+$ ]] || {
    echo "production-data: refusing to prune an unexpected backup path" >&2
    exit 1
  }
  rm -rf -- "$backup_root/$oldest"
  backup_count=$((backup_count - 1))
done

note_remote "replacing PostgreSQL from verified custom dump"
"${compose[@]}" exec -T postgres sh -eu -c '
  exec pg_restore \
    --clean \
    --if-exists \
    --no-owner \
    --no-acl \
    --exit-on-error \
    --single-transaction \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB"
' <"$stage/postgres.dump"

note_remote "dropping MongoDB application collections while preserving system/auth collections"
"${compose[@]}" exec -T mongo sh -eu -c '
  exec mongosh --quiet \
    --username "$MONGODB_APP_USER" \
    --password "$(cat /run/secrets/mongodb_app_password)" \
    --authenticationDatabase "$MONGO_INITDB_DATABASE" \
    "$MONGO_INITDB_DATABASE" \
    --eval "$1"
' sh '
  const applicationCollections = db.getCollectionInfos({}, { name: 1 })
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("system."));
  for (const name of applicationCollections) {
    const result = db.getCollection(name).drop();
    if (result !== true) throw new Error(`failed to drop application collection: ${name}`);
  }
' </dev/null

note_remote "restoring MongoDB application archive"
"${compose[@]}" exec -T mongo sh -eu -c '
  exec mongorestore \
    --quiet \
    --stopOnError \
    --drop \
    --gzip \
    --archive \
    --username "$MONGODB_APP_USER" \
    --password "$(cat /run/secrets/mongodb_app_password)" \
    --authenticationDatabase "$MONGO_INITDB_DATABASE" \
    --nsInclude "$1.*" \
    --nsFrom "$1.*" \
    --nsTo "$MONGO_INITDB_DATABASE.*"
' sh "$local_mongodb_database" <"$stage/mongo.archive.gz"

note_remote "clearing production Redis; local queue state is never imported"
"${compose[@]}" exec -T redis sh -eu -c '
  REDISCLI_AUTH="$(cat /run/secrets/redis_password)"
  export REDISCLI_AUTH
  exec redis-cli --no-auth-warning FLUSHALL SYNC
' </dev/null >/dev/null

note_remote "running the exact deployed migration image"
"${compose[@]}" run --rm --no-deps migrate </dev/null

applied=$("${compose[@]}" exec -T postgres sh -eu -c \
  'exec psql -X --no-align --tuples-only --quiet --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="SELECT count(*) FROM drizzle.__drizzle_migrations;"' </dev/null)
applied=${applied//[[:space:]]/}
[[ $applied == "$expected_migration_count" ]] || {
  echo "production-data: restored PostgreSQL migration count is wrong" >&2
  exit 1
}

"${compose[@]}" exec -T postgres sh -eu -c \
  'exec psql -X --no-align --tuples-only --quiet --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  >"$stage/remote-postgres.inventory" <<'SQL'
SELECT format(
  'SELECT %L || E''\t'' || count(*)::text FROM %I.%I;',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname IN ('public', 'drizzle')
ORDER BY schemaname, tablename
\gexec
SELECT 'INDEX' || E'\t' || schemaname || '.' || indexname || E'\t' ||
       md5(regexp_replace(indexdef, E'\\s+', ' ', 'g'))
FROM pg_indexes
WHERE schemaname IN ('public', 'drizzle')
ORDER BY schemaname, indexname;
SQL

"${compose[@]}" exec -T mongo sh -eu -c '
  exec mongosh --quiet \
    --username "$MONGODB_APP_USER" \
    --password "$(cat /run/secrets/mongodb_app_password)" \
    --authenticationDatabase "$MONGO_INITDB_DATABASE" \
    "$MONGO_INITDB_DATABASE" \
    --eval "$1"
' sh '
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.keys(value).sort().reduce((result, key) => {
        if (key !== "ns") result[key] = canonical(value[key]);
        return result;
      }, {});
    }
    return value;
  }
  const collections = db.getCollectionInfos()
    .filter((entry) => !entry.name.startsWith("system."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const inventory = collections.map((entry) => ({
    name: entry.name,
    type: entry.type,
    options: canonical(entry.options ?? {}),
    count: db.getCollection(entry.name).countDocuments({}),
    indexes: entry.type === "collection"
      ? db.getCollection(entry.name).getIndexes()
        .map(canonical)
        .sort((left, right) => left.name.localeCompare(right.name))
      : [],
  }));
  print(EJSON.stringify(canonical(inventory), { relaxed: false }));
' </dev/null >"$stage/remote-mongo.inventory"

cmp -s "$stage/postgres.inventory" "$stage/remote-postgres.inventory" || {
  echo "production-data: PostgreSQL table counts or indexes differ after restore" >&2
  exit 1
}
cmp -s "$stage/mongo.inventory" "$stage/remote-mongo.inventory" || {
  echo "production-data: MongoDB collection counts or indexes differ after restore" >&2
  exit 1
}

restart_services=()
if [[ $previous_api == running ]]; then restart_services+=(api); fi
if [[ $previous_worker == running ]]; then restart_services+=(worker); fi

if (( ${#restart_services[@]} > 0 )); then
  note_remote "restarting only the application services that were previously running"
  "${compose[@]}" up -d --no-build --no-deps --wait --wait-timeout 900 "${restart_services[@]}"
fi

for service in postgres mongo redis; do
  container_id=$("${compose[@]}" ps -q "$service" | awk 'NR == 1 { print; exit }')
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
  [[ $health == healthy ]] || { echo "production-data: data service failed readiness after import: $service" >&2; exit 1; }
done

if [[ $previous_api == running ]]; then
  api_id=$("${compose[@]}" ps -q api | awk 'NR == 1 { print; exit }')
  [[ -n $api_id ]] || { echo "production-data: API did not restart" >&2; exit 1; }
  [[ $(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_id") == healthy ]] || {
    echo "production-data: API failed readiness after import" >&2
    exit 1
  }
fi

cleanup_stage
stage_cleanup_allowed=no
printf 'production-data: imported local PostgreSQL and MongoDB data for release %s\n' "$expected_sha"
printf 'production-data: pre-import logical backup retained at %s\n' "$backup_directory"
REMOTE

remote_seal_source=
IFS= read -r -d '' remote_seal_source <<'REMOTE' || true
set -Eeuo pipefail

production_root=$1
expected_sha=$2
seal_marker=$3
current_link="$production_root/current"
state_file="$production_root/shared/release-state.env"

deployment_lock=/var/lock/join-the-six-production.lock
exec 9>"$deployment_lock"
flock --nonblock 9 || { echo "production-data: another production operation holds the deploy lock" >&2; exit 1; }

[[ -L $current_link ]] || { echo "production-data: production has no current release" >&2; exit 1; }
current_release=$(cd -- "$current_link" && pwd -P)
[[ $current_release == "$production_root/releases/"* ]] || { echo "production-data: current release resolves outside the release root" >&2; exit 1; }
current_name=${current_release##*/}
[[ $current_name =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$ ]] || { echo "production-data: current release name is malformed" >&2; exit 1; }
[[ ${current_name##*-} == "$expected_sha" ]] || {
  echo "production-data: current release differs from the backend release; run deploy backend or all before sealing" >&2
  exit 1
}
[[ -f $current_link/scripts/production-common.sh ]] || { echo "production-data: current release has no production helpers" >&2; exit 1; }
source "$current_link/scripts/production-common.sh"
production_load_state "$state_file"
production_export_state
[[ $MIGRATE_RELEASE_TAG == "$expected_sha" && $API_RELEASE_TAG == "$expected_sha" && $WORKER_RELEASE_TAG == "$expected_sha" ]] || {
  echo "production-data: local SHA does not match all active backend release tags" >&2
  exit 1
}

install -d -m 0700 "$(dirname -- "$seal_marker")"
if [[ -e $seal_marker ]]; then
  echo "production-data: data import window is already sealed"
  exit 0
fi

umask 077
temporary_marker="${seal_marker}.tmp.$$"
trap 'rm -f -- "$temporary_marker"' EXIT
printf 'sealed_at=%s\nrelease=%s\ndomain=slopform.example.com\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$expected_sha" >"$temporary_marker"
chmod 0400 "$temporary_marker"
ln "$temporary_marker" "$seal_marker"
rm -f -- "$temporary_marker"
trap - EXIT

echo "production-data: data import window sealed; this CLI has no unseal command"
REMOTE

cd "$repository_root"
local_sha=$(git rev-parse --verify 'HEAD^{commit}')
[[ $local_sha =~ ^[0-9a-f]{40}$ ]] || die "local HEAD is not an exact lowercase 40-character Git SHA"
migration_count=$(repository_migration_count)

case "$command_name" in
  status)
    if [[ -n $(git status --porcelain --untracked-files=normal) ]]; then
      local_clean=no
    else
      local_clean=yes
    fi

    printf 'local.git_sha=%s\n' "$local_sha"
    printf 'local.git_clean=%s\n' "$local_clean"
    printf 'repository.migrations=%s\n' "$migration_count"

    for service in postgres mongo; do
      container_id=$(local_service_container "$service")
      if [[ -z $container_id ]]; then
        printf 'local.service.%s=absent\n' "$service"
      else
        printf 'local.service.%s=%s\n' "$service" "$(container_health "$container_id")"
      fi
    done

    postgres_id=$(local_service_container postgres)
    if [[ -n $postgres_id && $(container_health "$postgres_id") == healthy ]]; then
      local_applied=$(local_postgres_scalar 'SELECT count(*) FROM drizzle.__drizzle_migrations;')
      local_applied=${local_applied//[[:space:]]/}
      printf 'local.applied_migrations=%s\n' "$local_applied"
      writer_status=$(local_writer_signals)
      if [[ -n $writer_status ]]; then
        printf 'local.writer_signals=yes\n'
        while IFS= read -r signal; do printf 'local.writer_signal=%s\n' "$signal"; done <<<"$writer_status"
      else
        printf 'local.writer_signals=no\n'
      fi
    else
      printf 'local.applied_migrations=unknown\n'
      printf 'local.writer_signals=unknown\n'
    fi

    remote_run "$remote_status_source" \
      "$production_root" "$remote_environment_file" "$local_sha" "$production_backup_root" "$seal_marker"
    ;;

  seal)
    [[ -z $(git status --porcelain --untracked-files=normal) ]] ||
      die "refusing to seal from a dirty local worktree"

    remote_run "$remote_seal_source" \
      "$production_root" "$local_sha" "$seal_marker"
    ;;

  push)
    [[ -z $(git status --porcelain --untracked-files=normal) ]] ||
      die "refusing to push data from a dirty local worktree"

    require_local_data_services
    local_mongodb_database=$("${local_compose[@]}" exec -T mongo sh -eu -c 'printf %s "$MONGO_INITDB_DATABASE"')
    [[ $local_mongodb_database =~ ^[a-zA-Z0-9_-]+$ ]] ||
      die "local MongoDB database name cannot be mapped safely"
    local_applied=$(local_postgres_scalar 'SELECT count(*) FROM drizzle.__drizzle_migrations;')
    local_applied=${local_applied//[[:space:]]/}
    [[ $local_applied == "$migration_count" ]] ||
      die "local applied migration count ($local_applied) does not match the repository contract ($migration_count)"
    local_unexpected_schemas=$(local_postgres_scalar \
      "SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public', 'drizzle', 'information_schema') AND nspname !~ '^pg_';")
    local_unexpected_schemas=${local_unexpected_schemas//[[:space:]]/}
    [[ $local_unexpected_schemas == 0 ]] ||
      die "local database has schemas outside the explicit public/drizzle application contract"
    assert_local_quiescent

    remote_run "$remote_preflight_source" \
      "$production_root" "$remote_environment_file" "$local_sha" "$migration_count" "$seal_marker"

    umask 077
    temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/join-the-six-production-data.XXXXXX")
    chmod 0700 "$temporary_directory"
    remote_stage=
    import_started=no

    cleanup_local() {
      local exit_code=${1:-1}
      trap - EXIT INT TERM HUP
      if [[ -n ${temporary_directory:-} && -d $temporary_directory ]]; then
        case "$temporary_directory" in
          "${TMPDIR:-/tmp}"/join-the-six-production-data.*) rm -rf -- "$temporary_directory" ;;
        esac
      fi
      if [[ $import_started == no && -n $remote_stage ]]; then
        remote_run "$remote_cleanup_stage_source" "$production_backup_root" "$remote_stage" >/dev/null 2>&1 || true
      fi
      exit "$exit_code"
    }
    trap 'cleanup_local $?' EXIT
    trap 'cleanup_local 130' INT
    trap 'cleanup_local 143' TERM
    trap 'cleanup_local 129' HUP

    make_local_dumps "$temporary_directory"
    assert_local_quiescent
    write_manifest "$temporary_directory"

    remote_stage=$(remote_run "$remote_create_stage_source" \
      "$production_root" "$local_sha" "$production_backup_root" "$seal_marker")
    [[ $remote_stage =~ ^/[a-zA-Z0-9._/-]+$ ]] || die "remote returned an unsafe staging path"
    case "$remote_stage" in
      "$production_backup_root"/.staging/import-*) ;;
      *) die "remote staging path is outside the guarded staging root" ;;
    esac

    note "uploading verified logical archives over SSH"
    for file in postgres.dump mongo.archive.gz postgres.inventory mongo.inventory sha256.manifest; do
      remote_upload "$temporary_directory/$file" "$remote_stage/$file"
    done

    import_started=yes
    if ! remote_run "$remote_import_source" \
      "$production_root" \
      "$remote_environment_file" \
      "$local_sha" \
      "$migration_count" \
      "$production_backup_root" \
      "$production_backup_retention" \
      "$remote_stage" \
      "$seal_marker" \
      "$local_mongodb_database"; then
      note "remote import failed or the SSH connection was lost"
      note "if SSH was lost, production service state is unknown; inspect the VPS before any manual restart"
      note "the remote script never performs an automatic rollback"
      exit 1
    fi

    remote_stage=
    ;;
esac
