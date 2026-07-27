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

const EventsPage = lazy(async () => {
  const module = await import("./routes/EventsPage");
  return { default: module.EventsPage };
});

const EventDetailPage = lazy(async () => {
  const module = await import("./routes/EventDetailPage");
  return { default: module.EventDetailPage };
});

const ParticipantsPage = lazy(async () => {
  const module = await import("./routes/ParticipantsPage");
  return { default: module.ParticipantsPage };
});

const ParticipantProfilePage = lazy(async () => {
  const module = await import("./routes/ParticipantProfilePage");
  return { default: module.ParticipantProfilePage };
});

const FeedbackCampaignsPage = lazy(async () => {
  const module = await import("./routes/FeedbackCampaignsPage");
  return { default: module.FeedbackCampaignsPage };
});

const FeedbackInboxPage = lazy(async () => {
  const module = await import("./routes/FeedbackInboxPage");
  return { default: module.FeedbackInboxPage };
});

const FeedbackResultsPage = lazy(async () => {
  const module = await import("./routes/FeedbackResultsPage");
  return { default: module.FeedbackResultsPage };
});

const FeedbackOutboxPage = lazy(async () => {
  const module = await import("./routes/FeedbackOutboxPage");
  return { default: module.FeedbackOutboxPage };
});

const FeedbackMechanismPage = lazy(async () => {
  const module = await import("./routes/FeedbackMechanismPage");
  return { default: module.FeedbackMechanismPage };
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
          <Route
            path="events"
            element={
              <LazyAdminRoute>
                <EventsPage />
              </LazyAdminRoute>
            }
          />
          <Route
            path="events/:eventId"
            element={
              <LazyAdminRoute>
                <EventDetailPage />
              </LazyAdminRoute>
            }
          />
          <Route
            path="participants"
            element={
              <LazyAdminRoute>
                <ParticipantsPage />
              </LazyAdminRoute>
            }
          />
          <Route
            path="participants/:id"
            element={
              <LazyAdminRoute>
                <ParticipantProfilePage />
              </LazyAdminRoute>
            }
          />
          <Route
            path="feedback"
            element={
              <LazyAdminRoute>
                <FeedbackCampaignsPage />
              </LazyAdminRoute>
            }
          />
          <Route
            path="feedback/:campaignId"
            element={
              <LazyAdminRoute>
                <FeedbackInboxPage />
              </LazyAdminRoute>
            }
          />
          <Route
            path="feedback/:campaignId/results"
            element={
              <LazyAdminRoute>
                <FeedbackResultsPage />
              </LazyAdminRoute>
            }
          />
          {/* Deliberately not under `feedback/` — the outbound queue spans
              every campaign, and a nested path would leave both it and
              «Feedback & safety» `aria-current` in the navigation. */}
          <Route
            path="outbound"
            element={
              <LazyAdminRoute>
                <FeedbackOutboxPage />
              </LazyAdminRoute>
            }
          />
          {/* Static explanation of the feedback mechanism. Its own `docs/`
              segment for the same reason as `outbound`: it is not a campaign,
              and `feedback/:campaignId` would swallow anything nested there. */}
          <Route
            path="docs/feedback"
            element={
              <LazyAdminRoute>
                <FeedbackMechanismPage />
              </LazyAdminRoute>
            }
          />
        </Route>
      </Route>
      <Route path="*" element={<ErrorPage />} />
    </Routes>
  );
}

/**
 * The local development tree. The bypass is announced in the shell's
 * environment block under the brand mark rather than by a banner above the
 * shell: a full-width strip pushed every route past the viewport height, which
 * cost the whole panel a permanent document scrollbar for a permanently true
 * message.
 */
function DevelopmentBypassApp() {
  return (
    <BrowserRouter>
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
