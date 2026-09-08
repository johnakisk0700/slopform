import { config } from "dotenv";

// Worker decorators read environment settings before Nest creates ConfigService.
if (process.env.NODE_ENV !== "production") {
  config({ quiet: true });
}
