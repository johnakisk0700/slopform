import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("admin delivery shell", () => {
  it("applies the saved theme before first paint", () => {
    const html = readAdminFile("index.html");

    expect(html).toContain("localStorage.getItem('jts-theme')");
    expect(html).toContain(
      "document.documentElement.classList.toggle('dark',d)",
    );
  });

  it("keeps the private admin document unindexed", () => {
    const html = readAdminFile("index.html");

    expect(html).toContain('name="robots"');
    expect(html).toContain("noindex, nofollow");
  });

  it("ships a focusable main landmark fallback before the SPA mounts", () => {
    const html = readAdminFile("index.html");

    expect(html).toContain('id="main-content"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
  });

  it("keeps the private admin document unindexed via robots meta", () => {
    const html = readAdminFile("index.html");

    expect(html).toContain('name="robots"');
    expect(html).toContain('content="noindex, nofollow"');
  });

  it("redirects the root to /admin and mounts the admin route", () => {
    const app = readAdminFile("src/App.tsx");

    expect(app).toContain('path="/"');
    expect(app).toContain('<Navigate to="/admin"');
    expect(app).toContain('path="/admin"');
  });

  it("loads feature routes lazily and keeps dependency groups explicit", () => {
    const app = readAdminFile("src/App.tsx");
    const viteConfig = readAdminFile("vite.config.ts");

    expect(app).toContain('import("./routes/OverviewPage")');
    expect(app).toContain('import("./routes/AssistantPage")');
    expect(app).toContain("<Suspense");
    expect(viteConfig).toContain("codeSplitting");
    expect(viteConfig).toContain("chunkSizeWarningLimit: 700");
  });
});
