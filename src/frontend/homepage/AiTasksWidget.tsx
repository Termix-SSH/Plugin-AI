import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Input,
  ListBadge,
  ListRow,
  PanelList,
  WidgetTitle,
  LoadingState,
} from "@termix-ssh/plugin-sdk/ui";
import { listTasks, type TaskItem } from "../autoops/api";
import {
  GRID_SIZE,
  type AiTasksWidgetConfig,
  type WidgetComponentProps,
  type WidgetDefinition,
  type WidgetEditFormProps,
} from "./homepage";

const DEFAULT_MAX = 6;

function AiTasksWidget({
  widget,
  config,
}: WidgetComponentProps<AiTasksWidgetConfig>) {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    tasks: TaskItem[];
    approvals: TaskItem[];
  } | null>(null);

  useEffect(() => {
    let live = true;
    listTasks()
      .then((result) => live && setData(result))
      .catch(() => live && setData({ tasks: [], approvals: [] }));
    return () => {
      live = false;
    };
  }, []);

  const max = config.maxItems > 0 ? config.maxItems : DEFAULT_MAX;
  const approvals = data?.approvals.filter((a) => a.status === "proposed");
  const rows = data
    ? [
        ...(approvals ?? []),
        ...data.tasks.filter((x) => !approvals?.includes(x)),
      ]
    : [];

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <WidgetTitle title={widget.title} icon={<Sparkles size={11} />} />
      {!data ? (
        <LoadingState compact label={t("widget.loading")} />
      ) : (
        <>
          <p className="px-3 pb-1 text-xs text-muted-foreground">
            {t("widget.pending", { count: approvals?.length ?? 0 })}
          </p>
          <PanelList
            empty={
              <p className="p-3 text-xs text-muted-foreground">
                {t("widget.empty")}
              </p>
            }
          >
            {rows.slice(0, max).map((task, index) => (
              <ListRow
                key={task.id}
                stripe={index}
                tone={
                  task.status === "proposed"
                    ? "warning"
                    : task.status === "failed"
                      ? "destructive"
                      : "none"
                }
                title={task.title}
                badges={<ListBadge>{task.status}</ListBadge>}
                meta={task.summary ?? undefined}
              />
            ))}
          </PanelList>
        </>
      )}
    </div>
  );
}

function AiTasksWidgetEditForm({
  config,
  onChange,
}: WidgetEditFormProps<AiTasksWidgetConfig>) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        {t("widget.maxItems")}
      </label>
      <Input
        type="number"
        min={1}
        max={50}
        value={config.maxItems}
        onChange={(e) =>
          onChange({ ...config, maxItems: Number(e.target.value) || 1 })
        }
      />
    </div>
  );
}

/** Registered while the user has the assistant on. */
export const aiTasksWidget: WidgetDefinition<AiTasksWidgetConfig> = {
  id: "ai_tasks_widget",
  name: "AI tasks",
  description: "Recent auto-ops tasks and plans waiting for approval",
  category: "monitoring",
  icon: <Sparkles size={14} />,
  defaultConfig: { maxItems: DEFAULT_MAX },
  defaultSize: { w: GRID_SIZE * 10, h: GRID_SIZE * 8 },
  minSize: { w: GRID_SIZE * 6, h: GRID_SIZE * 5 },
  components: { view: AiTasksWidget, editForm: AiTasksWidgetEditForm },
};
