import { Toast } from "@heroui/react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { AdminShell } from "./components/admin/AdminShell";
import { ErrorPage } from "./routes/ErrorPage";
import { OverviewPage } from "./routes/OverviewPage";

/**
 * The admin application root: the toast portal, the skip link (the first
 * focusable element on the page), and the route table. `/` redirects into the
 * `/admin` shell, which nests the routed views through its `<Outlet />`, and
 * any unknown path renders the standalone 404 screen.
 */
export function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <Toast.Provider />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/admin" replace />} />
          <Route path="/admin" element={<AdminShell />}>
            <Route index element={<OverviewPage />} />
          </Route>
          <Route path="*" element={<ErrorPage />} />
        </Routes>
      </BrowserRouter>
    </>
  );
}
