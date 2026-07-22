import { CanActivate, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Environment } from "../../infrastructure/config/environment.js";

@Injectable()
export class ReferenceGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  canActivate(): true {
    if (!this.config.get("REFERENCE_MODULE_ENABLED", { infer: true })) {
      throw new NotFoundException();
    }

    return true;
  }
}
