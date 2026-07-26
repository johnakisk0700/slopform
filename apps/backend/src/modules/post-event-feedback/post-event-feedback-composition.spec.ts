import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { isFeedbackSimulatorHttpEnabled } from "../../infrastructure/config/enabled-modules.js";
import {
  QueueModule,
  QueueWorkerModule,
} from "../../infrastructure/queue/queue.module.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { FeedbackOutboxSchedulerService } from "./outbox/relay-scheduler.service.js";
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
import { PostEventFeedbackWorkerModule } from "./worker.module.js";
import { PostEventFeedbackProcessor } from "./processor.js";

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
    expect(httpImports).not.toContain(PostEventFeedbackWorkerModule);
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

  it("keeps the feedback simulator HTTP module out of production composition", () => {
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
    expect(workerProviders).toContain(PostEventFeedbackExtractionModel);
    // The HTTP process must never hold a model provider client for this
    // feature; the webhook edge only inserts a row and enqueues.
    expect(ingressProviders).not.toContain(PostEventFeedbackExtractionModel);
  });

  it("reaches candidates only through the shared D16 events helper", () => {
    const workerImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      PostEventFeedbackWorkerModule,
    ) as readonly unknown[];

    expect(workerImports).toContain(EventsCoreModule);
  });
});
