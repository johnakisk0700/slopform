#!/bin/sh
set -eu

read_secret() {
  secret_name=$1
  secret_path="/run/secrets/${secret_name}"

  if [ -r "$secret_path" ]; then
    cat "$secret_path"
  fi
}

if [ -r /run/secrets/postgres_password ]; then
  : "${POSTGRES_USER:?POSTGRES_USER is required with postgres_password}"
  : "${POSTGRES_DB:?POSTGRES_DB is required with postgres_password}"
  postgres_password=$(read_secret postgres_password)
  export DATABASE_URL="postgresql://${POSTGRES_USER}:${postgres_password}@postgres:5432/${POSTGRES_DB}"
fi

if [ -r /run/secrets/redis_password ]; then
  redis_password=$(read_secret redis_password)
  export REDIS_URL="redis://:${redis_password}@redis:6379"
fi

exec "$@"
