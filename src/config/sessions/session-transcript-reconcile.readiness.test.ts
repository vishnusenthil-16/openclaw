import * as timers from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
}));

const observer = useReconcileWorkerObserver();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["between-polls", "queued-status", "during-close"] as const)(
  "preserves readiness lifetime and cancellation across %s",
  async (boundary) => {
    const stateDir = tempDirs.make("openclaw-projection-read-retirement-");
    const options = { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    const scope = {
      ...options,
      sessionId: "retired-read",
      sessionKey: "agent:main:retired-read",
    };
    setRuntimeConfigSnapshot({});
    const paused = createDeferred();
    let resume: (() => void) | undefined;
    try {
      await persistSessionTranscriptTurn(scope, {
        messages: [transcriptMessage("seed", null, { role: "user", content: "Read owner" })],
        touchSessionEntry: false,
      });
      await waitForSessionTranscriptIndexReconcile(options);
      const database = openOpenClawAgentDatabase(options);
      database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
      observer.onTask = ({ port, observeMessage }) => {
        let claiming = false;
        observeMessage((message) => {
          claiming = message.type === "plan-start";
        });
        const post = port.postMessage.bind(port);
        port.postMessage = (message, transferList) => {
          const postOptions = Array.isArray(transferList)
            ? { transfer: transferList }
            : transferList;
          if (claiming) {
            claiming = false;
            resume = () => post(message, postOptions);
            paused.resolve();
            return;
          }
          post(message, postOptions);
        };
      };
      startSessionTranscriptIndexReconcile(options);
      await paused.promise;
      const retire = async () => {
        const closing = closeOpenClawAgentDatabasesAsync();
        observer.onTask = undefined;
        resume?.();
        await closing;
        await waitForSessionTranscriptIndexReconcile(options);
      };
      if (boundary === "during-close") {
        observer.onTask = undefined;
        const closing = closeOpenClawAgentDatabasesAsync();
        let scheduled: { ok: true } | { ok: false; error: unknown };
        try {
          startSessionTranscriptIndexReconcile(options);
          scheduled = { ok: true };
        } catch (error) {
          scheduled = { ok: false, error };
        }
        const waiting = waitForSessionTranscriptProjection(scope).then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
        resume?.();
        await closing;
        expect({ scheduled, ready: await waiting }).toEqual({
          scheduled: { ok: true },
          ready: { ok: true },
        });
      } else if (boundary === "queued-status") {
        const {
          historyLane: { pool: historyPages },
        } = await import("./session-transcript-worker-resources.js");
        const { withSessionHistoryWorkerDatabase } =
          await import("./session-transcript-worker-runtime.js");
        const preparing = createDeferred();
        const releasePreparation = createDeferred();
        const queued = createDeferred();
        const run = historyPages.run.bind(historyPages);
        const capacity = historyPages.getSnapshot().maxWorkers;
        let submissions = 0;
        let enteredCount = 0;
        const admission = vi.spyOn(historyPages, "run").mockImplementation((input, taskOptions) => {
          if (submissions++ >= capacity) {
            const pending = run(input, taskOptions);
            queued.resolve();
            return pending;
          }
          return run(async () => {
            if (++enteredCount === capacity) {
              preparing.resolve();
            }
            await releasePreparation.promise;
            return typeof input === "function" ? await input() : input;
          }, taskOptions);
        });
        const blockers = Array.from({ length: capacity }, () =>
          withSessionHistoryWorkerDatabase(options, (owner) =>
            owner.readProjectionStatus({ env: options.env, sessionId: scope.sessionId }),
          ),
        );
        const controller = new AbortController();
        const reason = new Error("cancel queued projection status");
        let ready: Promise<{ kind: "resolved" } | { kind: "rejected"; error: unknown }> | undefined;
        try {
          await Promise.race([
            preparing.promise,
            Promise.all(blockers).then(() => {
              throw new Error("Projection reads settled before filling the worker pool");
            }),
          ]);
          ready = waitForSessionTranscriptProjection(scope, controller.signal).then(
            () => ({ kind: "resolved" as const }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          );
          await queued.promise;
          expect(historyPages.getSnapshot()).toMatchObject({
            activeTasks: capacity,
            pendingTasks: capacity + 1,
          });
          controller.abort(reason);
          expect(historyPages.getSnapshot()).toMatchObject({
            activeTasks: capacity,
            pendingTasks: capacity,
          });
          const outcome = await ready;
          expect(outcome.kind).toBe("rejected");
          if (outcome.kind === "rejected") {
            expect(outcome.error).toMatchObject({ name: "AbortError", cause: reason });
          }
        } finally {
          releasePreparation.resolve();
          try {
            const outcomes = await Promise.allSettled([...blockers, ready]);
            for (const outcome of outcomes.slice(0, capacity)) {
              expect(outcome).toMatchObject({ status: "fulfilled", value: true });
            }
          } finally {
            admission.mockRestore();
          }
        }
      } else {
        // The real status read completed; retire its owner while the waiter yields.
        const polling = vi.spyOn(timers, "setTimeout").mockImplementationOnce(retire);
        try {
          await expect(waitForSessionTranscriptProjection(scope)).resolves.toBeUndefined();
          expect(polling).toHaveBeenCalled();
        } finally {
          polling.mockRestore();
        }
      }
    } finally {
      resume?.();
      await waitForSessionTranscriptIndexReconcile(options);
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      clearRuntimeConfigSnapshot();
    }
  },
  30_000,
);
