import { useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

/**
 * What the model thought before the text that follows it. Collapsed, so it
 * never reads as part of the answer, and open on request.
 */
export function AiThinking({
  content,
  active = false,
}: {
  content: string;
  /** Still streaming in. */
  active?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        className="flex items-center gap-1.5 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {active ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Brain size={12} />
        )}
        {t(active ? "assistant.thinkingActive" : "assistant.thinking")}
      </button>
      {open && (
        <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l border-border pl-3 leading-relaxed">
          {content}
        </div>
      )}
    </div>
  );
}
