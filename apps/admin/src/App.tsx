import {
  ClerkDegraded,
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
} from "@clerk/react";
import { Toast } from "@heroui/react";
import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router";

import { AuthPendingScreen } from "./components/admin/AuthPendingScreen";
import { AuthStatusScreen } from "./components/admin/AuthStatusScreen";
import { AdminShell } from "./components/admin/AdminShell";
import { RequireAdmin } from "./components/admin/RequireAdmin";
import {
  SignInFormPlaceholder,
  SignInLayout,
} from "./components/admin/SignInLayout";
import { env } from "./lib/env";
import { ErrorPage } from "./routes/ErrorPage/ErrorPage";
import { SignInPage } from "./routes/SignInPage/SignInPage";

const AssistantPage = lazy(async () => {
  const module = await import("./routes/AssistantPage/AssistantPage");
  return { default: module.AssistantPage };
});

const OverviewPage = lazy(async () => {
  const module = await import("./routes/OverviewPage/OverviewPage");
  return { default: module.OverviewPage };
});

const EventsPage = lazy(async () => {
  const module = await import("./routes/EventsPage/EventsPage");
  return { default: module.EventsPage };
});

const EventDetailPage = lazy(async () => {
  const module = await import("./routes/EventDetailPage/EventDetailPage");
  return { default: module.EventDetailPage };
});

const ParticipantsPage = lazy(async () => {
  const module = await import("./routes/ParticipantsPage/ParticipantsPage");
  return { default: module.ParticipantsPage };
});

const ParticipantProfilePage = lazy(async () => {
  const module =
    await import("./routes/ParticipantProfilePage/ParticipantProfilePage");
  return { default: module.ParticipantProfilePage };
});

const FeedbackCampaignsPage = lazy(async () => {
  const module =
    await import("./routes/FeedbackCampaignsPage/FeedbackCampaignsPage");
  return { default: module.FeedbackCampaignsPage };
});

const FeedbackInboxPage = lazy(async () => {
  const module = await import("./routes/FeedbackInboxPage/FeedbackInboxPage");
  return { default: module.FeedbackInboxPage };
});

const FeedbackResultsPage = lazy(async () => {
  const module =
    await import("./routes/FeedbackResultsPage/FeedbackResultsPage");
  return { default: module.FeedbackResultsPage };
});

const FeedbackOutboxPage = lazy(async () => {
  const module = await import("./routes/FeedbackOutboxPage/FeedbackOutboxPage");
  return { default: module.FeedbackOutboxPage };
});

// Vite removes this import and route from production builds.
const CookbookPage = import.meta.env.DEV
  ? lazy(async () => {
      const module = await import("./routes/CookbookPage/CookbookPage");
      return { default: module.CookbookPage };
    })
  : null;

function AdminPageOutlet() {
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
      <Outlet />
    </Suspense>
  );
}

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
          <Route element={<AdminPageOutlet />}>
            <Route index element={<OverviewPage />} />
            <Route path="assistant/:threadId?" element={<AssistantPage />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="events/:eventId" element={<EventDetailPage />} />
            <Route path="participants" element={<ParticipantsPage />} />
            <Route
              path="participants/:id"
              element={<ParticipantProfilePage />}
            />
            <Route path="feedback" element={<FeedbackCampaignsPage />} />
            <Route
              path="feedback/:campaignId"
              element={<FeedbackInboxPage />}
            />
            <Route
              path="feedback/:campaignId/results"
              element={<FeedbackResultsPage />}
            />
            {/* Separate from feedback so only one navigation item is current. */}
            <Route path="outbound" element={<FeedbackOutboxPage />} />
            {CookbookPage ? (
              <Route path="cookbook" element={<CookbookPage />} />
            ) : null}
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<ErrorPage />} />
    </Routes>
  );
}

export function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <Toast.Provider />
      {env.authDevBypass ? (
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      ) : (
        <ClerkApplication />
      )}
    </>
  );
}

/**
 * `/sign-in` and its Clerk sub-steps (`/sign-in/factor-one`, …). Read from the
 * location directly because this decision is made before the router mounts, and
 * only to pick which screen waits for Clerk — nothing here navigates.
 */
function isSignInPath(pathname: string): boolean {
  return pathname === "/sign-in" || pathname.startsWith("/sign-in/");
}

function ClerkApplication() {
  return (
    <>
      {/* Clerk's script is still in flight. Paint the screen the URL already
          promises — the sign-in page with a placeholder where the form will
          land — instead of an interstitial the operator then has to leave. */}
      <ClerkLoading>
        {isSignInPath(window.location.pathname) ? (
          <SignInLayout>
            <SignInFormPlaceholder />
          </SignInLayout>
        ) : (
          <AuthPendingScreen />
        )}
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
