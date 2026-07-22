import { Injectable } from "@nestjs/common";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import type {
  CreateReferenceRecordInput,
  ReferenceRecordView,
} from "./reference.schemas.js";
import { ReferenceRepository } from "./reference.repository.js";

export interface RequestActor {
  readonly actorType: string;
  readonly actorId?: string;
  readonly requestId?: string;
}

export class ReferenceRecordNotFoundError extends Error {
  constructor(id: string) {
    super(`Reference record ${id} was not found`);
    this.name = ReferenceRecordNotFoundError.name;
  }
}

@Injectable()
export class ReferenceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ReferenceRepository,
    private readonly audit: AuditRepository,
  ) {}

  async create(
    input: CreateReferenceRecordInput,
    actor: RequestActor,
  ): Promise<ReferenceRecordView> {
    const record = await this.database.transaction(async (transaction) => {
      const created = await this.repository.create(transaction, input.label);

      await this.audit.append(transaction, {
        actorType: actor.actorType,
        ...(actor.actorId ? { actorId: actor.actorId } : {}),
        action: "reference_record.created",
        entityType: "reference_record",
        entityId: created.id,
        ...(actor.requestId ? { requestId: actor.requestId } : {}),
        context: {},
      });

      return created;
    });

    return this.toView(record);
  }

  async get(id: string): Promise<ReferenceRecordView> {
    const record = await this.repository.findById(id);

    if (!record) {
      throw new ReferenceRecordNotFoundError(id);
    }

    return this.toView(record);
  }

  private toView(record: {
    id: string;
    label: string;
    createdAt: Date;
  }): ReferenceRecordView {
    return {
      id: record.id,
      label: record.label,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
