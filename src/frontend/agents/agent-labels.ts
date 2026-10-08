import type { AgentKind, AgentSession } from "../../backend/agents/types";

export const agentNames: Record<AgentKind, string> = {
  pi: "Pi",
  opencode: "OpenCode",
  claude: "Claude Code",
  codex: "Codex",
};

export const statusTone: Record<
  AgentSession["status"],
  "brand" | "success" | "muted" | "destructive"
> = {
  starting: "brand",
  running: "brand",
  ready: "success",
  stopped: "muted",
  error: "destructive",
};
