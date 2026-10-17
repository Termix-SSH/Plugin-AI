import { useState, type ReactNode } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListBadge,
  SelectField,
  TextField,
} from "@termix-ssh/plugin-sdk/ui";
import { Lock, LockOpen } from "lucide-react";
import { apiMessage } from "../autoops/api";
import {
  saveAnnotation,
  unlockAnnotation,
  type Annotation,
  type AnnotationField,
  type FieldSource,
  type Importance,
} from "./api";

const IMPORTANCES: Importance[] = ["critical", "high", "medium", "low"];

const IMPORTANCE_TONES: Record<
  Importance,
  "destructive" | "warning" | "brand" | "muted"
> = {
  critical: "destructive",
  high: "warning",
  medium: "brand",
  low: "muted",
};

/** AI or locked by a user; nothing for a field nobody has set. */
export function SourceBadge({ source }: { source: FieldSource }) {
  const { t } = useTranslation();
  if (source === "ai") {
    return (
      <span title={t("assets.sourceAiHint")}>
        <ListBadge tone="brand">{t("assets.sourceAi")}</ListBadge>
      </span>
    );
  }
  if (source === "user") {
    return (
      <span title={t("assets.sourceUserHint")}>
        <ListBadge tone="muted">
          <Lock className="mr-0.5 inline size-2.5" />
          {t("assets.sourceUser")}
        </ListBadge>
      </span>
    );
  }
  return null;
}

export function ImportanceBadge({
  importance,
}: {
  importance: Importance | null;
}) {
  const { t } = useTranslation();
  if (!importance) return <span className="text-muted-foreground">-</span>;
  return (
    <ListBadge tone={IMPORTANCE_TONES[importance] ?? "muted"}>
      {t(`assets.importance.${importance}`)}
    </ListBadge>
  );
}

type Draft = {
  role: string;
  importance: string;
  importanceReason: string;
  system: string;
};

const draftOf = (asset: Annotation): Draft => ({
  role: asset.role ?? "",
  importance: asset.importance ?? "",
  importanceReason: asset.importanceReason ?? "",
  system: asset.system ?? "",
});

/** Only what the user changed, so an untouched AI field stays the AI's. */
function changes(asset: Annotation, draft: Draft) {
  const before = draftOf(asset);
  const value = (text: string) => text.trim() || null;
  return {
    ...(draft.role !== before.role ? { role: value(draft.role) } : {}),
    ...(draft.importance !== before.importance ||
    draft.importanceReason !== before.importanceReason
      ? {
          importance: (draft.importance || null) as Importance | null,
          importanceReason: value(draft.importanceReason),
        }
      : {}),
    ...(draft.system !== before.system ? { system: value(draft.system) } : {}),
  };
}

/**
 * Role, importance and system with where each came from. A manager edits
 * them, which locks each changed field against annotation runs, and unlocks
 * a locked one to hand it back.
 */
export function AnnotationFields({
  asset,
  canManage,
  onSaved,
}: {
  asset: Annotation & { id: number };
  canManage: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
      setError(null);
      setDraft(null);
      onSaved();
    } catch (err) {
      setError(apiMessage(err, t("assets.saveFailed")));
    }
  };

  const row = (
    field: AnnotationField,
    label: string,
    value: ReactNode,
    source: FieldSource,
  ) => (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
        {value}
        <SourceBadge source={source} />
        {canManage && source === "user" && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            title={t("assets.unlock")}
            aria-label={t("assets.unlockField", { field: label })}
            onClick={() => void run(() => unlockAnnotation(asset.id, field))}
          >
            <LockOpen className="size-3" />
          </button>
        )}
      </dd>
    </div>
  );

  if (draft) {
    const diff = changes(asset, draft);
    return (
      <div className="space-y-2">
        <TextField
          label={t("assets.columns.role")}
          value={draft.role}
          onChange={(role) => setDraft({ ...draft, role })}
        />
        <SelectField
          label={t("assets.columns.importance")}
          value={draft.importance}
          onChange={(importance) => setDraft({ ...draft, importance })}
          options={[
            { value: "", label: "-" },
            ...IMPORTANCES.map((value) => ({
              value,
              label: t(`assets.importance.${value}`),
            })),
          ]}
        />
        <TextField
          label={t("assets.importanceReason")}
          value={draft.importanceReason}
          onChange={(importanceReason) =>
            setDraft({ ...draft, importanceReason })
          }
        />
        <TextField
          label={t("assets.columns.system")}
          value={draft.system}
          onChange={(system) => setDraft({ ...draft, system })}
        />
        <p className="text-xs text-muted-foreground">{t("assets.lockHint")}</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            {t("assets.cancelEdit")}
          </Button>
          <Button
            size="sm"
            disabled={!Object.keys(diff).length}
            onClick={() => void run(() => saveAnnotation(asset.id, diff))}
          >
            {t("assets.save")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {row(
          "role",
          t("assets.columns.role"),
          <span>{asset.role ?? "-"}</span>,
          asset.roleSource,
        )}
        {row(
          "importance",
          t("assets.columns.importance"),
          <ImportanceBadge importance={asset.importance} />,
          asset.importanceSource,
        )}
        {asset.importanceReason && (
          <div className="contents">
            <dt />
            <dd className="text-muted-foreground">{asset.importanceReason}</dd>
          </div>
        )}
        {row(
          "system",
          t("assets.columns.system"),
          <span>{asset.system ?? "-"}</span>,
          asset.systemSource,
        )}
      </dl>
      {canManage && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDraft(draftOf(asset))}
        >
          {t("assets.editAnnotation")}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
