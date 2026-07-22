import type { RedisOptions } from "bullmq";
import { isIP } from "node:net";

export function redisConnectionFromUrl(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);

  if (!["redis:", "rediss:"].includes(url.protocol)) {
    throw new Error("REDIS_URL must use the redis: or rediss: protocol");
  }

  if (!url.hostname) {
    throw new Error("REDIS_URL must include a hostname");
  }

  if (url.search || url.hash) {
    throw new Error(
      "REDIS_URL must not include query parameters or a fragment",
    );
  }

  const databasePath = url.pathname.slice(1);
  const database = databasePath ? Number(databasePath) : 0;
  const port = url.port ? Number(url.port) : 6379;

  if (!Number.isInteger(database) || database < 0) {
    throw new Error("REDIS_URL database path must be a non-negative integer");
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("REDIS_URL port must be an integer between 1 and 65535");
  }

  return {
    host: url.hostname,
    port,
    db: database,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:"
      ? {
          tls: isIP(url.hostname) ? {} : { servername: url.hostname },
        }
      : {}),
  };
}

export function redisProducerConnectionFromUrl(redisUrl: string): RedisOptions {
  return {
    ...redisConnectionFromUrl(redisUrl),
    maxRetriesPerRequest: 1,
  };
}

export function redisWorkerConnectionFromUrl(redisUrl: string): RedisOptions {
  return {
    ...redisConnectionFromUrl(redisUrl),
    maxRetriesPerRequest: null,
  };
}
