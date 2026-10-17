/**
 * The ai.tasks service contract, version 1, and the shapes an auto-ops task
 * stores. Automations calls run() from its ai_task step.
 */

export type Autonomy = "report" | "propose";
export type Severity = "info" | "warning" | "critical";

export interface AiTaskInput {
  automationId: number;
  automationRunId: number;
  /** Set when the automation came from a preset, to group its reports. */
  presetId?: string;
  /** The report title, such as "Disk cleanup · k3s-worker-1". */
  title: string;
  /** What to do, in plain language. */
  runbook: string;
  /** L0 reports, L1 proposes a plan for approval. */
  autonomy: Autonomy;
  /** Already resolved by Automations. */
  hostIds: number[];
  trigger: {
    kind: string;
    hostId?: number;
    summary: string;
    vars: Record<string, string>;
  };
  /** A test run from Automations: forced to report, no notifications. */
  dryRun: boolean;
  deadlineAt: number;
  signal?: AbortSignal;
}

export type AiTaskResultStatus = "reported" | "proposed" | "skipped" | "failed";

export interface AiTaskResult {
  status: AiTaskResultStatus;
  taskRunId: number | null;
  /** A sentence or two for the automation's run history. */
  summary: string;
  severity: Severity;
  /** ai.status, ai.severity and ai.summary, for later steps. */
  vars: Record<string, string>;
}

export interface AiTasksV1 {
  run: (input: AiTaskInput) => Promise<AiTaskResult>;
}

export type TaskStatus =
  | "running"
  | "reported"
  | "proposed"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "done"
  | "failed"
  | "skipped";

/** Statuses a task is still open in, for deduplication. */
export const OPEN_STATUSES: TaskStatus[] = [
  "running",
  "proposed",
  "approved",
  "executing",
];

/** Which part of a task ran a command, as its audit entry records. */
export type TaskPhase = "investigate" | "execute" | "verify";

/** One command of an executed plan, as it ran. */
export interface StepResult {
  command: string;
  phase: Exclude<TaskPhase, "investigate">;
  exitCode: number | null;
  output: string;
  error?: string;
  durationMs: number;
}

/** One host's part of an L1 plan. */
export interface PlanHost {
  hostId: number;
  commands: string[];
  rationale: string;
  risk: string;
  rollback: string;
  verify: string[];
  /** Filled in while the plan executes. */
  results?: StepResult[];
  /** Why the host was not run, or stopped. */
  error?: string;
}

export const SEVERITIES: Severity[] = ["info", "warning", "critical"];
