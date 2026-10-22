import type { TestServer } from "../helpers";
import type {
  AiTaskInput,
  AiTaskResult,
  AiTasksV1,
} from "../../../src/backend/tasks/types.js";

const encoder = new TextEncoder();

/** An OpenAI-style event stream of these frames. */
export function sse(...frames: unknown[]) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${body.join("")}data: [DONE]\n\n`));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

export const toolCall = (name: string, args: Record<string, unknown>) => ({
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    },
  ],
});

export const text = (content: string) => ({
  choices: [{ delta: { content } }],
});

export interface ModelBody {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string } }>;
}

/** A model that makes these calls in order, one per turn, then answers. */
export function scriptedModel(
  ...calls: Array<[string, Record<string, unknown>]>
) {
  const bodies: ModelBody[] = [];
  const fetch = async (_url: string, init?: unknown) => {
    const body = JSON.parse((init as { body: string }).body);
    bodies.push(body);
    const next = calls[bodies.length - 1];
    return next ? sse(toolCall(...next)) : sse(text("Done."));
  };
  return { fetch, bodies };
}

/** A model that never answers until the request is aborted. */
export function hangingModel() {
  let calls = 0;
  const fetch = (_url: string, init?: unknown) => {
    // Model details are looked up first; only the chat call hangs.
    if (!(init as { body?: string } | undefined)?.body) {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    calls += 1;
    const signal = (init as { signal?: AbortSignal }).signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  };
  return { fetch, calls: () => calls };
}

export const REPORT = [
  "## Verdict",
  "All good.",
  "## Evidence",
  "- web-1: disk 40%",
  "## Actions taken",
  "None.",
  "## Recommendations",
  "None.",
].join("\n");

export const submit = (
  severity = "info",
  summary = "All good.",
): [string, Record<string, unknown>] => [
  "submit_report",
  { severity, summary, report: REPORT },
];

export const OPS_PERMISSIONS = [
  "ai.use",
  "ai.manage_providers",
  "ai.apply_proposals",
  "ai.ops.use",
];

/** Turns the assistant on and gives user-1 a provider. */
export async function prepare(server: TestServer, user = "user-1") {
  await server.enableFor(user);
  const created = await server.request("POST", "/providers", {
    user,
    body: {
      providerType: "openai",
      // The mock speaks Chat Completions; official OpenAI uses the Responses API.
      baseUrl: "https://llm.example/v1",
      label: "Work",
      apiKey: "sk-test",
      defaultModel: "gpt-5",
    },
  });
  return created.body.provider.id as number;
}

export function taskInput(overrides: Partial<AiTaskInput> = {}): AiTaskInput {
  return {
    automationId: 7,
    automationRunId: 70,
    title: "Disk check",
    runbook: "Check the disks.",
    autonomy: "report",
    hostIds: [1],
    trigger: {
      kind: "metric_threshold",
      hostId: 1,
      summary: "disk.percent 87% on / (threshold 85%)",
      vars: { "trigger.value": "87" },
    },
    dryRun: false,
    deadlineAt: Date.now() + 60_000,
    ...overrides,
  };
}

/** Calls ai.tasks as `user`, the way Automations does. */
export function runTask(
  server: TestServer,
  input: AiTaskInput,
  user = "user-1",
): Promise<AiTaskResult> {
  const service = server.mock.services.get("ai.tasks") as AiTasksV1;
  return server.mock.actAs(user, () => service.run(input));
}

/** Every task row, oldest first. */
export function taskRows(server: TestServer) {
  return server.db.sqlite
    .prepare("SELECT * FROM p_ai_task_runs ORDER BY id")
    .all() as Array<Record<string, unknown>>;
}

/** Inserts a task row as it would be after a run. */
export function insertTask(
  server: TestServer,
  row: Record<string, unknown>,
): number {
  const values = {
    user_id: "user-1",
    automation_id: 7,
    title: "Disk cleanup",
    autonomy: "propose",
    host_ids: "[1]",
    trigger: JSON.stringify({ kind: "metric_threshold", hostId: 1 }),
    status: "proposed",
    created_at: new Date().toISOString(),
    ...row,
  };
  const keys = Object.keys(values);
  const result = server.db.sqlite
    .prepare(
      `INSERT INTO p_ai_task_runs (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(values)) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

/** Waits until `check` passes, for work that runs after a response. */
export async function eventually(check: () => boolean, ms = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
