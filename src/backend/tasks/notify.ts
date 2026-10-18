import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { reportText } from "./language.js";
import type { TaskRunRecord } from "./repository.js";
import type { Severity } from "./types.js";

export type TaskNotice = "reported" | "proposed" | "executed" | "failed";

const TITLE_KEYS = {
  reported: "noticeReported",
  proposed: "noticeProposed",
  executed: "noticeExecuted",
  failed: "noticeFailed",
} as const;

/**
 * Tells the task's owner in the Alerts inbox, linking to the AI tab, which
 * opens Auto-ops on the newest task. A dry run tells nobody, and a failed
 * delivery never fails the task.
 */
export async function notifyOwner(
  ctx: Pick<PluginContext, "notify" | "log">,
  task: Pick<TaskRunRecord, "id" | "userId" | "title" | "dryRun" | "trigger">,
  notice: TaskNotice,
  summary: string,
  severity: Severity,
  language: string,
): Promise<void> {
  if (task.dryRun) return;
  const hostId = Number(task.trigger.hostId);
  try {
    await ctx.notify.send({
      title: reportText(language, TITLE_KEYS[notice], { title: task.title }),
      body: summary,
      severity: notice === "proposed" ? "warning" : severity,
      category: `ai.task_${notice}`,
      audience: { userId: task.userId },
      link: { tab: "ai" },
      dedupeKey: `ai-task-${task.id}-${notice}`,
      context: {
        ...(Number.isInteger(hostId) && hostId > 0 ? { hostId } : {}),
        sourceId: task.id,
        sourceName: task.title,
        taskRunId: task.id,
      },
    });
  } catch (error) {
    ctx.log.warn(
      `Could not notify about AI task ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
