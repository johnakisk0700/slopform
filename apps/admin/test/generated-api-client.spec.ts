import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import rebaseOnApiClient from "../openapi.transformer";

const generatedDirectory = fileURLToPath(
  new URL("../src/api/generated", import.meta.url),
);

function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

function generatedEndpointFiles(): string[] {
  return readdirSync(generatedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) =>
      readFileSync(`${generatedDirectory}/${entry.name}`, "utf8"),
    );
}

describe("generated API client", () => {
  it("rebases published paths onto the API client base URL", () => {
    const document = {
      paths: {
        "/api/v1/auth/session": { get: {} },
        "/api/v1/health/live": { get: {} },
      },
    };

    expect(Object.keys(rebaseOnApiClient(document).paths)).toStrictEqual([
      "/v1/auth/session",
      "/v1/health/live",
    ]);
  });

  it("refuses a document whose paths leave the API mount point", () => {
    expect(() =>
      rebaseOnApiClient({ paths: { "/v1/auth/session": {} } }),
    ).toThrow('start with "/api/"');
  });

  it("routes every generated operation through the shared ofetch client", () => {
    const files = generatedEndpointFiles();
    const mutator = readAdminFile("src/lib/api-mutator.ts");

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toContain("apiRequest");
      expect(file).not.toContain("ofetch");
      expect(file).not.toContain("await fetch(");
    }

    expect(mutator).toContain('import { api } from "./api"');
  });

  it("exposes one named hook per backend operation id", () => {
    const contract = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../backend/openapi/openapi.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { paths: Record<string, Record<string, { operationId: string }>> };
    const generated = generatedEndpointFiles().join("\n");

    const operationIds = Object.values(contract.paths).flatMap((item) =>
      Object.values(item).map((operation) => operation.operationId),
    );

    expect(operationIds.length).toBeGreaterThan(0);
    for (const operationId of operationIds) {
      const hook = `use${operationId[0]?.toUpperCase()}${operationId.slice(1)}`;
      expect(generated).toContain(hook);
    }
  });

  it("gates the admin shell with the generated session hook", () => {
    const guard = readAdminFile("src/components/admin/RequireAdmin.tsx");

    expect(guard).toContain("useGetAuthSession");
    expect(guard).toContain("status === 401 || status === 403");
    expect(guard).not.toContain("zod");
    expect(guard).not.toContain('api<unknown>("/v1/auth/session"');
  });

  it("mounts one query client at the application root", () => {
    const main = readAdminFile("src/main.tsx");

    expect(main).toContain("<QueryClientProvider client={queryClient}>");
    expect(main).toContain("createQueryClient()");
    expect(readAdminFile("src/lib/queryClient.ts")).toContain("retry: false");
  });
});
