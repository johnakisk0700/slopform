import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { IS_PUBLIC_ROUTE } from "../../infrastructure/auth/public.decorator.js";
import { ProviderCallLimiterModule } from "../../infrastructure/ai/provider-call-limiter.module.js";
import { isFeedbackSimulatorHttpEnabled } from "../../infrastructure/config/enabled-modules.js";
import {
  QueueModule,
  QueueWorkerModule,
} from "../../infrastructure/queue/queue.module.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { FeedbackBurstController } from "./burst/burst.controller.js";
import { FeedbackOutboxSchedulerService } from "./outbox/relay-scheduler.service.js";
import { DisabledFeedbackTransport } from "./outbox/disabled-transport.service.js";
import type { SimulatedFeedbackTransport } from "./outbox/simulated-transport.service.js";
import { FeedbackSweepSchedulerService } from "./sweeps/sweep-scheduler.service.js";
import { MessageOutboxDeliveryService } from "./outbox/deliver.service.js";
import { MessageOutboxDeliveryStatusService } from "./outbox/delivery-status.service.js";
import { MessageOutboxRelayService } from "./outbox/relay.service.js";
import { PostEventFeedbackExtractionModel } from "./extraction/model.service.js";
import { PostEventFeedbackExtractor } from "./extraction/extract.service.js";
import { PostEventFeedbackHttpModule } from "./http.module.js";
import { PostEventFeedbackIngressModule } from "./ingress/ingress.module.js";
import { PostEventFeedbackIngressService } from "./ingress/ingress.service.js";
import { PostEventFeedbackMaterializer } from "./ingress/materialize.service.js";
import { PostEventFeedbackSweepService } from "./sweeps/sweep.service.js";
import { FeedbackSimulatorController } from "./simulator/simulator.controller.js";
import {
  createFeedbackTransport,
  PostEventFeedbackWorkerModule,
} from "./worker.module.js";
import { PostEventFeedbackProcessor } from "./processor.js";

function providerToken(provider: unknown): unknown {
  if (
    typeof provider === "object" &&
    provider !== null &&
    "provide" in provider
  ) {
    return (provider as { provide: unknown }).provide;
  }
  return provider;
}

describe("post-event feedback process composition", () => {
  it("keeps the durable consumer in the worker graph only", async () => {
    process.env.DATABASE_URL ??=
      "postgresql://user:password@127.0.0.1:5432/join_the_six_test";
    process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/join_the_six_test";
    const [httpApp, workerApp] = await Promise.all([
      import("../../http-app.module.js"),
      import("../../worker-app.module.js"),
    ]);
    const httpImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      httpApp.HttpAppModule,
    ) as readonly unknown[];
    const workerImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      workerApp.WorkerAppModule,
    ) as readonly unknown[];

    expect(workerImports).toContain(PostEventFeedbackWorkerModule);
    expect(workerImports).toContain(ProviderCallLimiterModule);
    expect(httpImports).not.toContain(PostEventFeedbackWorkerModule);
    expect(httpImports).not.toContain(ProviderCallLimiterModule);
    expect(httpImports).toContain(PostEventFeedbackHttpModule);
  });

  it("mounts the webhook ingress edge only with the Wasender HTTP module", async () => {
    const { WasenderWebhookModule } =
      await import("./ingress/wasender-webhook.module.js");
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      WasenderWebhookModule,
    ) as readonly unknown[];

    // The webhook route is env-gated, so the producer edge must arrive with it
    // rather than sitting permanently in the HTTP graph.
    expect(imports).toContain(PostEventFeedbackIngressModule);
  });

  it("splits producer and worker queue registrations by process", () => {
    const ingressImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      PostEventFeedbackIngressModule,
    ) as readonly unknown[];
    const workerImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      PostEventFeedbackWorkerModule,
    ) as readonly unknown[];

    expect(ingressImports).toContain(QueueModule);
    expect(ingressImports).not.toContain(QueueWorkerModule);
    expect(workerImports).toContain(QueueWorkerModule);
    expect(workerImports).not.toContain(QueueModule);
  });

  it("keeps the processor out of the ingress edge and the edge out of the worker", () => {
    const ingressProviders = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PostEventFeedbackIngressModule,
    ) as readonly unknown[];
    const workerProviders = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PostEventFeedbackWorkerModule,
    ) as readonly unknown[];

    expect(ingressProviders).toContain(PostEventFeedbackIngressService);
    expect(ingressProviders).toContain(MessageOutboxDeliveryStatusService);
    expect(workerProviders).toContain(PostEventFeedbackProcessor);
    expect(workerProviders).toContain(PostEventFeedbackMaterializer);
    expect(workerProviders).toContain(MessageOutboxRelayService);
    expect(workerProviders).toContain(MessageOutboxDeliveryService);
    expect(workerProviders).toContain(FeedbackOutboxSchedulerService);
    expect(workerProviders).toContain(FeedbackSweepSchedulerService);
    expect(workerProviders).toContain(PostEventFeedbackSweepService);
    expect(workerProviders).not.toContain(PostEventFeedbackIngressService);
  });

  it("keeps production simulator composition fail-closed without its rehearsal gate", () => {
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "production",
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "simulated",
      }),
    ).toBe(false);
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "development",
        FEEDBACK_SIMULATOR_ENABLED: "false",
        TRANSPORT_MODE: "simulated",
      }),
    ).toBe(false);
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "development",
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "wasender",
      }),
    ).toBe(false);
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "development",
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "simulated",
      }),
    ).toBe(true);
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "production",
        FEEDBACK_PRODUCTION_REHEARSAL_ENABLED: "true",
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "simulated",
      }),
    ).toBe(true);
  });

  it("keeps the production rehearsal simulator behind the global Clerk guard", () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_ROUTE, FeedbackSimulatorController),
    ).not.toBe(true);
    expect(
      Reflect.getMetadata(IS_PUBLIC_ROUTE, FeedbackBurstController),
    ).not.toBe(true);
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_ROUTE,
        FeedbackBurstController.prototype.getCatalog,
      ),
    ).not.toBe(true);

    for (const method of [
      "getCatalog",
      "preflightRun",
      "startRun",
      "getRun",
      "inject",
      "getThread",
    ] as const) {
      expect(
        Reflect.getMetadata(
          IS_PUBLIC_ROUTE,
          FeedbackSimulatorController.prototype[method],
        ),
      ).not.toBe(true);
    }
  });

  it("selects a provider-free disabled transport and enforces Wasender credentials in the worker", () => {
    const disabled = new DisabledFeedbackTransport();
    const simulated = {} as SimulatedFeedbackTransport;

    expect(
      createFeedbackTransport("disabled", undefined, simulated, disabled),
    ).toBe(disabled);
    expect(
      createFeedbackTransport("simulated", undefined, simulated, disabled),
    ).toBe(simulated);
    expect(() =>
      createFeedbackTransport("wasender", undefined, simulated, disabled),
    ).toThrow(/WASENDER_SESSION_API_KEY is required/);
  });

  it("keeps the extraction model provider in the worker process only", () => {
    const workerProviders = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PostEventFeedbackWorkerModule,
    ) as readonly unknown[];
    const ingressProviders = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PostEventFeedbackIngressModule,
    ) as readonly unknown[];

    expect(workerProviders).toContain(PostEventFeedbackExtractor);
    expect(workerProviders.map(providerToken)).toContain(
      PostEventFeedbackExtractionModel,
    );
    // The HTTP process must never hold a model provider client for this
    // feature; the webhook edge only inserts a row and enqueues.
    expect(ingressProviders.map(providerToken)).not.toContain(
      PostEventFeedbackExtractionModel,
    );
  });

  it("reaches candidates only through the shared D16 events helper", () => {
    const workerImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      PostEventFeedbackWorkerModule,
    ) as readonly unknown[];

    expect(workerImports).toContain(EventsCoreModule);
  });
});
