import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";

import { AuthSessionDto } from "./auth.schemas.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  @Get("session")
  @ApiOperation({ operationId: "getAuthSession" })
  @ZodResponse({ status: 200, type: AuthSessionDto })
  session(): AuthSessionDto {
    return { status: "authorized" };
  }
}
