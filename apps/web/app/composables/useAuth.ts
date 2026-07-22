export interface AuthUser {
  id: string;
  displayName: string;
  roles: string[];
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: string;
}

export function useAuth() {
  const session = useState<AuthSession | null | undefined>(
    "auth-session",
    () => undefined,
  );
  const loading = useState("auth-session-loading", () => false);
  const api = useApi();

  async function refresh(): Promise<AuthSession | null> {
    loading.value = true;

    try {
      session.value = await api<AuthSession>("/auth/session");
      return session.value;
    } catch {
      session.value = null;
      return null;
    } finally {
      loading.value = false;
    }
  }

  async function signOut(): Promise<void> {
    await api("/auth/logout", { method: "POST" });
    session.value = null;
    await navigateTo("/");
  }

  return {
    isAuthenticated: computed(() => session.value != null),
    loading: readonly(loading),
    refresh,
    session: readonly(session),
    signOut,
  };
}
