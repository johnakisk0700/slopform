import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createDatabase,
  type AppDatabase,
  type AppTransaction,
  type DatabaseClient,
} from "@join-the-six/database";

import type { Environment } from "../config/environment.js";

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private client: DatabaseClient | undefined;

  constructor(private readonly config: ConfigService<Environment, true>) {}

  onModuleInit(): void {
    this.client = createDatabase({
      applicationName: this.config.get("OTEL_SERVICE_NAME", { infer: true }),
      connectionString: this.config.get("DATABASE_URL", { infer: true }),
      maxConnections: this.config.get("DATABASE_POOL_MAX", { infer: true }),
    });
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

    await this.client.pool.query("select 1");
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.pool.end();
  }
}
