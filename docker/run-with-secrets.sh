#!/bin/sh
set -eu

read_secret() {
  secret_name=$1
  secret_path="/run/secrets/${secret_name}"

  if [ -r "$secret_path" ]; then
    cat "$secret_path"
  fi
}

export_secret() {
  environment_name=$1
  secret_name=$2
  secret_value=$(read_secret "$secret_name")
  export "${environment_name}=${secret_value}"
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

if [ -r /run/secrets/mongodb_app_password ]; then
  : "${MONGODB_APP_USER:?MONGODB_APP_USER is required with mongodb_app_password}"
  : "${MONGODB_DB:?MONGODB_DB is required with mongodb_app_password}"
  mongodb_app_password=$(read_secret mongodb_app_password)

  case "$MONGODB_APP_USER" in
    *[!A-Za-z0-9._-]*)
      echo "MongoDB application user must be URL-safe" >&2
      exit 1
      ;;
  esac
  case "$MONGODB_DB" in
    *[!A-Za-z0-9_-]*)
      echo "MongoDB database name must be URL-safe" >&2
      exit 1
      ;;
  esac
  if [ "${#MONGODB_APP_USER}" -gt 64 ]; then
    echo "MongoDB application user must contain at most 64 characters" >&2
    exit 1
  fi
  if [ "${#MONGODB_DB}" -gt 63 ]; then
    echo "MongoDB database name must contain at most 63 characters" >&2
    exit 1
  fi
  case "$mongodb_app_password" in
    *[!A-Za-z0-9._~-]*)
      echo "MongoDB application password must be URL-safe" >&2
      exit 1
      ;;
  esac
  if [ "${#mongodb_app_password}" -lt 16 ] || [ "${#mongodb_app_password}" -gt 128 ]; then
    echo "MongoDB application password must contain 16 to 128 characters" >&2
    exit 1
  fi

  export MONGODB_URI="mongodb://${MONGODB_APP_USER}:${mongodb_app_password}@mongo:27017/${MONGODB_DB}?authSource=${MONGODB_DB}&retryWrites=false"
fi

if [ -r /run/secrets/bull_board_password ]; then
  export_secret BULL_BOARD_PASSWORD bull_board_password
fi

if [ -r /run/secrets/clerk_secret_key ]; then
  export_secret CLERK_SECRET_KEY clerk_secret_key
fi

if [ -r /run/secrets/openai_api_key ]; then
  export_secret OPENAI_API_KEY openai_api_key
fi

if [ -r /run/secrets/openrouter_api_key ]; then
  export_secret OPENROUTER_API_KEY openrouter_api_key
fi

if [ -r /run/secrets/wasender_webhook_secret ]; then
  export_secret WASENDER_WEBHOOK_SECRET wasender_webhook_secret
fi

if [ -r /run/secrets/wasender_session_api_key ]; then
  export_secret WASENDER_SESSION_API_KEY wasender_session_api_key
fi

exec "$@"
