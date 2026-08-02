#!/usr/bin/env bash
set -Eeuo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=production-common.sh
source "$repository_root/scripts/production-common.sh"

usage() {
  cat <<'EOF'
Usage: rollback-production.sh <all|admin|backend> <full-git-sha> [environment-file]

Activate existing immutable images without rebuilding them. Database changes
remain forward-only; backend rollback reruns the target release's idempotent
migration image but never reverses an applied migration.
EOF
}

if (( $# < 2 || $# > 3 )); then
  usage >&2
  exit 2
fi

scope=$1
requested_release=$2
environment_file=${3:-.env.production}

if [[ $scope == -h || $scope == --help || $scope == help ]]; then
  usage
  exit 0
fi

production_validate_scope "$scope"
production_validate_full_sha "$requested_release"
production_require_commands cmp curl docker flock grep mktemp mv python3 sort

production_root=${PRODUCTION_ROOT:-/opt/slopform}
production_validate_root "$production_root"
production_resolve_environment_file "$repository_root" "$environment_file"

state_file="$production_root/shared/release-state.env"
production_acquire_lock
production_load_state "$state_file" || production_die "cannot roll back before the initial full deployment"
production_require_release_provenance "$production_root" "$requested_release"
production_require_compatible_compose_contract "$repository_root" "$production_release_provenance"

case $scope in
  all)
    MIGRATE_RELEASE_TAG=$requested_release
    API_RELEASE_TAG=$requested_release
    WORKER_RELEASE_TAG=$requested_release
    WEB_RELEASE_TAG=$requested_release
    required_images=(migrate api worker web)
    ;;
  admin)
    WEB_RELEASE_TAG=$requested_release
    required_images=(web)
    ;;
  backend)
    MIGRATE_RELEASE_TAG=$requested_release
    API_RELEASE_TAG=$requested_release
    WORKER_RELEASE_TAG=$requested_release
    required_images=(migrate api worker)
    ;;
esac

production_export_state
production_compose_init "$repository_root" "$production_environment_file"
production_validate_compose
production_resolve_web_public_config_hash
production_validate_compose

for image_name in "${required_images[@]}"; do
  production_verify_image_contract "$image_name" "$requested_release" "$WEB_PUBLIC_CONFIG_SHA256"
done

case $scope in
  all | backend)
    production_start_data_services
    production_run_migration
    ;;
esac

production_write_state_atomically "$state_file"
production_activate_scope "$scope"

"${production_compose[@]}" ps
production_prune_releases "$production_root"

printf 'Rolled back %s to %s; database changes remain forward-only\n' "$scope" "$requested_release"
