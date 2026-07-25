import { QueryClient } from "@tanstack/react-query";

/**
 * The single TanStack Query cache for the admin SPA.
 *
 * Retries stay off in both directions: the shared `ofetch` client sets
 * `retry: 0` so a mutation never double-fires, and a query retry loop would
 * hide a real backend failure behind three silent attempts. Screens decide when
 * to refetch; they own their own loading, empty and error states.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: {
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 30_000,
      },
    },
  });
}
