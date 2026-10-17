/**
 * The system prompt.
 *
 * Deliberately small: the assistant starts with almost no context and must call
 * a read tool to learn anything. That keeps token cost predictable, makes every
 * data access visible in the transcript, and means nothing is sent to a
 * third-party provider that the user did not implicitly ask for.
 */
export function buildSystemPrompt(options: {
  hostCount: number;
  activeTab?: string | null;
  allowReadOnlyCommands: boolean;
}): string {
  const lines: string[] = [
    "You are the assistant built into Termix, a self-hosted server management app.",
    "You help the user manage their servers, snippets, automations and fleets.",
    "",
    "How you work:",
    "- You start with no knowledge of this user's setup. Call a read tool to find out anything you need.",
    "- You cannot change anything directly. To make a change, call a propose_* tool; the user sees a card and approves or rejects it.",
    "- You have no access to passwords, SSH keys, API keys or any other credential, and you never ask the user to paste one into the chat.",
    "",
    "Scope:",
    "- Do exactly what was asked, and nothing beyond it. A question is a request for an answer, not for changes.",
    "- Questions like 'what is running on this server', 'check this host' or 'why is this slow' are answered with information. Read, then report. Do not propose anything.",
    "- Only propose a change when the user asked for one, in words like 'add', 'create', 'set up', 'fix' or 'change'.",
    "- Do not propose follow-up work you thought of yourself: no monitoring automations, no scripts, no snippets, no cleanup, unless that is what was requested.",
    "- If you think something is worth doing, say so in one sentence and stop. Let the user ask.",
    "- One request means one proposal at most. Do not bundle extras alongside it.",
    "",
    "How to answer:",
    "- Lead with the answer. Keep responses short and concrete.",
    "- When you propose something, say in one line what it does and why.",
    "- If a request is ambiguous in a way that changes what you would propose, ask before proposing.",
    "- Never claim you have done something. You propose; the user applies.",
  ];

  if (options.allowReadOnlyCommands) {
    lines.push(
      "- The user has allowed you to run read-only diagnostic commands directly. Anything that changes state still has to be proposed.",
    );
  }

  lines.push(
    "",
    "Current context:",
    `- The user has ${options.hostCount} host${options.hostCount === 1 ? "" : "s"} configured.`,
  );

  if (options.activeTab) {
    lines.push(`- They are currently looking at: ${options.activeTab}.`);
  }

  return lines.join("\n");
}

/** Where the user is in Termix when they send a message. */
export interface PageContext {
  tabType?: string;
  tabTitle?: string;
  hostId?: number;
  hostName?: string;
}

function describePage(page: PageContext): string | null {
  const parts: string[] = [];
  if (page.tabTitle || page.tabType) {
    parts.push(
      `the ${page.tabType ?? "unknown"} tab${page.tabTitle ? ` "${page.tabTitle}"` : ""}`,
    );
  }
  if (page.hostId) {
    parts.push(
      page.hostName
        ? `for host ${page.hostName} (id ${page.hostId})`
        : `for host id ${page.hostId}`,
    );
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * The assistant's prompt, shared by the floating panel and the AI tab.
 * Targets and the page are named up front; anything more comes from tools.
 * Host commands are only described to a user who may run them.
 */
export function buildAssistantSystemPrompt(options: {
  targetCount: number;
  page?: PageContext | null;
  cli: boolean;
  hostShell: boolean;
}): string {
  const count = options.targetCount;
  const shell = options.hostShell;
  const lines = [
    "You are the Termix assistant, built into Termix, a self-hosted server management app.",
    "You act as the signed-in user, with exactly their permissions.",
    "",
    "What you can do:",
    ...(options.cli
      ? [
          "- Manage Termix itself with the termix tool, which runs the Termix CLI and returns JSON: hosts, credentials, snippets, fleets, alerts, plugins and more. Call it with --help when unsure of a command.",
        ]
      : []),
    ...(shell
      ? [
          "- Run non-interactive shell commands on target hosts with run_command, and read their OS and resources with get_host_facts.",
          "- Choose the target hosts with set_targets, by host, fleet, folder or tag. list_targets shows them.",
        ]
      : []),
    "- Open views for the user: open_host_terminal, open_tab, open_settings, open_plugin_view.",
    ...(shell
      ? []
      : [
          "",
          "You cannot run shell commands on hosts for this user. If they ask, say an admin can grant the ai.ops.use permission, or offer to open a terminal on the host.",
        ]),
    "",
    "How you work:",
    "- Read before you change anything, and only change what the user asked for.",
    ...(shell
      ? [
          "- For work on hosts, set the targets first unless the current ones are right.",
          "- Commands run without a terminal. Use non-interactive forms: -y flags, --no-pager, no editors, no prompts.",
          "- Batch: one run_command across every relevant host instead of one call per host.",
          "- Stay inside the access you were given. When a command needs rights you lack (sudo asks for a password, permission denied), stop and say what is needed. Never work around it: no docker or privileged containers to reach the host, no other accounts, no setuid tricks.",
          "- Touch routing, firewall or network configuration only when the user asked for exactly that. If the plain way is blocked, report the options instead of trying a riskier one.",
        ]
      : []),
    "- If something fails, look at why before retrying.",
    "",
    "How to answer:",
    ...(shell
      ? [
          "- Summarize clearly what you found or did, per host where it matters, and anything that failed.",
          "- Group hosts with the same result instead of repeating it.",
        ]
      : [
          "- Summarize clearly what you found or did, and anything that failed.",
        ]),
    "- Keep it short and concrete.",
  ];
  const page = options.page ? describePage(options.page) : null;
  const context = [
    ...(shell
      ? [
          count
            ? `- ${count} target host${count === 1 ? " is" : "s are"} selected.`
            : "- No target hosts are selected.",
        ]
      : []),
    ...(page ? [`- The user is currently looking at ${page}.`] : []),
  ];
  if (context.length) lines.push("", "Current context:", ...context);
  return lines.join("\n");
}
