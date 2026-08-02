#!/usr/bin/env bash
set -Eeuo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=production-common.sh
source "$repository_root/scripts/production-common.sh"

usage() {
  cat <<'EOF'
Usage: deploy-production.sh [all|admin|backend] [environment-file]

Build and activate an immutable release already unpacked under
/opt/slopform/releases. This is the server-side entrypoint; operators
normally use scripts/prod.sh from their local checkout.

Scopes:
  all      Build, migrate, and activate API, worker, and web (default).
  admin    Build and activate only web.
  backend  Build, migrate, and activate only API and worker.
EOF
}

if (( $# > 2 )); then
  usage >&2
  exit 2
fi

scope=${1:-all}
environment_file=${2:-.env.production}

if [[ $scope == -h || $scope == --help || $scope == help ]]; then
  usage
  exit 0
fi

production_validate_scope "$scope"
production_require_commands cmp curl docker flock grep mktemp mv python3 sort

production_root=${PRODUCTION_ROOT:-/opt/slopform}
production_validate_root "$production_root"

release_tag=${DEPLOY_RELEASE_TAG:-}
if [[ -z $release_tag ]]; then
  production_require_commands git
  cd "$repository_root"
  [[ -z $(git status --porcelain --untracked-files=normal) ]] || production_die "refusing to derive a release from a dirty worktree"
  release_tag=$(git rev-parse --verify 'HEAD^{commit}')
fi
production_validate_full_sha "$release_tag"
production_validate_release_root "$repository_root" "$production_root" "$release_tag"
production_resolve_environment_file "$repository_root" "$environment_file"

shared_directory="$production_root/shared"
state_file="$shared_directory/release-state.env"
[[ -d $shared_directory ]] || production_die "shared production directory not found: $shared_directory"
[[ -d $shared_directory/secrets ]] || production_die "shared production secrets directory not found: $shared_directory/secrets"

production_acquire_lock

had_existing_state=0
if production_load_state "$state_file"; then
  had_existing_state=1
elif [[ $scope != all ]]; then
  production_die "the first production deployment must use scope 'all'"
fi

if ((had_existing_state == 1)); then
  production_require_partial_deploy_contract "$scope" "$production_root" "$repository_root"
fi

if ((had_existing_state == 0)); then
  MIGRATE_RELEASE_TAG=$release_tag
  API_RELEASE_TAG=$release_tag
  WORKER_RELEASE_TAG=$release_tag
  WEB_RELEASE_TAG=$release_tag
else
  case $scope in
    all)
      MIGRATE_RELEASE_TAG=$release_tag
      API_RELEASE_TAG=$release_tag
      WORKER_RELEASE_TAG=$release_tag
      WEB_RELEASE_TAG=$release_tag
      ;;
    admin)
      WEB_RELEASE_TAG=$release_tag
      ;;
    backend)
      MIGRATE_RELEASE_TAG=$release_tag
      API_RELEASE_TAG=$release_tag
      WORKER_RELEASE_TAG=$release_tag
      ;;
  esac
fi

production_export_state
production_compose_init "$repository_root" "$production_environment_file"
production_validate_compose
production_resolve_web_public_config_hash
production_validate_compose

case $scope in
  all)
    requested_images=(migrate api worker web)
    ;;
  admin)
    requested_images=(web)
    ;;
  backend)
    requested_images=(migrate api worker)
    ;;
esac

images_to_build=()
for image_name in "${requested_images[@]}"; do
  if production_image_needs_build "$image_name" "$release_tag" "$WEB_PUBLIC_CONFIG_SHA256"; then
    images_to_build+=("$image_name")
  fi
done

if ((${#images_to_build[@]} > 0)); then
  "${production_compose[@]}" build --pull "${images_to_build[@]}"
fi

for image_name in "${requested_images[@]}"; do
  production_verify_image_contract "$image_name" "$release_tag" "$WEB_PUBLIC_CONFIG_SHA256"
done

# No running application container is replaced before every requested image is
# built. Backend activation also remains behind the forward-only migration gate.
case $scope in
  all | backend)
    production_start_data_services
    production_run_migration
    ;;
esac

# Persist the complete desired component set before phased replacement. If a
# later health gate fails, a rerun/restart still resolves every service to the
# intended immutable image rather than mixing defaults with stale tags.
production_write_state_atomically "$state_file"
production_activate_current_release "$repository_root" "$production_root"
production_activate_scope "$scope"

"${production_compose[@]}" ps
production_prune_releases "$production_root"

printf 'Deployed %s release %s\n' "$scope" "$release_tag"
