import { Injectable } from "@nestjs/common";
import {
  referenceRecords,
  type AppTransaction,
  type ReferenceRecordRow,
} from "@join-the-six/database";
import { eq } from "drizzle-orm";

import { DatabaseService } from "../../infrastructure/database/database.service.js";

@Injectable()
export class ReferenceRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(
    transaction: AppTransaction,
    label: string,
  ): Promise<ReferenceRecordRow> {
    const [record] = await transaction
      .insert(referenceRecords)
      .values({ label })
      .returning();

    if (!record) {
      throw new Error("Reference record insert returned no row");
    }

    return record;
  }

  async findById(id: string): Promise<ReferenceRecordRow | undefined> {
    const [record] = await this.database.db
      .select()
      .from(referenceRecords)
      .where(eq(referenceRecords.id, id))
      .limit(1);

    return record;
  }
}
