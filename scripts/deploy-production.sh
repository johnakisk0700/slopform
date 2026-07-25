#!/usr/bin/env bash
set -Eeuo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
environment_file=${1:-.env.production}

if [[ $environment_file != /* ]]; then
  environment_file="$repository_root/$environment_file"
fi

for required_command in docker flock git; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command not found: $required_command" >&2
    exit 1
  fi
done

if [[ ! -f $environment_file ]]; then
  echo "Production environment file not found: $environment_file" >&2
  exit 1
fi

cd "$repository_root"

if [[ -n $(git status --porcelain --untracked-files=normal) ]]; then
  echo "Refusing to deploy a dirty worktree" >&2
  exit 1
fi

release_tag=$(git rev-parse --verify HEAD)
export RELEASE_TAG=$release_tag

git_common_directory=$(git rev-parse --git-common-dir)

if [[ $git_common_directory != /* ]]; then
  git_common_directory="$repository_root/$git_common_directory"
fi

default_lock="$git_common_directory/join-the-six-production-deploy.lock"
deployment_lock=${DEPLOY_LOCK_FILE:-$default_lock}
exec 9>"$deployment_lock"

if ! flock --nonblock 9; then
  echo "Another Join The Six deploy or rollback holds $deployment_lock" >&2
  exit 1
fi

compose=(docker compose --env-file "$environment_file" -f compose.prod.yaml)

"${compose[@]}" config --quiet
"${compose[@]}" build --pull
"${compose[@]}" up -d --no-build --wait --wait-timeout 900 postgres mongo redis
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --no-build --no-deps --wait --wait-timeout 900 api worker
"${compose[@]}" up -d --no-build --no-deps --wait --wait-timeout 900 web
"${compose[@]}" up -d --no-build --no-deps --remove-orphans --wait --wait-timeout 900 caddy
"${compose[@]}" ps

echo "Deployed release $release_tag"
