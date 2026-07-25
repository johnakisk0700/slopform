import {
  ClerkDegraded,
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
} from "@clerk/react";
import { Toast } from "@heroui/react";
import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { AuthStatusScreen } from "./components/admin/AuthStatusScreen";
import { AdminShell } from "./components/admin/AdminShell";
import { RequireAdmin } from "./components/admin/RequireAdmin";
import { env } from "./lib/env";
import { ErrorPage } from "./routes/ErrorPage";
import { SignInPage } from "./routes/SignInPage";

const AssistantPage = lazy(async () => {
  const module = await import("./routes/AssistantPage");
  return { default: module.AssistantPage };
});

const OverviewPage = lazy(async () => {
  const module = await import("./routes/OverviewPage");
  return { default: module.OverviewPage };
});

function LazyAdminRoute({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          aria-busy="true"
          className="grid min-h-40 place-content-center p-8 text-sm font-semibold text-ink-muted"
        >
          Loading page…
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

/**
 * The admin application root: the toast portal, the skip link (the first
 * focusable element on the page), and the route table. `/` redirects into the
 * `/admin` shell, which nests the routed views through its `<Outlet />`, and
 * any unknown path renders the standalone 404 screen.
 */
function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/sign-in/*"
        element={
          env.authDevBypass ? <Navigate to="/admin" replace /> : <SignInPage />
        }
      />
      <Route element={<RequireAdmin />}>
        <Route path="/" element={<Navigate to="/admin" replace />} />
        <Route path="/admin" element={<AdminShell />}>
          <Route
            index
            element={
              <LazyAdminRoute>
                <OverviewPage />
              </LazyAdminRoute>
            }
          />
          <Route
            path="assistant"
            element={
              <LazyAdminRoute>
                <AssistantPage />
              </LazyAdminRoute>
            }
          />
          <Route
            path="assistant/:threadId"
            element={
              <LazyAdminRoute>
                <AssistantPage />
              </LazyAdminRoute>
            }
          />
        </Route>
      </Route>
      <Route path="*" element={<ErrorPage />} />
    </Routes>
  );
}

function DevelopmentBypassApp() {
  return (
    <BrowserRouter>
      <p
        role="status"
        className="border-b border-warning-border bg-warning-soft px-4 py-2 text-center text-sm font-semibold text-warning"
      >
        Local development authentication bypass is active.
      </p>
      <AppRoutes />
    </BrowserRouter>
  );
}

export function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <Toast.Provider />
      {env.authDevBypass ? <DevelopmentBypassApp /> : <ClerkApplication />}
    </>
  );
}

function ClerkApplication() {
  return (
    <>
      <ClerkLoading>
        <AuthStatusScreen kind="checking" />
      </ClerkLoading>
      <ClerkLoaded>
        <BrowserRouter>
          <ClerkDegraded>
            <p
              role="status"
              className="border-b border-warning-border bg-warning-soft px-4 py-2 text-center text-sm font-semibold text-warning"
            >
              Authentication is running in degraded mode. Some account actions
              may be unavailable.
            </p>
          </ClerkDegraded>
          <AppRoutes />
        </BrowserRouter>
      </ClerkLoaded>
      <ClerkFailed>
        <AuthStatusScreen
          kind="failed"
          actionLabel="Reload"
          onAction={() => window.location.reload()}
        />
      </ClerkFailed>
    </>
  );
}
