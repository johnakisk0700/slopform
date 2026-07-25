import {
  Body,
  ConflictException,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodResponse } from "nestjs-zod";

import { CurrentUserId } from "../../infrastructure/auth/current-user-id.decorator.js";
import {
  CreateEmailDeliveryDto,
  EmailCorrelationIdDto,
  EmailDeliveryDto,
  EmailDeliveryIdDto,
  EmailDeliveryListDto,
  EmailPrincipalDto,
} from "./email.schemas.js";
import {
  EmailDeliveryConflictError,
  EmailDeliveryNotFoundError,
  EmailService,
} from "./email.service.js";

type RequestWithId = Request & { id: string };
const RequestCorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<RequestWithId>().id,
);

@ApiTags("email-deliveries")
@Controller("email-deliveries")
export class EmailController {
  constructor(private readonly email: EmailService) {}

  @Post()
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 201, type: EmailDeliveryDto })
  create(
    @Body() input: CreateEmailDeliveryDto,
    @CurrentUserId() userId: EmailPrincipalDto,
    @RequestCorrelationId() correlationId: EmailCorrelationIdDto,
  ): Promise<EmailDeliveryDto> {
    return mapEmailErrors(
      this.email.create(input, String(userId), String(correlationId)),
    );
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: EmailDeliveryListDto })
  list(
    @CurrentUserId() userId: EmailPrincipalDto,
  ): Promise<EmailDeliveryListDto> {
    return this.email.list(String(userId));
  }

  @Get(":id")
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: EmailDeliveryDto })
  get(
    @Param() parameters: EmailDeliveryIdDto,
    @CurrentUserId() userId: EmailPrincipalDto,
  ): Promise<EmailDeliveryDto> {
    return mapEmailErrors(this.email.get(parameters.id, String(userId)));
  }
}

async function mapEmailErrors<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof EmailDeliveryNotFoundError) {
      throw new NotFoundException(error.message, { cause: error });
    }
    if (error instanceof EmailDeliveryConflictError) {
      throw new ConflictException(error.message, { cause: error });
    }
    throw error;
  }
}
