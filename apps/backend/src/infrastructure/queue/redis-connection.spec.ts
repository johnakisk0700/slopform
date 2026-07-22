import { describe, expect, it } from "vitest";

import { redisConnectionFromUrl } from "./redis-connection.js";

describe("redisConnectionFromUrl", () => {
  it("maps an authenticated TLS URL to BullMQ connection options", () => {
    expect(
      redisConnectionFromUrl("rediss://worker:secret@redis.example.com:6380/2"),
    ).toEqual({
      host: "redis.example.com",
      port: 6380,
      db: 2,
      username: "worker",
      password: "secret",
      tls: { servername: "redis.example.com" },
    });
  });

  it("rejects a non-numeric database path", () => {
    expect(() =>
      redisConnectionFromUrl("redis://localhost/not-a-number"),
    ).toThrow(/non-negative integer/);
  });
});
