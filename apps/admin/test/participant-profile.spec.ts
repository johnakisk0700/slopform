import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("participant profile page", () => {
  it("renders from the generated getParticipant and listParticipantEvents hooks", () => {
    const page = readAdminFile("src/routes/ParticipantProfilePage.tsx");
    const app = readAdminFile("src/App.tsx");
    const list = readAdminFile("src/routes/ParticipantsPage.tsx");

    expect(page).toContain("useGetParticipant");
    expect(page).toContain("useListParticipantEvents");
    expect(page).toContain("useUpdateParticipantFeedbackOptIn");
    expect(page).toContain('from "../api/generated/participants"');
    expect(page).toContain("Dinner history");
    expect(page).toContain("No dinners yet");
    expect(page).toContain("Feedback WhatsApp opted in");
    expect(page).not.toContain('api("');
    expect(page).not.toContain("api(`");

    expect(app).toContain('import("./routes/ParticipantProfilePage")');
    expect(app).toContain('path="participants/:id"');

    expect(list).toContain("`/admin/participants/${row.original.id}`");
  });
});
