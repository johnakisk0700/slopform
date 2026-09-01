#!/usr/bin/env bash
set -Eeuo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=production-common.sh
source "$repository_root/scripts/production-common.sh"

usage() {
  cat <<'EOF'
Slopform production operator

Usage:
  scripts/prod.sh deploy [all|admin|backend]
  scripts/prod.sh status
  scripts/prod.sh logs [postgres|mongo|redis|migrate|api|worker|web|nginx]
  scripts/prod.sh rollback <all|admin|backend> <full-git-sha>
  scripts/prod.sh edge
  scripts/prod.sh data <push|status|seal>
  scripts/prod.sh help

Commands:
  deploy    Archive the clean local HEAD over SSH, build before replacement,
            and activate it in phases. Scope defaults to all; the first deploy
            must be all. A full deploy also installs the host nginx edge.
  status    Show the current release, per-component image state, and Compose
            service status on the VPS.
  logs      Show the last PRODUCTION_LOG_TAIL lines (default 200). nginx uses
            the host journal; all other names are Compose services.
  rollback  Activate already-built SHA-tagged images. Migrations are never
            reversed. The SHA must be the exact 40-character commit id.
  edge      Reinstall/test/reload the checked-in host nginx configuration, then
            smoke-test the public site.
  data      Dispatch the guarded logical PostgreSQL + MongoDB transfer workflow
            to scripts/production-data.sh. Redis is deliberately fresh. push
            requires an explicit remote import window and the confirmations
            documented by that script; seal closes the window permanently.

Connection defaults (all configurable through the named environment variable):
  PRODUCTION_SSH_TARGET=root@203.0.113.10
  PRODUCTION_SSH_KEY=$HOME/.ssh/id_ed25519
  PRODUCTION_SSH_CONNECT_TIMEOUT=10
  PRODUCTION_SSH_OPTIONS=        optional extra space-separated ssh arguments
  PRODUCTION_ROOT=/opt/slopform
  PRODUCTION_PUBLIC_URL=https://slopform.example.com

Data safety confirmations:
  push requires CONFIRM_PRODUCTION_DATA_PUSH=slopform.example.com and
  CONFIRM_LOCAL_DATA_QUIESCED=I_HAVE_STOPPED_ALL_JOIN_THE_SIX_LOCAL_WRITERS.
  seal requires CONFIRM_SEAL_DATA_IMPORT_WINDOW=slopform.example.com.

There is intentionally no raw-volume bootstrap command. Use `data push` during
the guarded import window; copying PostgreSQL/MongoDB volume internals between
machines is not deployment automation, it is a corruption raffle.
EOF
}

die() {
  local message=$1
  local exit_code=${2:-1}

  printf 'Error: %s\n' "$message" >&2
  exit "$exit_code"
}

validate_scope() {
  case ${1:-} in
    all | admin | backend) ;;
    *) die "scope must be one of: all, admin, backend" 2 ;;
  esac
}

validate_full_sha() {
  [[ ${1:-} =~ ^[0-9a-f]{40}$ ]] || die "Git SHA must be the exact 40-character lowercase commit id" 2
}

require_local_command() {
  command -v "$1" >/dev/null 2>&1 || die "required local command not found: $1"
}

configure_connection() {
  PRODUCTION_SSH_TARGET=${PRODUCTION_SSH_TARGET:-root@203.0.113.10}
  PRODUCTION_ROOT=${PRODUCTION_ROOT:-/opt/slopform}
  PRODUCTION_SSH_KEY=${PRODUCTION_SSH_KEY:-$HOME/.ssh/id_ed25519}
  PRODUCTION_SSH_CONNECT_TIMEOUT=${PRODUCTION_SSH_CONNECT_TIMEOUT:-10}
  PRODUCTION_SSH_OPTIONS=${PRODUCTION_SSH_OPTIONS:-}
  PRODUCTION_PUBLIC_URL=${PRODUCTION_PUBLIC_URL:-https://slopform.example.com}

  [[ $PRODUCTION_SSH_TARGET != -* && $PRODUCTION_SSH_TARGET != *[[:space:]]* ]] || die "unsafe PRODUCTION_SSH_TARGET"
  [[ $PRODUCTION_ROOT =~ ^/[A-Za-z0-9._/-]+$ ]] || die "PRODUCTION_ROOT must be an absolute path containing only safe path characters"
  [[ $PRODUCTION_ROOT != / && $PRODUCTION_ROOT != */ && $PRODUCTION_ROOT != *//* && $PRODUCTION_ROOT != */../* && $PRODUCTION_ROOT != */.. && $PRODUCTION_ROOT != */./* && $PRODUCTION_ROOT != */. ]] || die "unsafe PRODUCTION_ROOT"
  [[ $PRODUCTION_SSH_CONNECT_TIMEOUT =~ ^[1-9][0-9]*$ ]] || die "PRODUCTION_SSH_CONNECT_TIMEOUT must be a positive integer"
  [[ $PRODUCTION_SSH_OPTIONS != *$'\n'* && $PRODUCTION_SSH_OPTIONS != *$'\r'* ]] || die "PRODUCTION_SSH_OPTIONS must be a single line"
  [[ $PRODUCTION_PUBLIC_URL =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "PRODUCTION_PUBLIC_URL must be an origin without a path"
  [[ -r $PRODUCTION_SSH_KEY ]] || die "SSH identity is not readable: $PRODUCTION_SSH_KEY"

  ssh_arguments=(
    -i "$PRODUCTION_SSH_KEY"
    -o IdentitiesOnly=yes
    -o BatchMode=yes
    -o "ConnectTimeout=$PRODUCTION_SSH_CONNECT_TIMEOUT"
  )

  if [[ -n $PRODUCTION_SSH_OPTIONS ]]; then
    # Deliberately split as plain argv, never eval. Put complex ProxyCommand
    # quoting in ~/.ssh/config and use a target alias instead.
    read -r -a extra_ssh_arguments <<< "$PRODUCTION_SSH_OPTIONS"
    ssh_arguments+=("${extra_ssh_arguments[@]}")
  fi

  export PRODUCTION_SSH_TARGET PRODUCTION_ROOT PRODUCTION_SSH_KEY
  export PRODUCTION_SSH_CONNECT_TIMEOUT PRODUCTION_SSH_OPTIONS PRODUCTION_PUBLIC_URL
}

run_ssh_script() {
  local remote_command='bash -s --'
  local argument quoted_argument

  for argument in "$@"; do
    printf -v quoted_argument '%q' "$argument"
    remote_command+=" $quoted_argument"
  done

  ssh "${ssh_arguments[@]}" "$PRODUCTION_SSH_TARGET" "$remote_command"
}

public_smoke() {
  local expected_web_release=${1:-}
  local deploy_payload

  require_local_command curl

  if [[ -n $expected_web_release ]]; then
    validate_full_sha "$expected_web_release"
  fi

  printf 'Public smoke: %s\n' "$PRODUCTION_PUBLIC_URL"
  curl --fail --show-error --silent --location --max-redirs 3 \
    --retry 5 --retry-delay 2 --retry-connrefused \
    --connect-timeout 10 --max-time 30 \
    --output /dev/null "$PRODUCTION_PUBLIC_URL/api/v1/health/ready"
  deploy_payload=$(curl --fail --show-error --silent --location --max-redirs 3 \
    --retry 5 --retry-delay 2 --retry-connrefused \
    --connect-timeout 10 --max-time 30 \
    "$PRODUCTION_PUBLIC_URL/deploy.json")
  if [[ -n $expected_web_release ]]; then
    production_web_deploy_payload_matches "$deploy_payload" "$expected_web_release" ||
      die "public SPA is not serving expected release $expected_web_release"
  else
    production_web_deploy_payload_matches "$deploy_payload" ||
      die "public SPA deploy metadata is malformed"
  fi
  curl --fail --show-error --silent --location --max-redirs 3 \
    --retry 5 --retry-delay 2 --retry-connrefused \
    --connect-timeout 10 --max-time 30 \
    --output /dev/null "$PRODUCTION_PUBLIC_URL/"
}

require_clean_head() {
  local canonical_head

  require_local_command git
  cd "$repository_root"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a Git worktree: $repository_root"
  [[ -z $(git status --porcelain --untracked-files=normal) ]] || die "refusing to deploy a dirty worktree"
  canonical_head=$(git rev-parse --verify 'HEAD^{commit}')
  validate_full_sha "$canonical_head"
  printf '%s\n' "$canonical_head"
}

deploy_release() {
  local scope=$1
  local release_tag release_timestamp release_id remote_archive remote_upload_command

  validate_scope "$scope"
  configure_connection
  require_local_command curl
  require_local_command date
  require_local_command ssh
  release_tag=$(require_clean_head)
  release_timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  release_id="$release_timestamp-$release_tag"
  remote_archive="$PRODUCTION_ROOT/shared/.upload-$release_id-$$.tar"

  # Values embedded in this one upload command have already been restricted to
  # a safe path alphabet. The archive itself is streamed by SSH; the private VPS
  # never needs repository credentials or a mutable checkout.
  remote_upload_command="set -eu; umask 077; install -d -m 755 '$PRODUCTION_ROOT' '$PRODUCTION_ROOT/releases'; install -d -m 700 '$PRODUCTION_ROOT/shared'; test ! -e '$remote_archive'; cat > '$remote_archive'"
  git -C "$repository_root" archive --format=tar "$release_tag" | \
    ssh "${ssh_arguments[@]}" "$PRODUCTION_SSH_TARGET" "$remote_upload_command"

  run_ssh_script "$PRODUCTION_ROOT" "$remote_archive" "$release_id" "$release_tag" "$scope" <<'REMOTE_DEPLOY'
set -Eeuo pipefail

production_root=$1
archive_file=$2
release_id=$3
release_tag=$4
scope=$5
lock_file=/var/lock/join-the-six-production.lock
release_directory="$production_root/releases/$release_id"
partial_release="$production_root/releases/.partial-$release_id-$$"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit "${2:-1}"
}

cleanup() {
  rm -f -- "$archive_file"
  if [[ -n ${partial_release:-} && -d $partial_release ]]; then
    [[ $partial_release == "$production_root/releases/.partial-"* ]] || return 0
    rm -rf -- "$partial_release"
  fi
}

[[ $production_root =~ ^/[A-Za-z0-9._/-]+$ && $production_root != / ]] || fail 'unsafe production root'
[[ $release_id =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$ ]] || fail 'invalid release id'
[[ $release_tag =~ ^[0-9a-f]{40}$ && $release_id == *"-$release_tag" ]] || fail 'release SHA mismatch'
archive_name=${archive_file##*/}
[[ ${archive_file%/*} == "$production_root/shared" ]] || fail 'release archive is outside the shared staging directory'
[[ $archive_name =~ ^\.upload-${release_id}-[0-9]+\.tar$ ]] || fail 'invalid release archive name'
case $scope in all | admin | backend) ;; *) fail 'invalid deployment scope' 2 ;; esac
trap cleanup EXIT

for required_command in flock install ln mv rm tar; do
  command -v "$required_command" >/dev/null 2>&1 || fail "required remote command not found: $required_command"
done

exec 9>"$lock_file"
flock --nonblock 9 || fail "another production operation holds $lock_file"

[[ -f $archive_file && ! -L $archive_file ]] || fail "release archive is unavailable: $archive_file"
[[ -f $production_root/shared/.env.production && ! -L $production_root/shared/.env.production ]] || \
  fail "create the regular file $production_root/shared/.env.production before deploying"
[[ -d $production_root/shared/secrets && ! -L $production_root/shared/secrets ]] || \
  fail "create the regular directory $production_root/shared/secrets before deploying"
[[ ! -e $release_directory ]] || fail "immutable release already exists: $release_directory"
[[ ! -e $partial_release ]] || fail "temporary release path already exists: $partial_release"

install -d -m 755 "$partial_release"
tar -xf "$archive_file" -C "$partial_release"
[[ ! -e $partial_release/.env.production && ! -e $partial_release/secrets ]] || fail 'archive unexpectedly contains production configuration'
[[ -x $partial_release/scripts/deploy-production.sh ]] || fail 'release has no executable deploy-production.sh'
[[ -f $partial_release/scripts/production-common.sh ]] || fail 'release has no production-common.sh'

ln -s -- "$production_root/shared/.env.production" "$partial_release/.env.production"
ln -s -- "$production_root/shared/secrets" "$partial_release/secrets"
mv -T -- "$partial_release" "$release_directory"
partial_release=''
rm -f -- "$archive_file"

PRODUCTION_ROOT="$production_root" \
DEPLOY_RELEASE_TAG="$release_tag" \
DEPLOY_LOCK_FD=9 \
  "$release_directory/scripts/deploy-production.sh" "$scope" "$release_directory/.env.production"

if [[ $scope == all ]]; then
  [[ -x $release_directory/scripts/install-production-edge.sh ]] || fail 'release has no executable install-production-edge.sh'
  PRODUCTION_ROOT="$production_root" DEPLOY_LOCK_FD=9 \
    "$release_directory/scripts/install-production-edge.sh"
fi
REMOTE_DEPLOY

  case $scope in
    all | admin) public_smoke "$release_tag" ;;
    backend) public_smoke ;;
  esac
}

show_status() {
  configure_connection
  require_local_command ssh

  run_ssh_script "$PRODUCTION_ROOT" <<'REMOTE_STATUS'
set -Eeuo pipefail
production_root=$1
current_link="$production_root/current"
state_file="$production_root/shared/release-state.env"

[[ -L $current_link ]] || { printf 'No active production release at %s\n' "$current_link" >&2; exit 1; }
[[ -f $state_file && ! -L $state_file ]] || { printf 'No valid release state at %s\n' "$state_file" >&2; exit 1; }

source "$current_link/scripts/production-common.sh"
production_load_state "$state_file" || production_die "release state does not exist: $state_file"
production_export_state

cd "$current_link"
printf 'Current release: %s\n' "$(pwd -P)"
printf 'Component state:\n'
sed 's/^/  /' "$state_file"
printf 'Retained immutable releases:\n'
for retained_release in "$production_root/releases"/*; do
  [[ -d $retained_release && ! -L $retained_release ]] || continue
  retained_name=${retained_release##*/}
  [[ $retained_name =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}$ ]] || continue
  printf '  %s\n' "$retained_name"
done
docker compose --project-directory "$current_link" --env-file "$current_link/.env.production" -f "$current_link/compose.prod.yaml" ps
REMOTE_STATUS
}

show_logs() {
  local service=${1:-}
  local tail_lines=${PRODUCTION_LOG_TAIL:-200}

  case $service in
    '' | postgres | mongo | redis | migrate | api | worker | web | nginx) ;;
    *) die "unknown log service: $service" 2 ;;
  esac
  [[ $tail_lines =~ ^[1-9][0-9]*$ ]] || die "PRODUCTION_LOG_TAIL must be a positive integer"

  configure_connection
  require_local_command ssh

  run_ssh_script "$PRODUCTION_ROOT" "$service" "$tail_lines" <<'REMOTE_LOGS'
set -Eeuo pipefail
production_root=$1
service=$2
tail_lines=$3
current_link="$production_root/current"
state_file="$production_root/shared/release-state.env"

[[ -L $current_link && -f $state_file ]] || { printf 'Production is not initialized\n' >&2; exit 1; }
if [[ $service == nginx ]]; then
  exec journalctl -u nginx -n "$tail_lines" --no-pager
fi

source "$current_link/scripts/production-common.sh"
production_load_state "$state_file" || production_die "release state does not exist: $state_file"
production_export_state

compose=(docker compose --project-directory "$current_link" --env-file "$current_link/.env.production" -f "$current_link/compose.prod.yaml")
if [[ -n $service ]]; then
  exec "${compose[@]}" logs --tail "$tail_lines" "$service"
fi
exec "${compose[@]}" logs --tail "$tail_lines"
REMOTE_LOGS
}

rollback_release() {
  local scope=$1
  local release_tag=$2
  local canonical_release

  validate_scope "$scope"
  validate_full_sha "$release_tag"
  require_local_command git
  canonical_release=$(git -C "$repository_root" rev-parse --verify "$release_tag^{commit}" 2>/dev/null) || \
    die "rollback SHA is not a commit in this local repository: $release_tag"
  [[ $canonical_release == "$release_tag" ]] || die "rollback requires the full canonical Git SHA"

  configure_connection
  require_local_command curl
  require_local_command ssh

  run_ssh_script "$PRODUCTION_ROOT" "$scope" "$release_tag" <<'REMOTE_ROLLBACK'
set -Eeuo pipefail
production_root=$1
scope=$2
release_tag=$3
lock_file=/var/lock/join-the-six-production.lock
current_link="$production_root/current"

[[ $production_root =~ ^/[A-Za-z0-9._/-]+$ && $production_root != / ]] || { printf 'Unsafe production root\n' >&2; exit 1; }
[[ $release_tag =~ ^[0-9a-f]{40}$ ]] || { printf 'Invalid release SHA\n' >&2; exit 2; }
case $scope in all | admin | backend) ;; *) printf 'Invalid rollback scope\n' >&2; exit 2 ;; esac
[[ -L $current_link ]] || { printf 'Production has no current release\n' >&2; exit 1; }

exec 9>"$lock_file"
flock --nonblock 9 || { printf 'Another production operation holds %s\n' "$lock_file" >&2; exit 1; }

PRODUCTION_ROOT="$production_root" DEPLOY_LOCK_FD=9 \
  "$current_link/scripts/rollback-production.sh" "$scope" "$release_tag" "$current_link/.env.production"
REMOTE_ROLLBACK

  case $scope in
    all | admin) public_smoke "$release_tag" ;;
    backend) public_smoke ;;
  esac
}

install_edge() {
  local expected_web_release

  configure_connection
  require_local_command curl
  require_local_command ssh

  run_ssh_script "$PRODUCTION_ROOT" <<'REMOTE_EDGE'
set -Eeuo pipefail
production_root=$1
lock_file=/var/lock/join-the-six-production.lock
current_link="$production_root/current"

[[ -L $current_link ]] || { printf 'Production has no current release\n' >&2; exit 1; }
[[ -x $current_link/scripts/install-production-edge.sh ]] || { printf 'Current release has no edge installer\n' >&2; exit 1; }

exec 9>"$lock_file"
flock --nonblock 9 || { printf 'Another production operation holds %s\n' "$lock_file" >&2; exit 1; }
PRODUCTION_ROOT="$production_root" DEPLOY_LOCK_FD=9 "$current_link/scripts/install-production-edge.sh"
REMOTE_EDGE

  expected_web_release=$(run_ssh_script "$PRODUCTION_ROOT" <<'REMOTE_WEB_RELEASE'
set -Eeuo pipefail
production_root=$1
current_link="$production_root/current"
state_file="$production_root/shared/release-state.env"
[[ -L $current_link && -f $state_file && ! -L $state_file ]] || exit 1
source "$current_link/scripts/production-common.sh"
production_load_state "$state_file"
production_validate_full_sha "$WEB_RELEASE_TAG"
printf '%s\n' "$WEB_RELEASE_TAG"
REMOTE_WEB_RELEASE
)
  validate_full_sha "$expected_web_release"
  public_smoke "$expected_web_release"
}

dispatch_data() {
  local action=$1
  local data_script="$repository_root/scripts/production-data.sh"

  case $action in push | status | seal) ;; *) die "data action must be one of: push, status, seal" 2 ;; esac
  [[ -f $data_script ]] || die "data workflow is not installed: $data_script"
  configure_connection
  exec bash "$data_script" "$action"
}

command_name=${1:-help}
case $command_name in
  help | -h | --help)
    (( $# == 1 || $# == 0 )) || die "help takes no arguments" 2
    usage
    ;;
  deploy)
    (( $# <= 2 )) || die "usage: scripts/prod.sh deploy [all|admin|backend]" 2
    deploy_release "${2:-all}"
    ;;
  status)
    (( $# == 1 )) || die "usage: scripts/prod.sh status" 2
    show_status
    ;;
  logs)
    (( $# <= 2 )) || die "usage: scripts/prod.sh logs [service]" 2
    show_logs "${2:-}"
    ;;
  rollback)
    (( $# == 3 )) || die "usage: scripts/prod.sh rollback <all|admin|backend> <full-git-sha>" 2
    rollback_release "$2" "$3"
    ;;
  edge)
    (( $# == 1 )) || die "usage: scripts/prod.sh edge" 2
    install_edge
    ;;
  data)
    (( $# == 2 )) || die "usage: scripts/prod.sh data <push|status|seal>" 2
    dispatch_data "$2"
    ;;
  bootstrap-data)
    die "bootstrap-data is intentionally unavailable; use the guarded logical workflow: scripts/prod.sh data <push|status|seal>" 2
    ;;
  *)
    usage >&2
    die "unknown command: $command_name" 2
    ;;
esac
