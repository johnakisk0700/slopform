import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodResponse } from "nestjs-zod";

import {
  CreateReferenceRecordDto,
  EnqueueReferenceJobDto,
  EnqueueReferenceJobResponseDto,
  ReferenceIdDto,
  ReferenceRecordDto,
} from "./reference.schemas.js";
import { ReferenceJobsService } from "./reference-jobs.service.js";
import { ReferenceGuard } from "./reference.guard.js";
import { ReferenceService } from "./reference.service.js";

type RequestWithId = Request & { id: string };

/**
 * Golden module only. Replace it with the first real domain module rather than
 * expanding this route into a generic CRUD framework.
 */
@ApiTags("reference")
@Controller("_reference")
@UseGuards(ReferenceGuard)
export class ReferenceController {
  constructor(
    private readonly references: ReferenceService,
    private readonly jobs: ReferenceJobsService,
  ) {}

  @Post()
  @ZodResponse({ status: 201, type: ReferenceRecordDto })
  create(
    @Body() input: CreateReferenceRecordDto,
    @Req() request: RequestWithId,
  ): Promise<ReferenceRecordDto> {
    return this.references.create(input, {
      actorType: "system",
      requestId: request.id,
    });
  }

  @Get(":id")
  @ZodResponse({ type: ReferenceRecordDto })
  get(@Param() parameters: ReferenceIdDto): Promise<ReferenceRecordDto> {
    return this.references.get(parameters.id);
  }

  @Post("jobs")
  @ZodResponse({ status: 201, type: EnqueueReferenceJobResponseDto })
  enqueue(
    @Body() input: EnqueueReferenceJobDto,
    @Req() request: RequestWithId,
  ): Promise<EnqueueReferenceJobResponseDto> {
    return this.jobs.enqueue(input, request.id);
  }
}
