import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { ListBadge } from "@termix-ssh/plugin-sdk/ui";
import type { Severity, TaskStatus } from "./api";

const STATUS_TONES: Partial<
  Record<TaskStatus, "destructive" | "muted" | "brand" | "warning" | "success">
> = {
  running: "brand",
  executing: "brand",
  approved: "brand",
  proposed: "warning",
  reported: "success",
  done: "success",
  failed: "destructive",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const { t } = useTranslation();
  return (
    <ListBadge tone={STATUS_TONES[status] ?? "muted"}>
      {t(`autoOps.status.${status}`)}
    </ListBadge>
  );
}

const SEVERITY_TONES = {
  info: "muted",
  warning: "warning",
  critical: "destructive",
} as const;

export function SeverityBadge({ severity }: { severity: Severity | null }) {
  const { t } = useTranslation();
  if (!severity) return null;
  return (
    <ListBadge tone={SEVERITY_TONES[severity]}>
      {t(`autoOps.severity.${severity}`)}
    </ListBadge>
  );
}
