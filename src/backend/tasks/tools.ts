import { termixTool } from "../ops/assistant-tools.js";
import {
  checkReadOnlyCliArgs,
  READ_ONLY_CLI_SUMMARY,
  type CliTarget,
} from "../ops/cli.js";
import { createOpsTools, type OpsSession } from "../ops/tools.js";
import type { CliRunInput } from "../repository.js";
import { isReadOnlyCommand } from "../tools/command-allowlist.js";
import { objectSchema, str, type AiTool } from "../tools/types.js";
import { REPORT_SECTIONS } from "./prompt.js";
import {
  SEVERITIES,
  type Autonomy,
  type PlanHost,
  type Severity,
} from "./types.js";

/**
 * The tools of an unattended run: the assistant's list_targets,
 * get_host_facts and run_command, with run_command held to the read-only
 * allowlist, termix held to read-only CLI commands when core can mint the
 * owner a token, then propose_plan (L1 only) and submit_report. Nothing here
 * changes a host or Termix; an approved plan runs later, outside the model.
 */

export interface TaskReport {
  severity: Severity;
  summary: string;
  report: string;
}

export interface TaskToolSession extends OpsSession {
  autonomy: Autonomy;
  /** Why the run must stop investigating and report now, if it must. */
  wrapUp: () => string | null;
  /** Seconds left until wrap-up, to cap a command's timeout. */
  secondsLeft: () => number;
  plan: PlanHost[] | null;
  report: TaskReport | null;
  /** Called once the report is in, to end the run. */
  onReport: () => void;
  /** The Termix CLI as the owner, or null when core cannot mint a token. */
  cli: CliTarget | null;
  recordCliRun: (run: CliRunInput) => Promise<void>;
}

/**
 * The longest a CLI call in a task may take. Each call mints its own token,
 * which must outlive the call: see CLI_TOKEN_TTL_SEC.
 */
export const TASK_CLI_TIMEOUT_SEC = 120;
export const CLI_TOKEN_TTL_SEC = 300;

const MAX_PLAN_COMMANDS = 20;
const MAX_COMMAND_LENGTH = 2000;

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.map(text);
  return list.every(Boolean) ? list : null;
}

/** The plan as given, or why it cannot be accepted. */
export function parsePlan(
  raw: unknown,
  targets: number[],
): { plan: PlanHost[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: "hosts must list at least one host" };
  }
  const plan: PlanHost[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const hostId = Number(entry?.hostId);
    if (!targets.includes(hostId)) {
      return { error: `Host ${entry?.hostId} is not a target of this task` };
    }
    if (plan.some((host) => host.hostId === hostId)) {
      return { error: `Host ${hostId} is listed twice` };
    }
    const commands = strings(entry.commands);
    if (!commands?.length || commands.length > MAX_PLAN_COMMANDS) {
      return {
        error: `commands for host ${hostId} must list 1 to ${MAX_PLAN_COMMANDS} commands`,
      };
    }
    if (commands.some((command) => command.length > MAX_COMMAND_LENGTH)) {
      return { error: `A command for host ${hostId} is too long` };
    }
    const verify = strings(entry.verify ?? []);
    if (!verify) return { error: `verify for host ${hostId} must be commands` };
    for (const command of verify) {
      const check = isReadOnlyCommand(command);
      if (!check.allowed) {
        return {
          error: `Verify commands must be read-only: "${command}": ${check.reason}`,
        };
      }
    }
    const rationale = text(entry.rationale);
    const risk = text(entry.risk);
    const rollback = text(entry.rollback);
    if (!rationale || !risk || !rollback) {
      return {
        error: `rationale, risk and rollback are required for host ${hostId}`,
      };
    }
    plan.push({ hostId, commands, rationale, risk, rollback, verify });
  }
  return { plan };
}

/** Level-2 headings in a Markdown report. */
const headingCount = (report: string) =>
  report.split("\n").filter((line) => /^##\s+\S/.test(line)).length;

const planSchema = {
  type: "array",
  description: "One entry per host that needs a change.",
  items: {
    type: "object",
    properties: {
      hostId: { type: "number", description: "A target host id" },
      commands: {
        type: "array",
        items: { type: "string" },
        description:
          "The exact commands, run verbatim in this order, stopping at the first failure.",
      },
      rationale: str("Why, with the measurements that support it"),
      risk: str("What could go wrong"),
      rollback: str("How to undo it, or that it cannot be undone"),
      verify: {
        type: "array",
        items: { type: "string" },
        description: "Read-only commands run afterwards to check the result",
      },
    },
    required: ["hostId", "commands", "rationale", "risk", "rollback", "verify"],
  },
};

export function createTaskTools(session: TaskToolSession): AiTool[] {
  const refusal = () => {
    const reason = session.wrapUp();
    return reason ? { error: `${reason} Call submit_report now.` } : null;
  };
  /** The asked timeout, else `fallback`, never past wrap-up. */
  const timeoutSec = (args: Record<string, unknown>, fallback: number) => {
    const limit = Math.max(1, Math.floor(session.secondsLeft()));
    const asked = Number(args.timeoutSec);
    return Math.min(
      Number.isFinite(asked) && asked > 0 ? asked : fallback,
      limit,
    );
  };

  const opsTools = createOpsTools(session).map((tool): AiTool => {
    if (tool.name === "list_targets") return tool;
    if (tool.name === "get_host_facts") {
      return {
        ...tool,
        handler: async (args, context) =>
          refusal() ?? tool.handler(args, context),
      };
    }
    return {
      ...tool,
      description: `${tool.description} Only read-only diagnostics from an allowlist run; anything else is refused.`,
      handler: async (args, context) => {
        const stop = refusal();
        if (stop) return stop;
        const check = isReadOnlyCommand(text(args.command));
        if (!check.allowed) {
          return {
            error: `Refused: ${check.reason}. This task may only run read-only diagnostics.`,
          };
        }
        return tool.handler(
          {
            ...args,
            timeoutSec: timeoutSec(args, session.limits.timeoutSec),
          },
          context,
        );
      },
    };
  });

  const readOnlyTermix = (tool: AiTool): AiTool => ({
    ...tool,
    description: `${tool.description} In this task only read-only commands run: ${READ_ONLY_CLI_SUMMARY}.`,
    handler: async (args, context) => {
      const stop = refusal();
      if (stop) return stop;
      const problem = Array.isArray(args.args)
        ? checkReadOnlyCliArgs(args.args.map(String))
        : null;
      if (problem) {
        return {
          error: `Refused: ${problem}. This task may only read Termix.`,
        };
      }
      return tool.handler(
        {
          ...args,
          timeoutSec: Math.min(
            timeoutSec(args, TASK_CLI_TIMEOUT_SEC),
            TASK_CLI_TIMEOUT_SEC,
          ),
        },
        context,
      );
    },
  });
  const cliTools = session.cli
    ? [
        readOnlyTermix(
          termixTool({ ...session, hostShell: false }, session.cli),
        ),
      ]
    : [];

  const proposePlan: AiTool = {
    name: "propose_plan",
    description:
      "Propose the change the runbook calls for, as exact commands per host, for a person to approve. Call it once; a later call replaces the plan. Nothing runs until it is approved.",
    category: "ops",
    parameters: objectSchema(
      {
        summary: str("What the plan does, in one sentence"),
        hosts: planSchema,
      },
      ["summary", "hosts"],
    ),
    handler: async (args) => {
      const parsed = parsePlan(args.hosts, session.targets);
      if ("error" in parsed) return parsed;
      session.plan = parsed.plan;
      return {
        status: "recorded",
        hosts: parsed.plan.length,
        next: "Call submit_report, describing the plan under Actions taken.",
      };
    },
  };

  const submitReport: AiTool = {
    name: "submit_report",
    description:
      "Hand in the final report. Call it exactly once, last; the run ends with it.",
    category: "ops",
    parameters: objectSchema(
      {
        severity: {
          type: "string",
          enum: SEVERITIES,
          description: "info, warning or critical",
        },
        summary: str("The verdict in one or two sentences"),
        report: str(
          "The report in Markdown with the four required level-2 headings",
        ),
      },
      ["severity", "summary", "report"],
    ),
    handler: async (args) => {
      const severity = text(args.severity) as Severity;
      if (!SEVERITIES.includes(severity)) {
        return { error: "severity must be info, warning or critical" };
      }
      const summary = text(args.summary);
      const report = text(args.report);
      if (!summary) return { error: "summary is required" };
      if (headingCount(report) < REPORT_SECTIONS) {
        return {
          error: `report must have the ${REPORT_SECTIONS} level-2 headings (## ...) in order`,
        };
      }
      session.report = { severity, summary, report };
      session.onReport();
      return { status: "recorded" };
    },
  };

  return [
    ...opsTools,
    ...cliTools,
    ...(session.autonomy === "propose" ? [proposePlan] : []),
    submitReport,
  ];
}
