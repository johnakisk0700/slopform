import { Injectable } from "@nestjs/common";
import {
  auditEvents,
  type AuditEventInsert,
  type DatabaseExecutor,
} from "@join-the-six/database";

@Injectable()
export class AuditRepository {
  async append(
    executor: DatabaseExecutor,
    event: AuditEventInsert,
  ): Promise<void> {
    await executor.insert(auditEvents).values(event);
  }
}
