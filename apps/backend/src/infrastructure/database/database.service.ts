import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createDatabase,
  type AppDatabase,
  type AppTransaction,
  type DatabaseClient,
} from "@slopform/database";

import type { Environment } from "../config/environment.js";
import { withReadinessTimeout } from "../readiness.js";

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private client: DatabaseClient | undefined;
  private pendingPing: Promise<void> | undefined;

  private readonly handlePoolError = (error: Error): void => {
    this.logger.error({
      event: "database.pool.error",
      error: {
        name: error.name,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      },
    });
  };

  constructor(private readonly config: ConfigService<Environment, true>) {}

  onModuleInit(): void {
    this.client = createDatabase({
      applicationName: this.config.get("OTEL_SERVICE_NAME", { infer: true }),
      connectionString: this.config.get("DATABASE_URL", { infer: true }),
      maxConnections: this.config.get("DATABASE_POOL_MAX", { infer: true }),
    });
    this.client.pool.on("error", this.handlePoolError);
  }

  get db(): AppDatabase {
    if (!this.client) {
      throw new Error("DatabaseService used before module initialization");
    }

    return this.client.db;
  }

  async transaction<T>(
    work: (transaction: AppTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(work);
  }

  async ping(): Promise<void> {
    if (!this.client) {
      throw new Error("DatabaseService used before module initialization");
    }

    const ping = this.pendingPing ?? this.startPing(this.client);
    await withReadinessTimeout(ping, "Database");
  }

  async onApplicationShutdown(): Promise<void> {
    const client = this.client;
    this.client = undefined;

    if (!client) {
      return;
    }

    try {
      await client.pool.end();
    } finally {
      client.pool.off("error", this.handlePoolError);
    }
  }

  private startPing(client: DatabaseClient): Promise<void> {
    const ping = client.pool.query("select 1").then(() => undefined);

    this.pendingPing = ping.finally(() => {
      this.pendingPing = undefined;
    });

    return this.pendingPing;
  }
}
