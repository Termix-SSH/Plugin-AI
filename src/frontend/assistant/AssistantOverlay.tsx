import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  useCurrentUser,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, useIsMobile } from "@termix-ssh/plugin-sdk/ui";
import {
  Loader2,
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
 * The assistant everywhere: a ball that opens a panel you can drag and
 * resize, rendered once in the shell's "shell.overlay" slot. The ball steps
 * aside while the panel is open. Closing the panel only hides it; a run in
 * progress carries on in the store.
 */

export const OPS_TAB_ID = "ai-ops";

const BALL = 44;
const MARGIN = 16;

interface Position {
  right: number;
  bottom: number;
}

const storageKey = (user: string) => `termix-ai:assistant-ball:${user}`;

function readPosition(key: string): Position {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Number.isFinite(saved?.right) && Number.isFinite(saved?.bottom)) {
      return saved;
    }
  } catch {
    // Fall back to the corner.
  }
  return { right: MARGIN * 1.5, bottom: MARGIN * 1.5 };
}

/** Keeps the ball on screen, however the window was resized since. */
function clamp(position: Position): Position {
  const limit = (size: number) => Math.max(MARGIN, size - BALL - MARGIN);
  return {
    right: Math.min(
      Math.max(position.right, MARGIN / 2),
      limit(window.innerWidth),
    ),
    bottom: Math.min(
      Math.max(position.bottom, MARGIN / 2),
      limit(window.innerHeight),
    ),
  };
}

function Ball({ userKey }: { userKey: string }) {
  const { t } = useTranslation();
  const { streaming, open } = useAssistant();
  // A run that finished while the panel was closed leaves a dot to come back to.
  const [unread, setUnread] = useState(false);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming && !open) setUnread(true);
    wasStreaming.current = streaming;
  }, [streaming, open]);
  useEffect(() => {
    if (open) setUnread(false);
  }, [open]);
  const [position, setPosition] = useState(() =>
    clamp(readPosition(storageKey(userKey))),
  );
  const drag = useRef<{
    x: number;
    y: number;
    start: Position;
    moved: boolean;
  } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      start: position,
      moved: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    setPosition(
      clamp({
        right: current.start.right - dx,
        bottom: current.start.bottom - dy,
      }),
    );
  };

  // A drag ends where it was dropped; anything shorter is a click.
  const onPointerUp = () => {
    const current = drag.current;
    drag.current = null;
    if (!current?.moved) return assistant.toggle();
    localStorage.setItem(storageKey(userKey), JSON.stringify(position));
  };

  return (
    <button
      type="button"
      aria-label={t("assistant.toggle")}
      aria-expanded={open}
      title={t("assistant.toggle")}
      hidden={open}
      className="pointer-events-auto fixed z-50 flex touch-none items-center justify-center rounded-full border border-accent-brand/40 bg-background text-accent-brand hover:bg-accent-brand/10"
      style={{
        right: position.right,
        bottom: position.bottom,
        width: BALL,
        height: BALL,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          assistant.toggle();
        }
      }}
    >
      {streaming ? (
        <Loader2
          className="size-5 animate-spin"
          aria-label={t("agents.working")}
        />
      ) : (
        <Sparkles className="size-5" />
      )}
      {unread && (
        <span
          data-testid="assistant-unread"
          aria-label={t("assistant.unread")}
          className="absolute right-0.5 top-0.5 size-2.5 rounded-full bg-accent-brand"
        />
      )}
    </button>
  );
}

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

/** The saved rect, or one opening just above the ball. */
function initialRect(user: string): Rect {
  try {
    const saved = JSON.parse(localStorage.getItem(panelKey(user)) ?? "null");
    if (
      ["x", "y", "width", "height"].every((k) => Number.isFinite(saved?.[k]))
    ) {
      return fitRect(saved);
    }
  } catch {
    // Open next to the ball instead.
  }
  const ball = clamp(readPosition(storageKey(user)));
  const width = 420;
  const height = 560;
  return fitRect({
    width,
    height,
    x: window.innerWidth - ball.right - width,
    y: window.innerHeight - ball.bottom - BALL - MARGIN / 2 - height,
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
          aiApp().tabs.openSingletonTab(OPS_TAB_ID);
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
  const { open } = useAssistant();
  // The panel mounts on first open and then stays, hidden while closed, so
  // the composer keeps its draft between opens.
  const opened = useRef(false);
  if (open) opened.current = true;
  return (
    <>
      <Ball userKey={user?.userId ?? "anonymous"} />
      {opened.current && <Panel userKey={user?.userId ?? "anonymous"} />}
    </>
  );
}
