import { Controller, Get, Header } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";

import { CurrentUserId } from "../../infrastructure/auth/current-user-id.decorator.js";
import { PrincipalDto } from "../../infrastructure/auth/auth.schemas.js";
import { OverviewDto } from "./overview.schemas.js";
import { OverviewService } from "./overview.service.js";

@ApiTags("overview")
@Controller("overview")
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  @ApiOperation({ operationId: "getOverview" })
  @Header("Cache-Control", "no-store")
  @ZodResponse({ status: 200, type: OverviewDto })
  get(@CurrentUserId() _userId: PrincipalDto): Promise<OverviewDto> {
    return this.overview.get();
  }
}
