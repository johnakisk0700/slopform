import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  type Collection,
  type Document,
  MongoClient,
  type MongoClientOptions,
} from "mongodb";

import type { Environment } from "../config/environment.js";
import { withReadinessTimeout } from "../readiness.js";

const MONGO_OPTIONS: MongoClientOptions = {
  connectTimeoutMS: 5_000,
  ignoreUndefined: true,
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5_000,
  socketTimeoutMS: 10_000,
  waitQueueTimeoutMS: 5_000,
};
const MONGO_READINESS_COMMAND_TIMEOUT_MS = 1_000;

@Injectable()
export class MongoService implements OnApplicationShutdown {
  private readonly logger = new Logger(MongoService.name);
  private readonly client: MongoClient;
  private connection: Promise<MongoClient> | undefined;
  private pendingPing: Promise<void> | undefined;
  private closed = false;

  constructor(config: ConfigService<Environment, true>) {
    this.client = new MongoClient(config.get("MONGODB_URI", { infer: true }), {
      ...MONGO_OPTIONS,
      appName: config.get("OTEL_SERVICE_NAME", { infer: true }),
    });
  }

  async collection<TSchema extends Document>(
    name: string,
  ): Promise<Collection<TSchema>> {
    const client = await this.connect();
    return client.db().collection<TSchema>(name);
  }

  async ping(): Promise<void> {
    await (this.pendingPing ?? this.startPing());
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connection = undefined;
    this.pendingPing = undefined;
    await this.client.close();
  }

  private connect(): Promise<MongoClient> {
    if (this.closed) {
      return Promise.reject(
        new Error("MongoService used after application shutdown"),
      );
    }
    if (!this.connection) {
      const connection = this.client.connect().catch((error: unknown) => {
        if (this.connection === connection) {
          this.connection = undefined;
        }
        this.logger.error({
          event: "mongodb.connect.failed",
          error: { name: errorName(error) },
        });
        throw error;
      });
      this.connection = connection;
    }
    return this.connection;
  }

  private startPing(): Promise<void> {
    const operation = this.connect()
      .then((client) =>
        client
          .db()
          .command(
            { ping: 1 },
            { timeoutMS: MONGO_READINESS_COMMAND_TIMEOUT_MS },
          ),
      )
      .then(() => undefined);
    const ping = withReadinessTimeout(operation, "MongoDB");

    this.pendingPing = ping.finally(() => {
      this.pendingPing = undefined;
    });

    return this.pendingPing;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
