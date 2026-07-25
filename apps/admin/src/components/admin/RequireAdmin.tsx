import { useEffect, useState } from "react";
import { useAuth, useClerk } from "@clerk/react";
import { Navigate, Outlet, useLocation } from "react-router";

import { authSessionSchema } from "../../features/auth/schema";
import { api } from "../../lib/api";
import { env } from "../../lib/env";
import { AuthStatusScreen } from "./AuthStatusScreen";

type AuthorizationStatus = "checking" | "authorized" | "denied" | "failed";

interface AuthorizationState {
  readonly status: AuthorizationStatus;
  readonly userId: string | null;
}

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
  const [attempt, setAttempt] = useState(0);
  const [authorization, setAuthorization] = useState<AuthorizationState>({
    status: "checking",
    userId: null,
  });

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      return;
    }

    const abortController = new AbortController();

    void api<unknown>("/v1/auth/session", {
      signal: abortController.signal,
    })
      .then((response) => {
        authSessionSchema.parse(response);
        setAuthorization({ status: "authorized", userId });
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }

        const status = responseStatus(error);
        setAuthorization({
          status: status === 401 || status === 403 ? "denied" : "failed",
          userId,
        });
      });

    return () => abortController.abort();
  }, [attempt, isLoaded, isSignedIn, userId]);

  if (!isLoaded) {
    return <AuthStatusScreen kind="checking" />;
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

  const authorizationStatus =
    authorization.userId === userId ? authorization.status : "checking";

  if (authorizationStatus === "authorized") {
    return <Outlet />;
  }

  if (authorizationStatus === "denied") {
    return (
      <AuthStatusScreen
        kind="denied"
        actionLabel="Sign out"
        onAction={() => void signOut({ redirectUrl: "/sign-in" })}
      />
    );
  }

  if (authorizationStatus === "failed") {
    return (
      <AuthStatusScreen
        kind="failed"
        actionLabel="Retry"
        onAction={() => {
          setAuthorization({ status: "checking", userId });
          setAttempt((value) => value + 1);
        }}
      />
    );
  }

  return <AuthStatusScreen kind="checking" />;
}
