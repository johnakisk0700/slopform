#!/usr/bin/env bash
set -Eeuo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$repository_root/scripts/production-common.sh"
source_file="$repository_root/deploy/nginx/slopform.example.com.conf"
site_available=/etc/nginx/sites-available/slopform.example.com
site_enabled=/etc/nginx/sites-enabled/slopform.example.com
backup_directory=/var/backups/join-the-six/nginx
deployment_lock=/var/lock/join-the-six-production.lock
production_root=${PRODUCTION_ROOT:-/opt/slopform}
state_file="$production_root/shared/release-state.env"

for required_command in curl flock install nginx readlink systemctl; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command not found: $required_command" >&2
    exit 1
  fi
done

if [[ $EUID -ne 0 ]]; then
  echo "The production edge installer must run as root" >&2
  exit 1
fi

if [[ ! -f $source_file ]]; then
  echo "Nginx site source not found: $source_file" >&2
  exit 1
fi

for certificate_file in \
  /etc/letsencrypt/live/slopform.example.com/fullchain.pem \
  /etc/letsencrypt/live/slopform.example.com/privkey.pem; do
  if [[ ! -r $certificate_file ]]; then
    echo "TLS certificate file is missing: $certificate_file" >&2
    exit 1
  fi
done

install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
install -d -m 0700 "$backup_directory" "$(dirname -- "$deployment_lock")"
if [[ -n ${DEPLOY_LOCK_FD:-} ]]; then
  if [[ ! $DEPLOY_LOCK_FD =~ ^[0-9]+$ || ! -e /proc/$$/fd/$DEPLOY_LOCK_FD ]]; then
    echo "DEPLOY_LOCK_FD does not name an inherited open descriptor" >&2
    exit 1
  fi
else
  exec 9>"$deployment_lock"

  if ! flock --nonblock 9; then
    echo "Another Slopform production operation holds $deployment_lock" >&2
    exit 1
  fi

  export DEPLOY_LOCK_FD=9
fi

production_validate_root "$production_root"
[[ -f $state_file && ! -L $state_file ]] || {
  echo "Production release state is missing or unsafe: $state_file" >&2
  exit 1
}
production_load_state "$state_file"
production_export_state

verify_endpoint() {
  local url=$1
  local resolve=${2:-}
  local attempt
  local -a curl_arguments=(--fail --show-error --silent --connect-timeout 3 --max-time 10)

  if [[ -n $resolve ]]; then
    curl_arguments+=(--resolve "$resolve")
  fi
  for ((attempt = 1; attempt <= 10; attempt += 1)); do
    if curl "${curl_arguments[@]}" "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Endpoint did not become ready: $url" >&2
  return 1
}

verify_web_release() {
  local url=$1
  local resolve=${2:-}
  local expected_payload="{\"release\":\"$WEB_RELEASE_TAG\"}"
  local actual_payload
  local attempt
  local -a curl_arguments=(--fail --show-error --silent --connect-timeout 3 --max-time 10)

  if [[ -n $resolve ]]; then
    curl_arguments+=(--resolve "$resolve")
  fi
  for ((attempt = 1; attempt <= 10; attempt += 1)); do
    actual_payload=$(curl "${curl_arguments[@]}" "$url" 2>/dev/null || true)
    if [[ $actual_payload == "$expected_payload" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Web endpoint did not serve expected release $WEB_RELEASE_TAG: $url" >&2
  return 1
}

verify_endpoint http://127.0.0.1:5201/api/v1/health/ready
verify_web_release http://127.0.0.1:5200/deploy.json

production_validate_nginx_site_paths "$site_available" "$site_enabled"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_file="$backup_directory/slopform.example.com.$timestamp.conf"
previous_link=$(readlink "$site_enabled" 2>/dev/null || true)
had_site=false
confirmed=false

if [[ -f $site_available ]]; then
  install -m 0600 "$site_available" "$backup_file"
  had_site=true
fi

rollback_edge() {
  if [[ $confirmed == true ]]; then
    return
  fi

  echo "Restoring the previous slopform.example.com nginx site" >&2
  if [[ $had_site == true ]]; then
    install -m 0644 "$backup_file" "$site_available"
  else
    rm -f -- "$site_available"
  fi

  if [[ -n $previous_link ]]; then
    ln -sfn -- "$previous_link" "$site_enabled"
  else
    rm -f -- "$site_enabled"
  fi

  if nginx -t; then
    systemctl reload nginx || true
  fi
}

trap rollback_edge EXIT

temporary_site=$(mktemp /etc/nginx/sites-available/.slopform.example.com.XXXXXX)
trap 'rm -f -- "$temporary_site"; rollback_edge' EXIT
install -m 0644 "$source_file" "$temporary_site"
mv -f -- "$temporary_site" "$site_available"
ln -sfn -- "$site_available" "$site_enabled"

nginx -t
systemctl reload nginx

verify_endpoint \
  https://slopform.example.com/api/v1/health/ready \
  slopform.example.com:443:127.0.0.1
verify_web_release \
  https://slopform.example.com/deploy.json \
  slopform.example.com:443:127.0.0.1

confirmed=true
trap - EXIT
echo "Installed and verified the slopform.example.com production edge"
