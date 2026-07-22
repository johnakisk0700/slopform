import { validateWebRuntimeConfig } from "../../environment.server.js";

export default defineNitroPlugin(() => {
  validateWebRuntimeConfig(useRuntimeConfig());
});
