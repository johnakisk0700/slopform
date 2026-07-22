import type { ConnectionOptions } from "bullmq";

export function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const databasePath = url.pathname.slice(1);
  const database = databasePath ? Number(databasePath) : 0;

  if (!Number.isInteger(database) || database < 0) {
    throw new Error("REDIS_URL database path must be a non-negative integer");
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    db: database,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:"
      ? { tls: { servername: url.hostname } }
      : {}),
  };
}
