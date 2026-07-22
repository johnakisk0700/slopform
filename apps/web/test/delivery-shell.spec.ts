import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readWebFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("document delivery shell", () => {
  it("announces route changes and provides a bypass link", () => {
    const app = readWebFile("app/app.vue");

    expect(app).toContain("<NuxtRouteAnnouncer />");
    expect(app).toContain('class="skip-link" href="#main-content"');
  });

  it("keeps the admin layout main landmark focusable", () => {
    const layout = readWebFile("app/layouts/admin.vue");

    expect(layout).toContain('id="main-content"');
    expect(layout).toContain('tabindex="-1"');
  });

  it("exposes only the private admin route family", () => {
    const config = readWebFile("nuxt.config.ts");

    expect(config).toContain('"/": { redirect: "/admin" }');
    expect(config).toContain('"/admin/**"');
    expect(config).not.toContain('"/register/**"');
    expect(config).not.toContain('"/join/**"');
    expect(config).not.toContain('"/feedback/**"');
    expect(
      existsSync(
        fileURLToPath(
          new URL("../app/pages/register/[eventSlug].vue", import.meta.url),
        ),
      ),
    ).toBe(false);
  });

  it("exposes a meaningful landmark and status before the admin SPA mounts", () => {
    const loadingTemplate = readWebFile("app/spa-loading-template.html");

    expect(loadingTemplate.trimStart()).toMatch(/^<main\b/);
    expect(loadingTemplate).toContain('id="main-content"');
    expect(loadingTemplate).toContain('role="status"');
    expect(loadingTemplate).toContain('aria-busy="true"');
  });

  it("keeps the standalone error document private and bypassable", () => {
    const errorPage = readWebFile("app/error.vue");

    expect(errorPage).toContain('robots: "noindex, nofollow"');
    expect(errorPage).toContain('class="skip-link" href="#main-content"');
    expect(errorPage).toContain('id="main-content"');
    expect(errorPage).toContain('tabindex="-1"');
  });
});
