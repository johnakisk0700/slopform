import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";

import { AuthConfigService } from "./auth-config.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";

@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [AuthConfigService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthConfigService],
})
export class AuthModule {}
