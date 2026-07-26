import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { FeedbackSimOutboundRepository } from "../simulator/sim-outbound.repository.js";
import { SimulatedFeedbackTransport } from "./simulated-transport.service.js";

describe("SimulatedFeedbackTransport", () => {
  it("persists outbound sends for later sim-thread reads", async () => {
    const outboxId = randomUUID();
    const rows: {
      id: string;
      outboxId: string;
      phoneE164: string;
      body: string;
      providerMessageId: string;
      sentAt: Date;
    }[] = [];

    const repository = {
      insertSimOutbound: vi.fn(async (input) => {
        const row = { id: input.id ?? randomUUID(), ...input };
        rows.push(row);
        return row;
      }),
      findSimOutboundById: vi.fn(async (id: string) =>
        rows.find((row) => row.id === id),
      ),
    } as unknown as FeedbackSimOutboundRepository;

    const transport = new SimulatedFeedbackTransport(repository);
    const result = await transport.sendText({
      to: "+306900000001",
      text: "Γεια!",
      outboxId,
    });

    expect(result.outcome).toBe("accepted");
    expect(repository.insertSimOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxId,
        phoneE164: "+306900000001",
        body: "Γεια!",
      }),
    );

    const info = await transport.getMessageInfo(
      (result as { providerLogId: string }).providerLogId,
    );
    expect(info?.status).toBe("sent");
  });
});
