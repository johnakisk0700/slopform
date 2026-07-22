import { validatePublicEnvironment } from "../../environment.public";

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const publicEnvironment = validatePublicEnvironment(config.public);
  const forwardedHeaders = import.meta.server
    ? useRequestHeaders(["cookie", "x-request-id"])
    : undefined;

  const api = $fetch.create({
    baseURL: import.meta.server
      ? config.apiBaseInternal
      : publicEnvironment.apiBase,
    credentials: "include",
    ...(forwardedHeaders ? { headers: forwardedHeaders } : {}),
    retry: 0,
    timeout: 15_000,
  });

  return {
    provide: {
      api,
    },
  };
});
