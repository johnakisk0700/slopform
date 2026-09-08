import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Effect } from "effect";
import type { Environment } from "../../infrastructure/config/environment.js";
import { runWithOriginalError } from "../../infrastructure/effect/promise.js";
import {
  ClusteringFailure,
  clusteringProgressSchema,
  validateClusteringResult,
  type ClusteringRequest,
  type ClusteringResult,
} from "./topic-clustering.protocol.js";

const repositoryRoot = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);
export const CLUSTERING_TIMEOUT_MS = 180_000;
export const CLUSTERING_OUTPUT_LIMIT = 2 * 1024 * 1024;
export const CLUSTERING_INPUT_LIMIT = 16 * 1024 * 1024;
type ProcessResource = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exited: boolean;
};

@Injectable()
export class TopicClusteringClient implements OnModuleDestroy {
  private readonly shutdown = new AbortController();
  private active: Promise<ClusteringResult> | undefined;
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async cluster(
    request: ClusteringRequest,
    signal: AbortSignal,
    progress: (stage: string) => void,
  ): Promise<ClusteringResult> {
    if (this.active)
      throw new ClusteringFailure("clustering_capacity_busy", true);
    if (this.shutdown.signal.aborted)
      throw new ClusteringFailure("clustering_shutting_down", true);
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > CLUSTERING_INPUT_LIMIT)
      throw new ClusteringFailure("clustering_input_too_large", false);
    const executable = resolveRuntimePath(
      this.config.get("FEEDBACK_TOPIC_CLUSTERING_PYTHON", { infer: true }),
    );
    const script = resolveRuntimePath(
      this.config.get("FEEDBACK_TOPIC_CLUSTERING_SCRIPT", { infer: true }),
    );
    const deadline = AbortSignal.any([
      signal,
      this.shutdown.signal,
      AbortSignal.timeout(CLUSTERING_TIMEOUT_MS),
    ]);
    // Nest owns DI/lifecycle. Effect scope owns only this child and its reaping.
    const flow = Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => spawnClusteringProcess(executable, script)),
        (resource) => Effect.promise(() => stopAndReap(resource)),
      ).pipe(
        Effect.flatMap((resource) =>
          Effect.tryPromise({
            try: (effectSignal) =>
              collectClusteringOutput(
                resource,
                body,
                request,
                AbortSignal.any([deadline, effectSignal]),
                progress,
              ),
            catch: (error) => error,
          }),
        ),
      ),
    );
    this.active = runWithOriginalError(flow);
    try {
      return await this.active;
    } finally {
      this.active = undefined;
    }
  }

  async onModuleDestroy() {
    this.shutdown.abort();
    await this.active?.catch(() => undefined);
  }
}

function resolveRuntimePath(path: string) {
  return isAbsolute(path) ? path : resolve(repositoryRoot, path);
}

function spawnClusteringProcess(
  executable: string,
  script: string,
): ProcessResource {
  const child = spawn(executable, ["-I", "-B", script], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      OPENBLAS_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
      MKL_NUM_THREADS: "1",
      NUMBA_NUM_THREADS: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  const resource: ProcessResource = {
    child,
    exited: false,
    closed: Promise.resolve({ code: null, signal: null }),
  };
  resource.closed = new Promise((resolveClosed) => {
    // Always consume spawn errors; close follows error even when spawn fails.
    child.on("error", () => undefined);
    child.once("close", (code, signal) => {
      resource.exited = true;
      resolveClosed({ code, signal });
    });
  });
  return resource;
}

async function stopAndReap(resource: ProcessResource): Promise<void> {
  if (resource.exited) return;
  resource.child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (!resource.exited) resource.child.kill("SIGKILL");
  }, 250);
  try {
    await resource.closed;
  } finally {
    clearTimeout(timer);
  }
}

function collectClusteringOutput(
  resource: ProcessResource,
  body: string,
  request: ClusteringRequest,
  signal: AbortSignal,
  progress: (stage: string) => void,
): Promise<ClusteringResult> {
  return new Promise((resolveResult, reject) => {
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let records = 0;
    let final: ClusteringResult | undefined;
    let failed = false;
    const fail = (error: ClusteringFailure) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    };
    const onAbort = () =>
      fail(new ClusteringFailure("clustering_cancelled_or_timeout", true));
    const parseLine = (line: string) => {
      if (failed) return;
      try {
        if (++records > 5 || final || !line)
          throw new ClusteringFailure("clustering_protocol_invalid", false);
        const value: unknown = JSON.parse(line);
        const report = clusteringProgressSchema.safeParse(value);
        if (report.success) {
          if (report.data.requestId !== request.requestId)
            throw new ClusteringFailure("clustering_request_mismatch", false);
          // Diagnostics cannot change the process or business outcome.
          try {
            progress(report.data.stage);
          } catch {
            /* observational */
          }
        } else
          final = validateClusteringResult(
            value,
            request.requestId,
            request.documents.map((document) => document.id),
          );
      } catch {
        fail(new ClusteringFailure("clustering_protocol_invalid", false));
      }
    };
    resource.child.stdout.setEncoding("utf8");
    resource.child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > CLUSTERING_OUTPUT_LIMIT + 4096) {
        fail(new ClusteringFailure("clustering_stdout_too_large", false));
        return;
      }
      if (failed) return;
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        parseLine(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
      }
    });
    resource.child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65_536)
        fail(new ClusteringFailure("clustering_stderr_too_large", false));
    });
    resource.child.once("error", () =>
      fail(new ClusteringFailure("clustering_spawn_failed", false)),
    );
    resource.child.stdin.on("error", () =>
      fail(new ClusteringFailure("clustering_stdin_failed", false)),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void resource.closed.then(({ code, signal: exitSignal }) => {
      signal.removeEventListener("abort", onAbort);
      if (failed) return;
      if (code !== 0 || exitSignal) {
        fail(new ClusteringFailure("clustering_process_failed", false));
        return;
      }
      if (stdout.trim()) parseLine(stdout);
      if (!failed && final) resolveResult(final);
      else fail(new ClusteringFailure("clustering_result_missing", false));
    });
    if (!failed) resource.child.stdin.end(body);
  });
}
