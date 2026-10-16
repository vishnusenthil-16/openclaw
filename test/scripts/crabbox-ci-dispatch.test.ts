import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchCiWorkflow,
  parseWorkflowInputs,
  readRunContext,
} from "../../scripts/lib/crabbox-ci-dispatch.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const label = "crabbox-frv-012345abcdef";
const four = "blacksmith-4vcpu-ubuntu-2404";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const manualRun = {
  id: 42,
  workflow_id: 7,
  event: "workflow_dispatch",
  head_repository: { full_name: "openclaw/openclaw" },
  head_sha: "a".repeat(40),
  head_branch: "main",
};

describe("manual Crabbox CI dispatch", () => {
  it.each(["main", "refs/heads/main"])(
    "retains the exact run receipt before rejecting raced source %s",
    async (ref) => {
      const requestPath = join(tempDirs.make("crabbox-ci-request-"), "request.json");
      let dispatched = false;
      const github = async (path: string, method = "GET", body?: unknown) => {
        if (path.endsWith("/actions/workflows/ci.yml")) {
          return { id: 7, path: ".github/workflows/ci.yml" };
        }
        if (path.endsWith(`/commits/${encodeURIComponent(ref)}`)) {
          return { sha: "a".repeat(40) };
        }
        if (path.endsWith("/dispatches")) {
          expect(method).toBe("POST");
          expect(body).toEqual({
            ref,
            inputs: { release_scope: "full", crabbox_runner_label: label },
          });
          expect(JSON.parse(readFileSync(requestPath, "utf8"))).not.toHaveProperty("run");
          dispatched = true;
          return { workflow_run_id: 42 };
        }
        if (path.endsWith("/actions/runs/42")) {
          return { ...manualRun, head_sha: "b".repeat(40) };
        }
        throw new Error(`Unexpected GitHub endpoint ${path}`);
      };
      await expect(
        dispatchCiWorkflow({
          workflow: "ci.yml",
          ref,
          label,
          requestPath,
          dispatcherArgs: ["-f", "release_scope=full"],
          github,
        }),
      ).rejects.toThrow("Dispatched workflow identity changed");
      expect(dispatched).toBe(true);
      expect(JSON.parse(readFileSync(requestPath, "utf8"))).toMatchObject({
        request: {
          mode: "standalone",
          workflowRef: "main",
          workflowSha: "a".repeat(40),
          workflowId: 7,
        },
        run: { id: 42 },
      });
    },
  );

  it.each([
    ["--field", "release_scope=full"],
    ["-f", "release_scope=full", "-f", "release_scope=main"],
    ["-f", `crabbox_runner_label=${label}`],
    ["-f", "missing-assignment"],
  ])("rejects invalid or conflicting manual inputs %j", (...args) => {
    expect(() => parseWorkflowInputs(args)).toThrow();
  });

  it("preserves raw string values including equals signs", () => {
    expect(parseWorkflowInputs(["--raw-field", "filter=a=b"])).toEqual({ filter: "a=b" });
  });

  it.each([
    {
      run: { ...manualRun, event: "pull_request" },
      labels: [label],
      error: "canonical repository manual",
    },
    {
      run: { ...manualRun, head_repository: { full_name: "contributor/fork" } },
      labels: [label],
      error: "canonical repository manual",
    },
    { run: manualRun, labels: [], error: "exactly one Crabbox label" },
    {
      run: manualRun,
      labels: [label, "crabbox-frv-ffffffffffff"],
      error: "exactly one Crabbox label",
    },
  ])("refuses unowned or ambiguous existing-run supervision", async ({ run, labels, error }) => {
    await expect(
      readRunContext({
        runId: 42,
        github: async () => run,
        pages: async () => [{ labels }],
      }),
    ).rejects.toThrow(error);
  });

  it("adopts only the exact canonical manual run and its single root label", async () => {
    expect(
      await readRunContext({
        runId: 42,
        github: async () => manualRun,
        pages: async () => [{ labels: ["self-hosted", label, four] }],
      }),
    ).toMatchObject({
      request: {
        mode: "standalone",
        repository: "openclaw/openclaw",
        workflowId: 7,
        wireInputs: { crabbox_runner_label: label },
      },
      run: { id: 42 },
    });
  });
});
