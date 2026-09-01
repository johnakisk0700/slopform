import { Injectable } from "@nestjs/common";
import {
  auditEvents,
  type AuditEventInsert,
  type AppTransaction,
} from "@slopform/database";

@Injectable()
export class AuditRepository {
  async append(
    transaction: AppTransaction,
    event: AuditEventInsert,
  ): Promise<void> {
    await transaction.insert(auditEvents).values(event);
  }
}
