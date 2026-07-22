import { describe, expect, it } from "vitest";

import {
  redisConnectionFromUrl,
  redisProducerConnectionFromUrl,
  redisWorkerConnectionFromUrl,
} from "./redis-connection.js";

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

  it.each([
    "https://localhost:6379/0",
    "redis://localhost:6379/0?tls=true",
    "redis://localhost:6379/0#fragment",
    "redis://localhost:0/0",
  ])("rejects unsupported or ambiguous URLs: %s", (redisUrl) => {
    expect(() => redisConnectionFromUrl(redisUrl)).toThrow();
  });

  it("does not send an IP address as the TLS server name", () => {
    expect(redisConnectionFromUrl("rediss://127.0.0.1:6380/0")).toMatchObject({
      tls: {},
    });
  });

  it("uses fail-fast command behavior for HTTP producers", () => {
    expect(
      redisProducerConnectionFromUrl("redis://localhost:6379/0"),
    ).toMatchObject({
      maxRetriesPerRequest: 1,
    });
  });

  it("keeps worker commands retrying through Redis interruptions", () => {
    expect(
      redisWorkerConnectionFromUrl("redis://localhost:6379/0"),
    ).toMatchObject({
      maxRetriesPerRequest: null,
    });
  });
});
