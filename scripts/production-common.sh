#!/usr/bin/env bash

# Shared production deployment primitives. This file is sourced by the
# server-side deploy and rollback entrypoints; it is not a public command.

production_die() {
  local message=$1
  local exit_code=${2:-1}

  printf 'Error: %s\n' "$message" >&2
  exit "$exit_code"
}

production_validate_scope() {
  case ${1:-} in
    all | admin | backend) ;;
    *) production_die "scope must be one of: all, admin, backend" 2 ;;
  esac
}

production_validate_full_sha() {
  [[ ${1:-} =~ ^[0-9a-f]{40}$ ]] || production_die "release tag must be an exact 40-character lowercase Git SHA" 2
}

production_web_deploy_payload_matches() {
  local payload=$1
  local expected_release=${2:-}
  local payload_pattern='^\{"release":"[0-9a-f]{40}"\}$'

  if [[ -n $expected_release ]]; then
    [[ $expected_release =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ $payload == "{\"release\":\"$expected_release\"}" ]]
    return
  fi

  [[ $payload =~ $payload_pattern ]]
}

production_validate_root() {
  local root=$1

  [[ $root =~ ^/[A-Za-z0-9._/-]+$ ]] || production_die "PRODUCTION_ROOT must be an absolute path containing only safe path characters"
  [[ $root != / && $root != */ && $root != *//* && $root != */../* && $root != */.. && $root != */./* && $root != */. ]] || production_die "unsafe PRODUCTION_ROOT: $root"
}

production_require_commands() {
  local required_command

  for required_command in "$@"; do
    command -v "$required_command" >/dev/null 2>&1 || production_die "required command not found: $required_command"
  done
}

production_acquire_lock() {
  local lock_file=/var/lock/join-the-six-production.lock

  if [[ -n ${DEPLOY_LOCK_FD:-} ]]; then
    [[ $DEPLOY_LOCK_FD =~ ^[0-9]+$ ]] || production_die "DEPLOY_LOCK_FD must be a numeric inherited file descriptor"
    production_lock_fd=$DEPLOY_LOCK_FD
  else
    exec {production_lock_fd}>"$lock_file"
  fi

  if ! flock --nonblock "$production_lock_fd"; then
    production_die "another production deploy, rollback, data operation, or edge update holds $lock_file"
  fi
}

production_resolve_environment_file() {
  local repository_root=$1
  local requested_file=$2

  if [[ $requested_file == /* ]]; then
    production_environment_file=$requested_file
  else
    production_environment_file="$repository_root/$requested_file"
  fi

  [[ -f $production_environment_file ]] || production_die "production environment file not found: $production_environment_file"
}

production_validate_release_root() {
  local repository_root=$1
  local production_root=$2
  local release_tag=$3
  local release_name

  [[ $repository_root == "$production_root/releases/"* ]] || production_die "server-side deployment must run from an immutable directory under $production_root/releases"
  release_name=${repository_root##*/}
  [[ $release_name =~ ^[0-9]{8}T[0-9]{6}Z-([0-9a-f]{40})$ ]] || production_die "invalid immutable release directory name: $release_name"
  [[ ${BASH_REMATCH[1]} == "$release_tag" ]] || production_die "release directory SHA does not match DEPLOY_RELEASE_TAG"
}

production_load_state() {
  local state_file=$1
  local line key value
  local saw_migrate=0
  local saw_api=0
  local saw_worker=0
  local saw_web=0

  [[ -e $state_file ]] || return 1
  [[ -f $state_file && ! -L $state_file ]] || production_die "release state must be a regular file: $state_file"

  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^(MIGRATE_RELEASE_TAG|API_RELEASE_TAG|WORKER_RELEASE_TAG|WEB_RELEASE_TAG)=([0-9a-f]{40})$ ]] || production_die "malformed production release state: $state_file"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}

    case $key in
      MIGRATE_RELEASE_TAG)
        ((saw_migrate == 0)) || production_die "duplicate MIGRATE_RELEASE_TAG in $state_file"
        MIGRATE_RELEASE_TAG=$value
        saw_migrate=1
        ;;
      API_RELEASE_TAG)
        ((saw_api == 0)) || production_die "duplicate API_RELEASE_TAG in $state_file"
        API_RELEASE_TAG=$value
        saw_api=1
        ;;
      WORKER_RELEASE_TAG)
        ((saw_worker == 0)) || production_die "duplicate WORKER_RELEASE_TAG in $state_file"
        WORKER_RELEASE_TAG=$value
        saw_worker=1
        ;;
      WEB_RELEASE_TAG)
        ((saw_web == 0)) || production_die "duplicate WEB_RELEASE_TAG in $state_file"
        WEB_RELEASE_TAG=$value
        saw_web=1
        ;;
    esac
  done < "$state_file"

  ((saw_migrate == 1 && saw_api == 1 && saw_worker == 1 && saw_web == 1)) || production_die "incomplete production release state: $state_file"
}

production_export_state() {
  production_validate_full_sha "$MIGRATE_RELEASE_TAG"
  production_validate_full_sha "$API_RELEASE_TAG"
  production_validate_full_sha "$WORKER_RELEASE_TAG"
  production_validate_full_sha "$WEB_RELEASE_TAG"

  export MIGRATE_RELEASE_TAG API_RELEASE_TAG WORKER_RELEASE_TAG WEB_RELEASE_TAG
}

production_write_state_atomically() {
  local state_file=$1
  local state_directory temporary_state

  state_directory=${state_file%/*}
  [[ -d $state_directory ]] || production_die "shared production directory not found: $state_directory"
  temporary_state=$(mktemp "$state_directory/.release-state.XXXXXX") || production_die "could not create temporary release state"

  if chmod 600 "$temporary_state" && \
    printf '%s\n' \
      "MIGRATE_RELEASE_TAG=$MIGRATE_RELEASE_TAG" \
      "API_RELEASE_TAG=$API_RELEASE_TAG" \
      "WORKER_RELEASE_TAG=$WORKER_RELEASE_TAG" \
      "WEB_RELEASE_TAG=$WEB_RELEASE_TAG" > "$temporary_state" && \
    mv -f -- "$temporary_state" "$state_file"; then
    :
  else
    rm -f -- "$temporary_state"
    production_die "could not persist production release state"
  fi
}

production_activate_current_release() {
  local repository_root=$1
  local production_root=$2
  local current_link="$production_root/current"
  local temporary_link="$production_root/.current.$$"

  if [[ -e $current_link && ! -L $current_link ]]; then
    production_die "$current_link exists and is not a symbolic link"
  fi

  rm -f -- "$temporary_link"
  ln -s -- "$repository_root" "$temporary_link"
  if ! mv -Tf -- "$temporary_link" "$current_link"; then
    rm -f -- "$temporary_link"
    production_die "could not atomically activate $repository_root"
  fi
}

production_compose_init() {
  local repository_root=$1
  local environment_file=$2

  production_compose=(docker compose --project-directory "$repository_root" --env-file "$environment_file" -f "$repository_root/compose.prod.yaml")
}

production_validate_compose() {
  "${production_compose[@]}" config --quiet
}

production_verify_image_revision() {
  local service=$1
  local release_tag=$2
  local image="join-the-six-${service}:${release_tag}"
  local image_revision

  image_revision=$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$image" 2>/dev/null) || production_die "production image is unavailable: $image"
  [[ $image_revision == "$release_tag" ]] || production_die "production image revision label does not match its tag: $image"
}

production_resolve_web_public_config_hash() {
  production_require_commands python3

  WEB_PUBLIC_CONFIG_SHA256=$("${production_compose[@]}" config --format json | python3 -c '
import hashlib
import json
import sys

document = json.load(sys.stdin)
arguments = document["services"]["web"]["build"]["args"]
names = (
    "VITE_API_BASE",
    "VITE_CLERK_PUBLISHABLE_KEY",
    "VITE_GOOGLE_MAPS_API_KEY",
)
payload = b"\0".join(str(arguments.get(name, "")).encode() for name in names)
print(hashlib.sha256(payload).hexdigest())
') || production_die "could not derive the web public-config hash from Compose"

  [[ $WEB_PUBLIC_CONFIG_SHA256 =~ ^[0-9a-f]{64}$ ]] ||
    production_die "derived web public-config hash is invalid"
  export WEB_PUBLIC_CONFIG_SHA256
}

production_verify_web_public_config() {
  local release_tag=$1
  local expected_hash=$2
  local image="join-the-six-web:${release_tag}"
  local actual_hash

  [[ $expected_hash =~ ^[0-9a-f]{64}$ ]] ||
    production_die "expected web public-config hash is invalid"
  actual_hash=$(docker image inspect \
    --format '{{ index .Config.Labels "org.join-the-six.web-public-config-sha256" }}' \
    "$image" 2>/dev/null) || production_die "production image is unavailable: $image"
  [[ $actual_hash == "$expected_hash" ]] ||
    production_die "web image $image was built with different public configuration; create a new Git release identity"
}

production_verify_image_contract() {
  local service=$1
  local release_tag=$2
  local web_public_config_hash=${3:-}

  production_verify_image_revision "$service" "$release_tag"
  if [[ $service == web ]]; then
    production_verify_web_public_config "$release_tag" "$web_public_config_hash"
  fi
}

production_image_needs_build() {
  local service=$1
  local release_tag=$2
  local web_public_config_hash=${3:-}
  local image="join-the-six-${service}:${release_tag}"

  if ! docker image inspect "$image" >/dev/null 2>&1; then
    return 0
  fi

  production_verify_image_contract "$service" "$release_tag" "$web_public_config_hash"
  printf 'Reusing immutable production image %s\n' "$image"
  return 1
}

production_require_release_provenance() {
  local production_root=$1
  local release_tag=$2
  local releases_directory="$production_root/releases"
  local candidate release_name

  production_validate_full_sha "$release_tag"
  [[ -d $releases_directory ]] || production_die "release directory not found: $releases_directory"

  production_release_provenance=''
  for candidate in "$releases_directory"/*-"$release_tag"; do
    [[ -d $candidate && ! -L $candidate ]] || continue
    release_name=${candidate##*/}
    [[ $release_name =~ ^[0-9]{8}T[0-9]{6}Z-${release_tag}$ ]] || continue
    production_release_provenance=$candidate
    break
  done

  [[ -n $production_release_provenance ]] || \
    production_die "no retained immutable release proves provenance for rollback SHA $release_tag"
}

production_require_compatible_compose_contract() {
  local current_release=$1
  local target_release=$2
  local current_compose="$current_release/compose.prod.yaml"
  local target_compose="$target_release/compose.prod.yaml"

  [[ -f $current_compose && ! -L $current_compose ]] ||
    production_die "current release has no regular production Compose contract: $current_compose"
  [[ -f $target_compose && ! -L $target_compose ]] ||
    production_die "rollback target has no regular production Compose contract: $target_compose"
  cmp -s -- "$current_compose" "$target_compose" ||
    production_die "rollback target uses a different production Compose contract; deploy a forward fix instead"
}

production_require_partial_deploy_contract() {
  local scope=$1
  local production_root=$2
  local candidate_release=$3
  local current_link="$production_root/current"
  local current_release

  production_validate_scope "$scope"
  [[ $scope != all ]] || return 0
  [[ -L $current_link ]] ||
    production_die "partial deployment requires an active current release"
  current_release=$(cd -- "$current_link" && pwd -P) ||
    production_die "current release link is broken: $current_link"
  [[ $current_release == "$production_root/releases/"* ]] ||
    production_die "current release resolves outside the immutable release root"
  production_require_compatible_compose_contract "$current_release" "$candidate_release"
}

production_validate_nginx_site_paths() {
  local available_path=$1
  local enabled_path=$2

  if [[ -e $available_path || -L $available_path ]]; then
    [[ -f $available_path && ! -L $available_path ]] ||
      production_die "nginx available-site path is not a regular non-symlink file: $available_path"
  fi
  if [[ -e $enabled_path || -L $enabled_path ]]; then
    [[ -L $enabled_path ]] ||
      production_die "nginx enabled-site path is not a symlink: $enabled_path"
  fi
}

production_prepare_partial_backup() {
  local backup_root=$1
  local backup_id=$2

  [[ -d $backup_root && ! -L $backup_root ]] ||
    production_die "backup root must be a real directory: $backup_root"
  [[ $backup_id =~ ^pre-import-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] ||
    production_die "invalid pre-import backup id: $backup_id"

  production_partial_backup_directory=$(mktemp -d "$backup_root/.partial-${backup_id}.XXXXXX") ||
    production_die "could not create partial pre-import backup"
  chmod 700 "$production_partial_backup_directory" || {
    rm -rf -- "$production_partial_backup_directory"
    production_die "could not secure partial pre-import backup"
  }
}

production_commit_partial_backup() {
  local backup_root=$1
  local partial_directory=$2
  local partial_name final_name

  [[ -d $backup_root && ! -L $backup_root ]] ||
    production_die "backup root must be a real directory: $backup_root"
  [[ -d $partial_directory && ! -L $partial_directory ]] ||
    production_die "partial pre-import backup is missing or unsafe: $partial_directory"
  [[ ${partial_directory%/*} == "$backup_root" ]] ||
    production_die "partial pre-import backup is outside its root"

  partial_name=${partial_directory##*/}
  [[ $partial_name =~ ^\.partial-(pre-import-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.[A-Za-z0-9]+)$ ]] ||
    production_die "partial pre-import backup has an invalid name"
  final_name=${BASH_REMATCH[1]}
  production_backup_directory="$backup_root/$final_name"
  [[ ! -e $production_backup_directory ]] ||
    production_die "completed pre-import backup already exists: $production_backup_directory"

  mv -- "$partial_directory" "$production_backup_directory" ||
    production_die "could not atomically commit pre-import backup"
}

production_cleanup_partial_backup() {
  local backup_root=$1
  local partial_directory=${2:-}
  local partial_name

  [[ -n $partial_directory ]] || return 0
  [[ -d $backup_root && ! -L $backup_root ]] || return 1
  [[ ${partial_directory%/*} == "$backup_root" ]] || return 1
  partial_name=${partial_directory##*/}
  [[ $partial_name =~ ^\.partial-pre-import-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.[A-Za-z0-9]+$ ]] || return 1

  if [[ -e $partial_directory ]]; then
    [[ -d $partial_directory && ! -L $partial_directory ]] || return 1
    rm -rf -- "$partial_directory"
  fi
}

production_start_data_services() {
  local wait_timeout=${PRODUCTION_WAIT_TIMEOUT_SECONDS:-900}

  [[ $wait_timeout =~ ^[1-9][0-9]*$ ]] || production_die "PRODUCTION_WAIT_TIMEOUT_SECONDS must be a positive integer"
  "${production_compose[@]}" up -d --no-build --wait --wait-timeout "$wait_timeout" postgres mongo redis
}

production_run_migration() {
  "${production_compose[@]}" run --rm --no-deps migrate
}

production_wait_for_url() {
  local label=$1
  local url=$2
  local attempts=${PRODUCTION_READINESS_ATTEMPTS:-30}
  local delay=${PRODUCTION_READINESS_DELAY_SECONDS:-2}
  local attempt

  [[ -n $url ]] || return 0
  command -v curl >/dev/null 2>&1 || {
    printf 'curl is unavailable; Compose health remains the readiness gate for %s\n' "$label" >&2
    return 0
  }
  [[ $attempts =~ ^[1-9][0-9]*$ ]] || production_die "PRODUCTION_READINESS_ATTEMPTS must be a positive integer"
  [[ $delay =~ ^[0-9]+$ ]] || production_die "PRODUCTION_READINESS_DELAY_SECONDS must be a non-negative integer"

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --show-error --silent --connect-timeout 3 --max-time 10 --output /dev/null "$url"; then
      return 0
    fi
    if ((attempt < attempts)); then
      sleep "$delay"
    fi
  done

  production_die "$label did not become ready at $url after $attempts attempts"
}

production_wait_for_web_release() {
  local label=$1
  local url=$2
  local expected_release=$3
  local attempts=${PRODUCTION_READINESS_ATTEMPTS:-30}
  local delay=${PRODUCTION_READINESS_DELAY_SECONDS:-2}
  local expected_payload actual_payload
  local attempt

  production_validate_full_sha "$expected_release"
  [[ $attempts =~ ^[1-9][0-9]*$ ]] || production_die "PRODUCTION_READINESS_ATTEMPTS must be a positive integer"
  [[ $delay =~ ^[0-9]+$ ]] || production_die "PRODUCTION_READINESS_DELAY_SECONDS must be a non-negative integer"
  command -v curl >/dev/null 2>&1 || production_die "curl is required to verify the deployed web release"
  expected_payload="{\"release\":\"$expected_release\"}"

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    actual_payload=$(curl --fail --show-error --silent --connect-timeout 3 --max-time 10 "$url" 2>/dev/null || true)
    if [[ $actual_payload == "$expected_payload" ]]; then
      return 0
    fi
    if ((attempt < attempts)); then
      sleep "$delay"
    fi
  done

  production_die "$label did not serve the expected web release $expected_release at $url"
}

production_assert_service_running() {
  local service=$1

  if ! "${production_compose[@]}" ps --status running --services "$service" | grep -Fxq "$service"; then
    production_die "$service is not running after activation"
  fi
}

production_activate_scope() {
  local scope=$1
  local wait_timeout=${PRODUCTION_WAIT_TIMEOUT_SECONDS:-900}
  local api_url=${PRODUCTION_API_READINESS_URL:-http://127.0.0.1:5201/api/v1/health/ready}
  local web_url=${PRODUCTION_WEB_READINESS_URL:-http://127.0.0.1:5200/deploy.json}

  case $scope in
    all | backend)
      "${production_compose[@]}" up -d --no-build --no-deps --wait --wait-timeout "$wait_timeout" api
      production_wait_for_url api "$api_url"
      "${production_compose[@]}" up -d --no-build --no-deps --wait --wait-timeout "$wait_timeout" worker
      production_assert_service_running worker
      ;;
    admin)
      # The web tier is useful only while the existing API is actually ready.
      production_wait_for_url api "$api_url"
      ;;
  esac

  case $scope in
    all | admin)
      "${production_compose[@]}" up -d --no-build --no-deps --wait --wait-timeout "$wait_timeout" web
      production_wait_for_web_release web "$web_url" "$WEB_RELEASE_TAG"
      ;;
  esac
}

production_keep_contains() {
  local candidate=$1
  shift
  local kept

  for kept in "$@"; do
    [[ $kept == "$candidate" ]] && return 0
  done
  return 1
}

production_prune_releases() {
  local production_root=$1
  local releases_directory="$production_root/releases"
  local current_link="$production_root/current"
  local current_release=''
  local directory name tag candidate
  local keep_count=0
  local -a discovered_releases=()
  local -a sorted_releases=()
  local -a kept_releases=()
  local -a active_tags=("$MIGRATE_RELEASE_TAG" "$API_RELEASE_TAG" "$WORKER_RELEASE_TAG" "$WEB_RELEASE_TAG")

  [[ -d $releases_directory ]] || production_die "release directory not found: $releases_directory"

  if [[ -L $current_link ]]; then
    current_release=$(cd -- "$current_link" && pwd -P) || production_die "current release link is broken: $current_link"
  elif [[ -e $current_link ]]; then
    production_die "$current_link exists and is not a symbolic link"
  fi

  for directory in "$releases_directory"/*; do
    [[ -d $directory ]] || continue
    name=${directory##*/}
    [[ $name =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$ ]] || continue
    discovered_releases+=("$directory")
  done

  if ((${#discovered_releases[@]} == 0)); then
    return 0
  fi

  while IFS= read -r directory; do
    sorted_releases+=("$directory")
  done < <(printf '%s\n' "${discovered_releases[@]}" | LC_ALL=C sort -r)

  if [[ -n $current_release ]]; then
    [[ $current_release == "$releases_directory/"* ]] || production_die "current release resolves outside $releases_directory"
    production_keep_contains "$current_release" "${kept_releases[@]-}" || kept_releases+=("$current_release")
  fi

  # Keep the newest unpacked release matching each currently active image tag.
  for tag in "${active_tags[@]}"; do
    for candidate in "${sorted_releases[@]}"; do
      [[ $candidate == *"-$tag" ]] || continue
      production_keep_contains "$candidate" "${kept_releases[@]-}" || kept_releases+=("$candidate")
      break
    done
  done

  keep_count=${#kept_releases[@]}
  for candidate in "${sorted_releases[@]}"; do
    ((keep_count >= 5)) && break
    if ! production_keep_contains "$candidate" "${kept_releases[@]-}"; then
      kept_releases+=("$candidate")
      ((keep_count += 1))
    fi
  done

  for candidate in "${sorted_releases[@]}"; do
    production_keep_contains "$candidate" "${kept_releases[@]-}" && continue
    [[ $candidate == "$releases_directory/"* ]] || production_die "refusing to remove release outside $releases_directory"
    name=${candidate##*/}
    [[ $name =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$ ]] || production_die "refusing to remove malformed release path: $candidate"
    [[ $candidate != "$current_release" ]] || production_die "refusing to remove current release: $candidate"
    rm -rf -- "$candidate"
    printf 'Removed superseded release %s\n' "$name"
  done
}
