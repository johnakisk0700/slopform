import { StrictMode } from "react";
import { ClerkProvider } from "@clerk/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AuthStatusScreen } from "./components/admin/AuthStatusScreen";
import { env } from "./lib/env";
import { createQueryClient } from "./lib/queryClient";
import "./styles/globals.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Unable to mount the admin app: #root element is missing.");
}

const publishableKey = env.clerkPublishableKey;
const queryClient = createQueryClient();

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {env.authDevBypass ? (
        <App />
      ) : publishableKey ? (
        <ClerkProvider
          publishableKey={publishableKey}
          signInFallbackRedirectUrl="/admin"
          signInUrl="/sign-in"
        >
          <App />
        </ClerkProvider>
      ) : (
        <AuthStatusScreen kind="configuration" />
      )}
    </QueryClientProvider>
  </StrictMode>,
);
