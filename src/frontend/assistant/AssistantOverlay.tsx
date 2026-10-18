import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  useCurrentUser,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, useIsMobile } from "@termix-ssh/plugin-sdk/ui";
import {
  Maximize2,
  PanelRight,
  PanelRightClose,
  Sparkles,
  X,
} from "lucide-react";
import { aiApp } from "../app-ref";
import { AssistantChat } from "./AssistantChat";
import { assistant, useAssistant } from "./store";

/**
 * The assistant everywhere: a panel you can drag and resize, opened with
 * Ctrl+J or from the AI tab, rendered once in the shell's "shell.overlay"
 * slot. Closing the panel only hides it; a run in progress carries on in the
 * store.
 */

/** The AI tab, the assistant's full view. Also its rail id. */
export const AI_TAB_ID = "ai";

const MARGIN = 16;

const MIN_WIDTH = 320;
const MIN_HEIGHT = 360;
/** How much of the header stays reachable when the panel is pushed off screen. */
const GRIP = 48;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const panelKey = (user: string) => `termix-ai:assistant-panel:${user}`;

/** On screen and no smaller than the minimum, wherever it was left. */
function fitRect(rect: Rect): Rect {
  const width = Math.min(Math.max(rect.width, MIN_WIDTH), window.innerWidth);
  const height = Math.min(
    Math.max(rect.height, MIN_HEIGHT),
    window.innerHeight,
  );
  return {
    width,
    height,
    x: Math.min(Math.max(rect.x, GRIP - width), window.innerWidth - GRIP),
    y: Math.min(Math.max(rect.y, 0), window.innerHeight - GRIP),
  };
}

/** The saved rect, or one in the bottom right corner. */
function initialRect(user: string): Rect {
  try {
    const saved = JSON.parse(localStorage.getItem(panelKey(user)) ?? "null");
    if (
      ["x", "y", "width", "height"].every((k) => Number.isFinite(saved?.[k]))
    ) {
      return fitRect(saved);
    }
  } catch {
    // Open in the corner instead.
  }
  const width = 420;
  const height = 560;
  return fitRect({
    width,
    height,
    x: window.innerWidth - width - MARGIN,
    y: window.innerHeight - height - MARGIN,
  });
}

/** Moves a rect by a drag on `edge`, or the whole rect for the header. */
function dragRect(start: Rect, edge: Edge | "move", dx: number, dy: number) {
  if (edge === "move") return { ...start, x: start.x + dx, y: start.y + dy };
  const next = { ...start };
  if (edge.includes("e")) next.width = start.width + dx;
  if (edge.includes("s")) next.height = start.height + dy;
  if (edge.includes("w")) {
    next.width = Math.max(start.width - dx, MIN_WIDTH);
    next.x = start.x + start.width - next.width;
  }
  if (edge.includes("n")) {
    next.height = Math.max(start.height - dy, MIN_HEIGHT);
    next.y = start.y + start.height - next.height;
  }
  return next;
}

const EDGES: Array<[Edge, string]> = [
  ["n", "left-2 right-2 top-0 h-1.5 cursor-ns-resize"],
  ["s", "bottom-0 left-2 right-2 h-1.5 cursor-ns-resize"],
  ["e", "bottom-2 right-0 top-2 w-1.5 cursor-ew-resize"],
  ["w", "bottom-2 left-0 top-2 w-1.5 cursor-ew-resize"],
  ["nw", "left-0 top-0 size-3 cursor-nwse-resize"],
  ["se", "bottom-0 right-0 size-3 cursor-nwse-resize"],
  ["ne", "right-0 top-0 size-3 cursor-nesw-resize"],
  ["sw", "bottom-0 left-0 size-3 cursor-nesw-resize"],
];

/** Where the floating panel is, moved by its header and sized by its edges. */
function usePanelRect(user: string) {
  const [rect, setRect] = useState(() => initialRect(user));
  const drag = useRef<{
    x: number;
    y: number;
    start: Rect;
    edge: Edge | "move";
  } | null>(null);

  useEffect(() => {
    const refit = () => setRect((current) => fitRect(current));
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, []);

  const handlers = (edge: Edge | "move") => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      // Buttons in the header stay clickable.
      if ((event.target as HTMLElement).closest("button")) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, start: rect, edge };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current) return;
      setRect(
        fitRect(
          dragRect(
            current.start,
            current.edge,
            event.clientX - current.x,
            event.clientY - current.y,
          ),
        ),
      );
    },
    onPointerUp: () => {
      if (!drag.current) return;
      drag.current = null;
      setRect((current) => {
        localStorage.setItem(panelKey(user), JSON.stringify(current));
        return current;
      });
    },
  });
  return { rect, handlers };
}

function Panel({ userKey }: { userKey: string }) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { open, drawer } = useAssistant();
  const { rect, handlers } = usePanelRect(userKey);
  const docked = drawer || isMobile;

  const iconButton = "size-7";
  const actions = (
    <>
      {!isMobile && (
        <Button
          size="icon"
          variant="ghost"
          className={iconButton}
          aria-label={t(drawer ? "assistant.float" : "assistant.dock")}
          title={t(drawer ? "assistant.float" : "assistant.dock")}
          onClick={() => assistant.setDrawer(!drawer)}
        >
          {drawer ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        className={iconButton}
        aria-label={t("assistant.openTab")}
        title={t("assistant.openTab")}
        onClick={() => {
          aiApp().tabs.openSingletonTab(AI_TAB_ID);
          assistant.setOpen(false);
        }}
      >
        <Maximize2 size={14} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className={iconButton}
        aria-label={t("assistant.close")}
        title={t("assistant.close")}
        onClick={() => assistant.setOpen(false)}
      >
        <X size={14} />
      </Button>
    </>
  );

  return (
    <section
      role="dialog"
      aria-label={t("assistant.title")}
      hidden={!open}
      className={`pointer-events-auto fixed z-50 flex flex-col overflow-hidden border border-border bg-background text-foreground ${
        docked ? "bottom-0 right-0 top-0 w-full sm:w-[440px]" : ""
      }`}
      style={
        docked
          ? undefined
          : {
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
            }
      }
    >
      {!docked &&
        EDGES.map(([edge, place]) => (
          <div
            key={edge}
            aria-hidden
            data-edge={edge}
            className={`absolute z-10 touch-none ${place}`}
            {...handlers(edge)}
          />
        ))}
      <div
        className={`flex shrink-0 select-none items-center gap-2 border-b border-border px-3 py-1.5 text-xs font-medium ${
          docked ? "" : "cursor-move touch-none"
        }`}
        data-testid="assistant-header"
        title={docked ? undefined : t("assistant.moveHint")}
        onDoubleClick={() => !isMobile && assistant.setDrawer(!drawer)}
        {...(docked ? {} : handlers("move"))}
      >
        <Sparkles className="size-3.5 text-accent-brand" />
        {t("assistant.title")}
      </div>
      <AssistantChat actions={actions} />
    </section>
  );
}

export function AssistantOverlay() {
  const user = useCurrentUser();
  const userKey = user?.userId ?? "anonymous";
  const { open } = useAssistant();
  // Mounted with the shell, so after a reload a run still going on
  // server-side is picked up.
  useEffect(() => assistant.resume(userKey), [userKey]);
  // The panel mounts on first open and then stays, hidden while closed, so
  // the composer keeps its draft between opens.
  const opened = useRef(false);
  if (open) opened.current = true;
  return opened.current ? <Panel userKey={userKey} /> : null;
}
