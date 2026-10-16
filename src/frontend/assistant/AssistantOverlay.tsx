import { useRef, useState, type PointerEvent } from "react";
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
 * The assistant everywhere: a ball in the corner and the panel it opens,
 * rendered once in the shell's "shell.overlay" slot. Closing the panel only
 * hides it; a run in progress carries on in the store.
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
    </button>
  );
}

const MIN_SIZE = 320;

/** The floating panel's size, from a handle on its top-left corner. */
function usePanelSize() {
  const [size, setSize] = useState({ width: 420, height: 560 });
  const drag = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const fit = (value: number, room: number) =>
    Math.round(Math.min(Math.max(value, MIN_SIZE), Math.max(room, MIN_SIZE)));

  const handle = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, ...size };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (!start) return;
      // Anchored bottom-right, so pulling up and left makes it bigger.
      setSize({
        width: fit(
          start.width - (event.clientX - start.x),
          window.innerWidth - 48,
        ),
        height: fit(
          start.height - (event.clientY - start.y),
          window.innerHeight - 112,
        ),
      });
    },
    onPointerUp: () => {
      drag.current = null;
    },
  };
  return { size, handle };
}

function Panel() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { open, drawer } = useAssistant();
  const { size, handle } = usePanelSize();
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
        docked
          ? "bottom-0 right-0 top-0 w-full sm:w-[440px]"
          : "bottom-20 right-6 max-h-[calc(100vh-7rem)] max-w-[calc(100vw-3rem)]"
      }`}
      style={docked ? undefined : size}
    >
      {!docked && (
        <div
          aria-hidden
          className="absolute left-0 top-0 z-10 size-3 cursor-nwse-resize touch-none"
          {...handle}
        />
      )}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs font-medium">
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
      {opened.current && <Panel />}
    </>
  );
}
