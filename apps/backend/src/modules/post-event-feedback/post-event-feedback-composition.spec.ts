import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import {
  QueueModule,
  QueueWorkerModule,
} from "../../infrastructure/queue/queue.module.js";
import { FeedbackOutboxSchedulerService } from "./feedback-outbox-scheduler.service.js";
import { MessageOutboxDeliveryService } from "./message-outbox-delivery.service.js";
import { MessageOutboxDeliveryStatusService } from "./message-outbox-delivery-status.service.js";
import { MessageOutboxRelayService } from "./message-outbox-relay.service.js";
import { PostEventFeedbackIngressModule } from "./post-event-feedback-ingress.module.js";
import { PostEventFeedbackIngressService } from "./post-event-feedback-ingress.service.js";
import { PostEventFeedbackMaterializer } from "./post-event-feedback-materializer.service.js";
import { PostEventFeedbackWorkerModule } from "./post-event-feedback-worker.module.js";
import { PostEventFeedbackProcessor } from "./post-event-feedback.processor.js";

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
  });

  it("mounts the webhook ingress edge only with the Wasender HTTP module", async () => {
    const { WasenderHttpModule } =
      await import("../../integrations/wasender/wasender-http.module.js");
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      WasenderHttpModule,
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
    expect(workerProviders).not.toContain(PostEventFeedbackIngressService);
  });
});
