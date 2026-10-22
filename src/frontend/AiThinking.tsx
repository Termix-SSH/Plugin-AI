import { useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { SafeMarkdown } from "./markdown";

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
        <div className="mt-1 max-h-64 overflow-y-auto break-words border-l border-border pl-3 leading-relaxed [&_a]:underline [&_code]:font-mono [&_li]:my-0 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-none [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4">
          <SafeMarkdown>{content}</SafeMarkdown>
        </div>
      )}
    </div>
  );
}
