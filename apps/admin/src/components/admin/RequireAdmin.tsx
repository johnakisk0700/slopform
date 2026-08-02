import { useAuth, useClerk } from "@clerk/react";
import { Navigate, Outlet, useLocation } from "react-router";

import {
  getGetAuthSessionQueryKey,
  useGetAuthSession,
} from "../../api/generated/auth";
import { env } from "../../lib/env";
import { AuthPendingScreen } from "./AuthPendingScreen";
import { AuthStatusScreen } from "./AuthStatusScreen";

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return undefined;
  }

  const { response } = error;
  return response instanceof Response ? response.status : undefined;
}

/**
 * Gates private routes twice: Clerk establishes a session, then the backend
 * confirms that the verified subject is in its admin allowlist.
 */
export function RequireAdmin() {
  return env.authDevBypass ? <Outlet /> : <ClerkRequireAdmin />;
}

function ClerkRequireAdmin() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { signOut } = useClerk();
  const location = useLocation();
  const session = useGetAuthSession({
    query: {
      enabled: isLoaded && isSignedIn,
      // The answer belongs to one Clerk subject; a different one re-checks.
      queryKey: [...getGetAuthSessionQueryKey(), userId],
      staleTime: Infinity,
    },
  });

  if (!isLoaded) {
    return <AuthPendingScreen />;
  }

  if (!isSignedIn) {
    return (
      <Navigate
        to="/sign-in"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  if (session.isSuccess) {
    return <Outlet />;
  }

  if (session.isError) {
    const status = responseStatus(session.error);

    return status === 401 || status === 403 ? (
      <AuthStatusScreen
        kind="denied"
        actionLabel="Sign out"
        onAction={() => void signOut({ redirectUrl: "/sign-in" })}
      />
    ) : (
      <AuthStatusScreen
        kind="failed"
        actionLabel="Retry"
        onAction={() => void session.refetch()}
      />
    );
  }

  return <AuthPendingScreen />;
}
