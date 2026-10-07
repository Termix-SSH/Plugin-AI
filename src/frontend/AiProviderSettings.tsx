import { getErrorMessage } from "./errors";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import { Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useConfirm,
  AddButton,
  FormFooter,
  ListBadge,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createAiProvider,
  deleteAiProvider,
  getAiProviderModels,
  probeAiModels,
  updateAiProvider,
  type AiProvider,
  type AiProviderType,
} from "./ai-api";

const PROVIDER_TYPES: Array<{
  value: AiProviderType;
  labelKey: string;
  needsBaseUrl: boolean;
  needsApiKey: boolean;
  defaultBaseUrl?: string;
}> = [
  {
    value: "ollama",
    labelKey: "ai.providerOllama",
    needsBaseUrl: true,
    needsApiKey: false,
    defaultBaseUrl: "http://localhost:11434",
  },
  {
    value: "anthropic",
    labelKey: "ai.providerAnthropic",
    needsBaseUrl: false,
    needsApiKey: true,
  },
  {
    value: "openai",
    labelKey: "ai.providerOpenai",
    needsBaseUrl: false,
    needsApiKey: true,
  },
  {
    value: "gemini",
    labelKey: "ai.providerGemini",
    needsBaseUrl: false,
    needsApiKey: true,
  },
  {
    value: "openai_compatible",
    labelKey: "ai.providerOpenaiCompatible",
    needsBaseUrl: true,
    needsApiKey: false,
  },
];

const FORM = "flex flex-col gap-3 border-b border-border py-3";
const FIELD = "flex flex-col gap-1.5";

interface AiProviderSettingsProps {
  providers: AiProvider[];
  /** selectId names a provider that should become the active one. */
  onChanged: (selectId?: number) => void;
  onAdded?: () => void;
}

function ModelRefreshButton({
  detecting,
  onClick,
}: {
  detecting: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
      onClick={onClick}
      disabled={detecting}
    >
      {detecting ? (
        <Loader2 size={11} className="animate-spin" />
      ) : (
        <RefreshCw size={11} />
      )}
      {t("ai.modelRefresh")}
    </button>
  );
}

/** A model picker from the detected list, or free text when there is none. */
function ModelField({
  id,
  models,
  value,
  custom,
  detecting,
  warning,
  warningTone,
  onChange,
  onCustom,
  onRefresh,
}: {
  id: string;
  models: string[];
  value: string;
  custom: boolean;
  detecting: boolean;
  warning: string | null;
  warningTone: "muted" | "destructive";
  onChange: (value: string) => void;
  onCustom: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={FIELD}>
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className="min-w-0 flex-1">
          {t("ai.defaultModel")}
        </Label>
        <ModelRefreshButton detecting={detecting} onClick={onRefresh} />
      </div>

      {models.length > 0 && !custom ? (
        <Select
          value={value || undefined}
          onValueChange={(next) => {
            if (next === "__custom__") {
              onCustom();
              return;
            }
            onChange(next);
          }}
        >
          <SelectTrigger id={id} size="sm" className="w-full">
            <SelectValue placeholder={t("ai.modelPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
            {/* Anything the provider did not list is still reachable. */}
            <SelectItem value="__custom__">{t("ai.modelCustom")}</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t("ai.defaultModelPlaceholder")}
        />
      )}

      {warning && (
        <p
          className={
            warningTone === "destructive"
              ? "text-[11px] leading-snug text-destructive"
              : "text-[11px] leading-snug text-muted-foreground"
          }
        >
          {warning}
        </p>
      )}
    </div>
  );
}

function AiProviderEditForm({
  provider,
  onSaved,
  onCancel,
}: {
  provider: AiProvider;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(provider.label);
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectWarning, setDetectWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const detectModels = useCallback(async () => {
    setDetecting(true);
    setDetectWarning(null);
    try {
      const detected = await getAiProviderModels(provider.id);
      setModels(detected);
      setCustomModel(!!defaultModel && !detected.includes(defaultModel));
    } catch (error) {
      setModels([]);
      setCustomModel(true);
      setDetectWarning(getErrorMessage(error, t("ai.modelDetectFailed")));
    } finally {
      setDetecting(false);
    }
  }, [provider.id, defaultModel, t]);

  useEffect(() => {
    void detectModels();
    // The initial model value belongs to this provider. Subsequent edits must
    // not trigger a provider model-list request on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id]);

  async function handleSave() {
    if (!label.trim()) {
      toast.error(t("ai.labelRequired"));
      return;
    }

    setSaving(true);
    try {
      await updateAiProvider(provider.id, {
        label: label.trim(),
        defaultModel: defaultModel.trim() || null,
      });
      toast.success(t("ai.providerUpdated"));
      onSaved();
    } catch (error) {
      toast.error(getErrorMessage(error, t("ai.providerSaveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={FORM}>
      <div className={FIELD}>
        <Label htmlFor={`ai-provider-label-${provider.id}`}>
          {t("ai.providerLabel")}
        </Label>
        <Input
          id={`ai-provider-label-${provider.id}`}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          autoFocus
        />
      </div>

      <ModelField
        id={`ai-provider-model-${provider.id}`}
        models={models}
        value={defaultModel}
        custom={customModel}
        detecting={detecting}
        warning={detectWarning}
        warningTone="destructive"
        onChange={setDefaultModel}
        onCustom={() => {
          setCustomModel(true);
          setDefaultModel("");
        }}
        onRefresh={() => void detectModels()}
      />

      <FormFooter
        saving={saving}
        saveLabel={t("ai.save")}
        cancelLabel={t("ai.cancel")}
        onSave={() => void handleSave()}
        onCancel={onCancel}
      />
    </div>
  );
}

export function AiProviderSettings({
  providers,
  onChanged,
  onAdded,
}: AiProviderSettingsProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [providerType, setProviderType] = useState<AiProviderType>("ollama");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");

  const [models, setModels] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectWarning, setDetectWarning] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(false);

  const spec = PROVIDER_TYPES.find((entry) => entry.value === providerType)!;

  useEffect(() => {
    setBaseUrl(spec.defaultBaseUrl ?? "");
    setApiKey("");
    setModels([]);
    setDefaultModel("");
    setCustomModel(false);
    setDetectWarning(null);
  }, [providerType, spec.defaultBaseUrl]);

  /**
   * Fetches the provider's own model list so nobody has to go and look model
   * names up. Falls back to a curated list when the endpoint is unreachable,
   * and a free-text field is always available for anything not listed.
   */
  const detectModels = useCallback(async () => {
    setDetecting(true);
    setDetectWarning(null);
    try {
      const result = await probeAiModels({
        providerType,
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() || null,
      });
      setModels(result.models);
      if (result.source !== "live") {
        setDetectWarning(result.warning || t("ai.modelDetectFailed"));
      }
      // Pick the first suggestion so the field is never left empty.
      setDefaultModel((current) => current || result.models[0] || "");
    } catch {
      setDetectWarning(t("ai.modelDetectFailed"));
    } finally {
      setDetecting(false);
    }
  }, [providerType, baseUrl, apiKey, t]);

  // Detect as soon as the provider has enough detail to be reachable.
  useEffect(() => {
    if (!adding) return;
    const ready = spec.needsApiKey ? apiKey.trim().length > 0 : true;
    if (!ready) return;
    const timer = setTimeout(() => void detectModels(), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding, providerType, baseUrl, apiKey]);

  async function handleAdd() {
    if (!label.trim()) {
      toast.error(t("ai.labelRequired"));
      return;
    }
    setSaving(true);
    try {
      const created = await createAiProvider({
        providerType,
        label: label.trim(),
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() || null,
        defaultModel: defaultModel.trim() || null,
      });
      setAdding(false);
      setLabel("");
      setApiKey("");
      setDefaultModel("");
      onChanged(created.id);
      onAdded?.();
    } catch (error) {
      toast.error(getErrorMessage(error, t("ai.providerSaveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number, name: string) {
    const ok = await confirm({
      title: t("ai.removeProviderConfirm", { name }),
      confirmLabel: t("common.remove"),
    });
    if (!ok) return;
    try {
      await deleteAiProvider(id);
      onChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, t("ai.providerDeleteFailed")));
    }
  }

  const typeLabel = (type: AiProviderType) => {
    const entry = PROVIDER_TYPES.find((candidate) => candidate.value === type);
    return entry ? t(entry.labelKey) : type;
  };

  return (
    <div className="flex flex-col">
      {providers.map((provider) =>
        editingId === provider.id ? (
          <AiProviderEditForm
            key={provider.id}
            provider={provider}
            onSaved={() => {
              setEditingId(null);
              onChanged(provider.id);
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div
            key={provider.id}
            className="flex items-start justify-between gap-2 border-b border-border py-2.5"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-xs font-semibold">
                  {provider.label}
                </span>
                <ListBadge>{typeLabel(provider.providerType)}</ListBadge>
              </div>
              {[
                provider.defaultModel,
                provider.baseUrl,
                provider.apiKeyPrefix ? `${provider.apiKeyPrefix}…` : null,
              ]
                .filter((fact): fact is string => !!fact)
                .map((fact) => (
                  <span
                    key={fact}
                    className="truncate text-[10px] text-muted-foreground"
                  >
                    {fact}
                  </span>
                ))}
            </div>
            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                aria-label={t("ai.editProvider")}
                title={t("ai.editProvider")}
                onClick={() => {
                  setAdding(false);
                  setEditingId(provider.id);
                }}
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-destructive"
                aria-label={t("ai.removeProvider")}
                title={t("ai.removeProvider")}
                onClick={() => void handleDelete(provider.id, provider.label)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>
        ),
      )}

      {adding ? (
        <div className={FORM}>
          <div className={FIELD}>
            <Label htmlFor="ai-provider-type">{t("ai.providerType")}</Label>
            <Select
              value={providerType}
              onValueChange={(value) =>
                setProviderType(value as AiProviderType)
              }
            >
              <SelectTrigger id="ai-provider-type" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {t(entry.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className={FIELD}>
            <Label htmlFor="ai-provider-new-label">
              {t("ai.providerLabel")}
            </Label>
            <Input
              id="ai-provider-new-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t("ai.providerLabelPlaceholder")}
            />
          </div>

          {spec.needsBaseUrl && (
            <div className={FIELD}>
              <Label htmlFor="ai-provider-base-url">{t("ai.baseUrl")}</Label>
              <Input
                id="ai-provider-base-url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://localhost:11434"
              />
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("ai.privateEndpointHint")}
              </p>
            </div>
          )}

          {(spec.needsApiKey || providerType === "openai_compatible") && (
            <div className={FIELD}>
              <Label htmlFor="ai-provider-api-key">{t("ai.apiKey")}</Label>
              <Input
                id="ai-provider-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
              />
            </div>
          )}

          <ModelField
            id="ai-provider-new-model"
            models={models}
            value={defaultModel}
            custom={customModel}
            detecting={detecting}
            warning={detectWarning}
            warningTone="muted"
            onChange={setDefaultModel}
            onCustom={() => {
              setCustomModel(true);
              setDefaultModel("");
            }}
            onRefresh={() => void detectModels()}
          />

          <FormFooter
            saving={saving}
            saveLabel={t("ai.save")}
            cancelLabel={t("ai.cancel")}
            onSave={() => void handleAdd()}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <AddButton
          label={t("ai.addProvider")}
          className="mt-3 self-start"
          onClick={() => {
            setEditingId(null);
            setAdding(true);
          }}
        />
      )}
    </div>
  );
}
