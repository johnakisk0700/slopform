# Containers and VPS deployment

## Delivery model

The root `Dockerfile` produces four targets:

- `web`: standalone Nuxt/Nitro server
- `api`: Nest HTTP process
- `worker`: Nest BullMQ process
- `migrate`: one-shot Drizzle migration runner

PostgreSQL and Redis use official images. Caddy is the production edge: it routes `/api/*` unchanged to Nest and every other request to Nuxt. It obtains and renews TLS certificates when `DOMAIN` resolves to the VPS.

## Development

Native code with containerized dependencies is the fastest inner loop:

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm dev
```

To run the entire stack in containers with bind-mounted source and hot reload:

```bash
cp .env.example .env
pnpm dev:containers
```

Development exposes PostgreSQL and Redis only on loopback, plus web on `3000` and API on `4000`. If dependency manifests change, rebuild the development image and dependency volumes. Do not add `docker compose down -v` casually: it deletes the named development database too.

## Production configuration

On the VPS:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Replace every placeholder, set `DOMAIN`/`WEB_ORIGIN`, and URL-encode secrets embedded in `DATABASE_URL` or `REDIS_URL`. Keep `.env.production` out of Git and unencrypted backups.

Validate before touching running services:

```bash
docker compose --env-file .env.production -f compose.prod.yaml config --quiet
docker compose --env-file .env.production -f compose.prod.yaml build
```

Deploy with:

```bash
docker compose --env-file .env.production -f compose.prod.yaml up -d --build --remove-orphans
docker compose --env-file .env.production -f compose.prod.yaml ps
```

The API and worker wait for the one-shot migration container to succeed. A failed migration prevents the new application containers from starting; it must never be “fixed” by editing migration history on the server.

## Release and rollback

The current production Compose file builds from the checked-out commit. Tag every production commit and record the deployed SHA. A rollback means checking out the prior tag and rebuilding application images; database rollback requires an explicitly reviewed forward-fix or rollback migration. Container rollback is easy. Data rollback is where optimism goes to die.

Before production traffic, add an off-host encrypted PostgreSQL backup and a restore drill. Docker volumes are persistence, not backup.

## CI options

- Local: `pnpm check` validates code; Docker target builds validate packaging.
- GitHub-hosted: `.github/workflows/ci.yml` runs code checks and container builds without production credentials.
- VPS self-hosted runner: viable for deployment only on a protected environment/branch. Never run untrusted pull-request jobs on the production runner.

Automatic SSH deployment is intentionally absent until the VPS hostname, image strategy, protected environment and rollback policy are confirmed.
