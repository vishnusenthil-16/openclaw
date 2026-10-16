// Manual CI dispatch owns its exact API receipt; queue observation never guesses a run.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const repository = "openclaw/openclaw";
const labelPattern = /^crabbox-frv-[a-f0-9]{12}$/u;
const shaPattern = /^[a-f0-9]{40}$/u;

export function parseWorkflowInputs(args) {
  const inputs = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const assignment = args[index + 1];
    const separator = assignment?.indexOf("=") ?? -1;
    const key = assignment?.slice(0, separator);
    if (!["-f", "--raw-field"].includes(flag) || separator < 1 || !/^[a-z][a-z0-9_]*$/u.test(key)) {
      throw new Error("Standalone workflow inputs must use -f key=value or --raw-field key=value");
    }
    if (key === "crabbox_runner_label" || Object.hasOwn(inputs, key)) {
      throw new Error(`Duplicate or controller-owned workflow input: ${key}`);
    }
    inputs[key] = assignment.slice(separator + 1);
  }
  return inputs;
}

function runId(value) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(
      "GitHub did not return an exact workflow run ID; retain the request and reconcile before retrying",
    );
  }
  return Number(value);
}

function requireManualRun(run) {
  if (
    run.event !== "workflow_dispatch" ||
    run.head_repository?.full_name !== repository ||
    !shaPattern.test(run.head_sha) ||
    !Number.isSafeInteger(run.workflow_id) ||
    run.workflow_id < 1 ||
    typeof run.head_branch !== "string" ||
    !run.head_branch
  ) {
    throw new Error("Crabbox supervision requires a canonical repository manual workflow run");
  }
}

export async function dispatchCiWorkflow({
  workflow,
  ref,
  label,
  requestPath,
  dispatcherArgs = [],
  github,
}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.ya?ml$/u.test(workflow)) {
    throw new Error("--workflow must name a repository workflow .yml or .yaml file");
  }
  if (typeof ref !== "string" || !ref || shaPattern.test(ref) || !labelPattern.test(label)) {
    throw new Error(
      "Standalone CI requires a branch or tag ref and a controller-owned Crabbox label",
    );
  }
  const inputs = parseWorkflowInputs(dispatcherArgs);
  const prefix = `repos/${repository}`;
  const selectedWorkflow = await github(`${prefix}/actions/workflows/${workflow}`);
  const commit = await github(`${prefix}/commits/${encodeURIComponent(ref)}`);
  if (
    !Number.isSafeInteger(selectedWorkflow.id) ||
    selectedWorkflow.id < 1 ||
    selectedWorkflow.path !== `.github/workflows/${workflow}` ||
    !shaPattern.test(commit.sha)
  ) {
    throw new Error("GitHub returned an invalid workflow or selected-ref identity");
  }
  const record = {
    request: {
      mode: "standalone",
      repository,
      workflowRef: ref.replace(/^refs\/(?:heads|tags)\//u, ""),
      workflowSha: commit.sha,
      workflowId: selectedWorkflow.id,
      wireInputs: { ...inputs, crabbox_runner_label: label },
    },
  };
  await mkdir(dirname(requestPath), { recursive: true });
  await writeFile(requestPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  const response = await github(
    `${prefix}/actions/workflows/${selectedWorkflow.id}/dispatches`,
    "POST",
    {
      ref,
      inputs: record.request.wireInputs,
    },
  );
  record.run = { id: runId(response.workflow_run_id) };
  // Retain the returned identity before reads: a raced ref still created this exact run.
  await writeFile(requestPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const run = await github(`${prefix}/actions/runs/${record.run.id}`);
  requireManualRun(run);
  if (
    Number(run.id) !== record.run.id ||
    run.workflow_id !== record.request.workflowId ||
    run.head_sha !== record.request.workflowSha ||
    run.head_branch !== ref.replace(/^refs\/(?:heads|tags)\//u, "")
  ) {
    throw new Error(
      "Dispatched workflow identity changed; use the retained exact run ID for recovery",
    );
  }
  return record;
}

export async function readRunContext({ runId: requestedRunId, github, pages }) {
  const id = runId(requestedRunId);
  const prefix = `repos/${repository}`;
  const run = await github(`${prefix}/actions/runs/${id}`);
  requireManualRun(run);
  if (Number(run.id) !== id) {
    throw new Error("GitHub returned a different workflow run identity");
  }
  const jobs = await pages(`${prefix}/actions/runs/${id}/jobs?filter=latest`, "jobs");
  const labels = new Set(
    jobs.flatMap((job) => job.labels.filter((label) => labelPattern.test(label))),
  );
  if (labels.size !== 1) {
    throw new Error(
      "Run must expose exactly one Crabbox label in its root jobs; use --attach with the retained controller request",
    );
  }
  return {
    request: {
      mode: "standalone",
      repository,
      workflowRef: run.head_branch,
      workflowSha: run.head_sha,
      workflowId: run.workflow_id,
      wireInputs: { crabbox_runner_label: [...labels][0] },
    },
    run: { id },
  };
}
