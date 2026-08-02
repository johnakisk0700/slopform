#!/usr/bin/env bash
set -Eeuo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=production-common.sh
source "$repository_root/scripts/production-common.sh"

fail() {
  printf 'production operator spec: %s\n' "$1" >&2
  exit 1
}

temporary_parent=${TMPDIR:-/tmp}
temporary_parent=${temporary_parent%/}
temporary_parent=$(cd -- "$temporary_parent" && pwd -P)
temporary_root=$(mktemp -d "$temporary_parent/join-the-six-production-spec.XXXXXX")
cleanup() {
  [[ $temporary_root == "$temporary_parent/join-the-six-production-spec."* ]] || return 0
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

mkdir -p "$temporary_root/shared" "$temporary_root/releases"
state_file="$temporary_root/shared/release-state.env"

MIGRATE_RELEASE_TAG=1111111111111111111111111111111111111111
API_RELEASE_TAG=2222222222222222222222222222222222222222
WORKER_RELEASE_TAG=2222222222222222222222222222222222222222
WEB_RELEASE_TAG=7777777777777777777777777777777777777777
production_write_state_atomically "$state_file"

MIGRATE_RELEASE_TAG=''
API_RELEASE_TAG=''
WORKER_RELEASE_TAG=''
WEB_RELEASE_TAG=''
production_load_state "$state_file"
[[ $MIGRATE_RELEASE_TAG == 1111111111111111111111111111111111111111 ]] || fail 'migration state did not round-trip'
[[ $API_RELEASE_TAG == 2222222222222222222222222222222222222222 ]] || fail 'API state did not round-trip'
[[ $WORKER_RELEASE_TAG == 2222222222222222222222222222222222222222 ]] || fail 'worker state did not round-trip'
[[ $WEB_RELEASE_TAG == 7777777777777777777777777777777777777777 ]] || fail 'web state did not round-trip'

for release_number in 1 2 3 4 5 6 7; do
  release_sha=0000000000000000000000000000000000000000
  release_sha=${release_sha//0/$release_number}
  mkdir "$temporary_root/releases/20260801T00000${release_number}Z-$release_sha"
done
ln -s "$temporary_root/releases/20260801T000007Z-$WEB_RELEASE_TAG" "$temporary_root/current"

production_prune_releases "$temporary_root" >/dev/null
release_count=$(find "$temporary_root/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
[[ $release_count == 5 ]] || fail "expected five retained releases, found $release_count"
[[ -d $temporary_root/releases/20260801T000001Z-$MIGRATE_RELEASE_TAG ]] || fail 'active migration release was pruned'
[[ -d $temporary_root/releases/20260801T000002Z-$API_RELEASE_TAG ]] || fail 'active backend release was pruned'
[[ -d $temporary_root/releases/20260801T000007Z-$WEB_RELEASE_TAG ]] || fail 'current web release was pruned'
[[ ! -e $temporary_root/releases/20260801T000003Z-3333333333333333333333333333333333333333 ]] || fail 'superseded release was retained'

production_require_release_provenance "$temporary_root" "$WEB_RELEASE_TAG"
[[ $production_release_provenance == "$temporary_root/releases/20260801T000007Z-$WEB_RELEASE_TAG" ]] || fail 'retained release provenance was not resolved'
if (production_require_release_provenance "$temporary_root" 9999999999999999999999999999999999999999) >/dev/null 2>&1; then
  fail 'rollback provenance accepted a release that was not retained'
fi

current_release="$temporary_root/releases/20260801T000007Z-$WEB_RELEASE_TAG"
compatible_release="$temporary_root/releases/20260801T000002Z-$API_RELEASE_TAG"
printf 'services: {}\n' > "$current_release/compose.prod.yaml"
printf 'services: {}\n' > "$compatible_release/compose.prod.yaml"
production_require_compatible_compose_contract "$current_release" "$compatible_release"
production_require_partial_deploy_contract admin "$temporary_root" "$compatible_release"
printf 'services:\n  api: {}\n' > "$compatible_release/compose.prod.yaml"
if (production_require_compatible_compose_contract "$current_release" "$compatible_release") >/dev/null 2>&1; then
  fail 'rollback accepted a different production Compose contract'
fi
if (production_require_partial_deploy_contract backend "$temporary_root" "$compatible_release") >/dev/null 2>&1; then
  fail 'partial deploy accepted a different production Compose contract'
fi
production_require_partial_deploy_contract all "$temporary_root" "$compatible_release"

backup_root="$temporary_root/backups"
mkdir "$backup_root"
production_prepare_partial_backup "$backup_root" "pre-import-20260801T010203Z-aaaaaaaaaaaa"
failed_partial=$production_partial_backup_directory
printf 'incomplete\n' > "$failed_partial/postgres.dump"
production_cleanup_partial_backup "$backup_root" "$failed_partial"
[[ ! -e $failed_partial ]] || fail 'an incomplete pre-import backup survived failure cleanup'
[[ -z $(find "$backup_root" -mindepth 1 -maxdepth 1 -name 'pre-import-*' -print) ]] ||
  fail 'an incomplete pre-import backup became visible as completed'

production_prepare_partial_backup "$backup_root" "pre-import-20260801T010204Z-bbbbbbbbbbbb"
completed_partial=$production_partial_backup_directory
printf 'validated\n' > "$completed_partial/postgres.dump"
production_commit_partial_backup "$backup_root" "$completed_partial"
[[ -d $production_backup_directory ]] || fail 'validated pre-import backup was not committed'
[[ ! -e $completed_partial ]] || fail 'partial backup path survived atomic commit'

test_sha=cccccccccccccccccccccccccccccccccccccccc
test_public_hash=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
(
  docker() {
    local format=''
    [[ $1 == image && $2 == inspect ]] || return 1
    shift 2
    if [[ ${1:-} == --format ]]; then
      format=$2
      shift 2
    fi
    [[ ${1:-} == "join-the-six-web:$test_sha" ]] || return 1
    case $format in
      '') return 0 ;;
      *org.opencontainers.image.revision*) printf '%s\n' "$test_sha" ;;
      *org.join-the-six.web-public-config-sha256*) printf '%s\n' "$test_public_hash" ;;
      *) return 1 ;;
    esac
  }
  if production_image_needs_build web "$test_sha" "$test_public_hash"; then
    exit 91
  fi
) >/dev/null || fail 'same-SHA web retry did not reuse the matching immutable image'

mismatch_file="$temporary_root/public-config-mismatch.log"
if (
  docker() {
    local format=''
    [[ $1 == image && $2 == inspect ]] || return 1
    shift 2
    if [[ ${1:-} == --format ]]; then
      format=$2
      shift 2
    fi
    [[ ${1:-} == "join-the-six-web:$test_sha" ]] || return 1
    case $format in
      '') return 0 ;;
      *org.opencontainers.image.revision*) printf '%s\n' "$test_sha" ;;
      *org.join-the-six.web-public-config-sha256*) printf '%s\n' "$test_public_hash" ;;
      *) return 1 ;;
    esac
  }
  production_image_needs_build web "$test_sha" eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
) >"$mismatch_file" 2>&1; then
  fail 'same-SHA web retry accepted different public configuration'
fi
mismatch_output=$(<"$mismatch_file")
[[ $mismatch_output == *'different public configuration'* ]] ||
  fail 'same-SHA public-config rejection was not explicit'

(
  curl() { printf '{"release":"%s"}\n' "$test_sha"; }
  production_wait_for_web_release web http://example.invalid/deploy.json "$test_sha"
) || fail 'web readiness rejected exact deploy metadata'

if (
  export PRODUCTION_READINESS_ATTEMPTS=1
  curl() { printf '{"release":"ffffffffffffffffffffffffffffffffffffffff"}\n'; }
  production_wait_for_web_release web http://example.invalid/deploy.json "$test_sha"
) >/dev/null 2>&1; then
  fail 'web readiness accepted a stale release'
fi
production_web_deploy_payload_matches '{"release":"cccccccccccccccccccccccccccccccccccccccc"}'
if production_web_deploy_payload_matches '{release:"cccccccccccccccccccccccccccccccccccccccc"}'; then
  fail 'generic public smoke accepted malformed deploy metadata'
fi

nginx_available="$temporary_root/nginx.available"
nginx_enabled="$temporary_root/nginx.enabled"
printf 'server {}\n' > "$nginx_available"
ln -s "$nginx_available" "$nginx_enabled"
production_validate_nginx_site_paths "$nginx_available" "$nginx_enabled"
rm "$nginx_enabled"
printf 'not-a-symlink\n' > "$nginx_enabled"
if (production_validate_nginx_site_paths "$nginx_available" "$nginx_enabled") >/dev/null 2>&1; then
  fail 'edge path guard accepted a regular enabled-site file'
fi
rm "$nginx_enabled"
ln -s "$temporary_root/missing" "$nginx_available.link"
if (production_validate_nginx_site_paths "$nginx_available.link" "$nginx_enabled") >/dev/null 2>&1; then
  fail 'edge path guard accepted a symlink as the available-site file'
fi

printf 'NOT_A_RELEASE_TAG=bad\n' > "$state_file"
if (production_load_state "$state_file") >/dev/null 2>&1; then
  fail 'malformed state was accepted'
fi

help_output=$(bash "$repository_root/scripts/prod.sh" help)
[[ $help_output == *'deploy [all|admin|backend]'* ]] || fail 'public deploy help is missing'
[[ $help_output == *'data <push|status|seal>'* ]] || fail 'public data help is missing'
[[ $help_output == *'root@203.0.113.10'* ]] || fail 'default VPS target is missing from help'
[[ $help_output == *'https://slopform.example.com'* ]] || fail 'default public origin is missing from help'

if bash "$repository_root/scripts/prod.sh" deploy nonsense >/dev/null 2>&1; then
  fail 'invalid public deploy scope was accepted'
fi
if bash "$repository_root/scripts/rollback-production.sh" admin short-sha >/dev/null 2>&1; then
  fail 'abbreviated rollback SHA was accepted'
fi

printf 'production operator spec: ok\n'
