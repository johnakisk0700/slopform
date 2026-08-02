#!/usr/bin/env bash
set -Eeuo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source_file="$repository_root/deploy/nginx/example.com.conf"
site_available=/etc/nginx/sites-available/example.com
site_enabled=/etc/nginx/sites-enabled/example.com
backup_directory=/var/backups/join-the-six/nginx
deployment_lock=${DEPLOY_LOCK_FILE:-/var/lock/join-the-six-production.lock}

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
  /etc/letsencrypt/live/example.com/fullchain.pem \
  /etc/letsencrypt/live/example.com/privkey.pem; do
  if [[ ! -r $certificate_file ]]; then
    echo "TLS certificate file is missing: $certificate_file" >&2
    exit 1
  fi
done

curl --fail --show-error --silent http://127.0.0.1:5201/api/v1/health/ready >/dev/null
curl --fail --show-error --silent http://127.0.0.1:5200/deploy.json >/dev/null

install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
install -d -m 0700 "$backup_directory" "$(dirname -- "$deployment_lock")"
exec 9>"$deployment_lock"

if ! flock --nonblock 9; then
  echo "Another Join The Six production operation holds $deployment_lock" >&2
  exit 1
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_file="$backup_directory/example.com.$timestamp.conf"
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

  echo "Restoring the previous example.com nginx site" >&2
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

temporary_site=$(mktemp /etc/nginx/sites-available/.example.com.XXXXXX)
trap 'rm -f -- "$temporary_site"; rollback_edge' EXIT
install -m 0644 "$source_file" "$temporary_site"
mv -f -- "$temporary_site" "$site_available"
ln -sfn -- "$site_available" "$site_enabled"

nginx -t
systemctl reload nginx

curl --fail --show-error --silent \
  --resolve example.com:443:127.0.0.1 \
  https://example.com/api/v1/health/ready >/dev/null
curl --fail --show-error --silent \
  --resolve example.com:443:127.0.0.1 \
  https://example.com/deploy.json >/dev/null

confirmed=true
trap - EXIT
echo "Installed and verified the example.com production edge"
