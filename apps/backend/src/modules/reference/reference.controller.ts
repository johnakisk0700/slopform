import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
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
import {
  ReferenceRecordNotFoundError,
  ReferenceService,
} from "./reference.service.js";

type RequestWithId = Request & { id: string };

/**
 * Golden module only. Replace it with the first real domain module rather than
 * expanding this route into a generic CRUD framework.
 */
@ApiTags("reference")
@Controller("_reference")
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
  @ZodResponse({ status: 200, type: ReferenceRecordDto })
  get(@Param() parameters: ReferenceIdDto): Promise<ReferenceRecordDto> {
    return mapReferenceErrors(this.references.get(parameters.id));
  }

  @Post("jobs")
  @ZodResponse({ status: 201, type: EnqueueReferenceJobResponseDto })
  enqueue(
    @Body() input: EnqueueReferenceJobDto,
    @Req() request: RequestWithId,
  ): Promise<EnqueueReferenceJobResponseDto> {
    return mapReferenceErrors(this.jobs.enqueue(input, request.id));
  }
}

async function mapReferenceErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof ReferenceRecordNotFoundError) {
      throw new NotFoundException(error.message, { cause: error });
    }

    throw error;
  }
}
