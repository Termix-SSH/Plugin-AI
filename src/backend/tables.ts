import {
  adoptLegacyTable,
  boolean,
  defineTable,
  id,
  integer,
  refUser,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

/*
 * Adopted from core's ai_* tables, so column and index names are the legacy
 * ones and the rename carries every row across.
 *
 * Messages and proposals point at their conversation with a plain integer
 * here, since the SDK only references users and ssh_data. The adoption
 * migrations keep that foreign key by hand, so deleting a conversation still
 * cascades.
 *
 * Provider API keys are not in these tables: they live in ctx.secrets under
 * "provider:<id>". A 2.8 database still has an api_key column, which the
 * boot migration empties after moving the key.
 */

export const providers = adoptLegacyTable(
  "ai_providers",
  defineTable(
    "providers",
    {
      id: id(),
      syncId: varchar().unique(),
      userId: refUser(),
      // ollama | anthropic | openai | gemini | openai_compatible
      providerType: text().notNull(),
      label: varchar().notNull(),
      // Required for ollama and openai_compatible, optional elsewhere.
      baseUrl: text(),
      // First few characters, kept in the clear so the UI can tell keys apart.
      apiKeyPrefix: text(),
      defaultModel: text(),
      // Unused since 0008 moved it into modelOverrides; a removed column
      // needs a hand-written migration for no gain.
      contextWindow: integer(),
      // JSON { "<model>": { "contextWindow": tokens } }, set by the user.
      modelOverrides: text(),
      enabled: boolean().notNull().default(true),
      createdAt: timestamp().notNull().defaultNow(),
      updatedAt: timestamp().notNull().defaultNow(),
    },
    {
      uniques: [
        { name: "idx_ai_providers_user_label", columns: ["userId", "label"] },
      ],
    },
  ),
);

export const conversations = adoptLegacyTable(
  "ai_conversations",
  defineTable(
    "conversations",
    {
      id: id(),
      userId: refUser(),
      title: text(),
      providerId: integer(),
      model: text(),
      // chat | ops | task
      mode: varchar(16).notNull().default("chat"),
      // Cluster Ops only: the host ids the conversation may run commands on.
      targets: text(),
      createdAt: timestamp().notNull().defaultNow(),
      updatedAt: timestamp().notNull().defaultNow(),
    },
    {
      indexes: [
        {
          name: "idx_ai_conversations_user",
          columns: ["userId", "updatedAt"],
        },
      ],
    },
  ),
);

export const messages = adoptLegacyTable(
  "ai_messages",
  defineTable(
    "messages",
    {
      id: id(),
      conversationId: integer().notNull(),
      // user | assistant | tool
      role: text().notNull(),
      content: text().notNull().default(""),
      // Serialized tool calls for this turn. A summary row keeps {keep} here.
      toolCalls: text(),
      // The model's thinking before this assistant turn, shown apart.
      reasoning: text(),
      createdAt: timestamp().notNull().defaultNow(),
    },
    {
      indexes: [
        {
          name: "idx_ai_messages_conversation",
          columns: ["conversationId", "createdAt"],
        },
      ],
    },
  ),
);

/**
 * A change the assistant wants to make. Nothing here has been applied: the
 * payload is re-validated at apply time and only then dispatched.
 */
export const proposals = adoptLegacyTable(
  "ai_proposals",
  defineTable(
    "proposals",
    {
      id: id(),
      conversationId: integer().notNull(),
      userId: refUser(),
      // The propose_* tool name that produced this.
      kind: varchar().notNull(),
      summary: text(),
      payload: text().notNull().default("{}"),
      // pending | applied | rejected | expired
      status: varchar(32).notNull().default("pending"),
      appliedAt: text(),
      resultSummary: text(),
      createdAt: timestamp().notNull().defaultNow(),
    },
    {
      indexes: [
        { name: "idx_ai_proposals_user", columns: ["userId", "status"] },
        {
          name: "idx_ai_proposals_conversation",
          columns: ["conversationId"],
        },
      ],
    },
  ),
);

/*
 * Coding agent sessions. Events and queued prompts are rows of their own, so a
 * running agent appends instead of rewriting its session and no single value
 * grows with the conversation. Text is TEXT on MySQL (64 KB), which is why
 * prompts, drafts and event text are capped in UTF-8 bytes.
 */
export const agentSessions = defineTable(
  "agent_sessions",
  {
    id: id(),
    sessionId: varchar(36).notNull().unique(),
    userId: refUser(),
    hostId: integer().notNull(),
    providerId: integer().notNull(),
    agent: varchar(32).notNull(),
    model: text().notNull(),
    cwd: text().notNull(),
    executable: text().notNull(),
    nativeId: text(),
    title: text(),
    archived: boolean().notNull().default(false),
    queuePaused: boolean().notNull().default(false),
    draft: text(),
    // At most 100 small records.
    attachments: text().notNull().default("[]"),
    updatedAt: text().notNull(),
  },
  {
    indexes: [{ name: "idx_ai_agent_sessions_user", columns: ["userId"] }],
  },
);

export const agentEvents = defineTable(
  "agent_events",
  {
    id: id(),
    sessionId: varchar(36).notNull(),
    userId: refUser(),
    seq: integer().notNull(),
    // text | tool | permission | status | error | user | state
    kind: varchar(16).notNull(),
    text: text().notNull(),
    requestId: text(),
    choices: text(),
  },
  {
    uniques: [
      {
        name: "idx_ai_agent_events_session_seq",
        columns: ["sessionId", "seq"],
      },
    ],
  },
);

export const agentQueue = defineTable(
  "agent_queue",
  {
    id: id(),
    sessionId: varchar(36).notNull(),
    userId: refUser(),
    promptId: varchar(36).notNull(),
    position: integer().notNull(),
    text: text().notNull(),
    attachmentIds: text().notNull().default("[]"),
  },
  {
    indexes: [
      {
        name: "idx_ai_agent_queue_session",
        columns: ["sessionId", "position"],
      },
    ],
  },
);

/**
 * Every command Cluster Ops ran on a host, one row per host. Output is cut to
 * the admin's per-host limit before it gets here.
 */
export const opsRuns = defineTable(
  "ops_runs",
  {
    id: id(),
    conversationId: integer().notNull(),
    userId: refUser(),
    hostId: integer().notNull(),
    command: text().notNull(),
    // Null when the command never finished: timed out, stopped or failed to start.
    exitCode: integer(),
    durationMs: integer().notNull(),
    output: text().notNull().default(""),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_ai_ops_runs_conversation", columns: ["conversationId"] },
    ],
  },
);

/**
 * Every Termix CLI call the assistant made, one row per call. Args are stored
 * with secret flag values redacted, output cut like a host's.
 */
export const cliRuns = defineTable(
  "cli_runs",
  {
    id: id(),
    conversationId: integer().notNull(),
    userId: refUser(),
    args: text().notNull(),
    // Null when the CLI never finished: timed out, stopped or failed to start.
    exitCode: integer(),
    durationMs: integer().notNull(),
    output: text().notNull().default(""),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_ai_cli_runs_conversation", columns: ["conversationId"] },
    ],
  },
);

/**
 * Tokens every model call used, whichever feature made it. Estimated rows are
 * from providers that report nothing, counted at about four characters per
 * token.
 */
export const usage = defineTable(
  "usage",
  {
    id: id(),
    userId: refUser(),
    providerId: integer(),
    model: text().notNull(),
    // Null outside a conversation.
    conversationId: integer(),
    // assistant | terminal | compaction | task | assets
    source: varchar(16).notNull(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    estimated: boolean().notNull().default(false),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_ai_usage_user", columns: ["userId", "createdAt"] },
      { name: "idx_ai_usage_created", columns: ["createdAt"] },
      { name: "idx_ai_usage_conversation", columns: ["conversationId"] },
    ],
  },
);

/**
 * One auto-ops task: an ai.tasks run an automation started, with its input
 * snapshot, report, L1 plan and decision. Plan and host ids are JSON.
 */
export const taskRuns = defineTable(
  "task_runs",
  {
    id: id(),
    userId: refUser(),
    automationId: integer().notNull(),
    automationRunId: integer(),
    presetId: varchar(64),
    title: text().notNull(),
    // report | propose
    autonomy: varchar(16).notNull(),
    hostIds: text().notNull(),
    trigger: text().notNull(),
    dryRun: boolean().notNull().default(false),
    // running | reported | proposed | approved | rejected | expired |
    // executing | done | failed | skipped
    status: varchar(16).notNull(),
    // info | warning | critical
    severity: varchar(16),
    summary: text(),
    report: text(),
    // [{ hostId, commands, rationale, risk, rollback, verify, results? }]
    plan: text(),
    decidedBy: varchar(255),
    decidedAt: timestamp(),
    // When a proposed plan stops being approvable.
    expiresAt: timestamp(),
    conversationId: integer(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    createdAt: timestamp().notNull().defaultNow(),
    finishedAt: timestamp(),
  },
  {
    indexes: [
      { name: "idx_ai_task_runs_user", columns: ["userId", "createdAt"] },
      {
        name: "idx_ai_task_runs_automation",
        columns: ["automationId", "createdAt"],
      },
      { name: "idx_ai_task_runs_status", columns: ["status"] },
    ],
  },
);

/** An automation made from a preset, with the preset version it used. */
export const presetLinks = defineTable(
  "preset_links",
  {
    id: id(),
    userId: refUser(),
    presetId: varchar(64).notNull(),
    presetVersion: integer().notNull(),
    automationId: integer().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  { indexes: [{ name: "idx_ai_preset_links_user", columns: ["userId"] }] },
);

/** A preset a user saved, for themselves or shared with everyone. */
export const taskPresets = defineTable(
  "task_presets",
  {
    id: id(),
    userId: refUser(),
    name: varchar(120).notNull(),
    description: text(),
    shared: boolean().notNull().default(false),
    // JSON: trigger, hostSelector, autonomy, runbook, maxRunSeconds
    config: text().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_ai_task_presets_user", columns: ["userId"] },
      { name: "idx_ai_task_presets_shared", columns: ["shared"] },
    ],
  },
);

/*
 * Asset inventory. One row per thing the collector found: a Termix host, a
 * Proxmox guest no Termix host matched, a container, or an address outside
 * the inventory something talks to. Collected facts are JSON, already cut to
 * what is safe to keep. The role/importance/system columns are for the AI
 * annotations that come later; each carries its source so a user's edit is
 * never overwritten.
 */
export const assets = defineTable(
  "assets",
  {
    id: id(),
    // host:<id> | guest:<node>/<vmid> | container:<hostId>/<name> | external:<ip>
    key: varchar().notNull().unique(),
    // host | guest | container | external
    kind: varchar(16).notNull(),
    // For a host, itself; for a guest or container, the host that reported it.
    hostId: integer(),
    name: text().notNull(),
    // JSON string[]
    ips: text().notNull().default("[]"),
    zone: varchar(120),
    // rule | user | ai
    zoneSource: varchar(16),
    // Addresses in more than one zone: a potential pivot.
    multiZone: boolean().notNull().default(false),
    // JSON, the parsed collection.
    facts: text(),
    collectedAt: timestamp(),
    // Set when the host was deleted or the guest or container disappeared.
    removedAt: timestamp(),
    role: text(),
    roleSource: varchar(16),
    // critical | high | medium | low
    importance: varchar(16),
    importanceSource: varchar(16),
    importanceReason: text(),
    system: varchar(120),
    systemSource: varchar(16),
    annotatedAt: timestamp(),
    // Hash of the summary the last annotation saw; a new one means the asset
    // changed and is annotated again. Null after an unlock, for the same.
    annotationFingerprint: varchar(64),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_ai_assets_host", columns: ["hostId"] },
      { name: "idx_ai_assets_zone", columns: ["zone"] },
    ],
  },
);

/** A relation between two assets, with the evidence it was derived from. */
export const assetEdges = defineTable(
  "asset_edges",
  {
    id: id(),
    fromAsset: integer().notNull(),
    toAsset: integer().notNull(),
    // runs_on | connects_to | member_of | depends_on
    type: varchar(32).notNull(),
    // JSON: ports, processes, count
    detail: text(),
    evidence: text(),
    // collector | ai | user
    source: varchar(16).notNull(),
    firstSeen: timestamp().notNull(),
    // Not seen in a later run means stale; edges are never deleted for it.
    lastSeen: timestamp().notNull(),
  },
  {
    uniques: [
      {
        name: "idx_ai_asset_edges_pair",
        columns: ["fromAsset", "toAsset", "type"],
      },
    ],
    indexes: [{ name: "idx_ai_asset_edges_to", columns: ["toAsset"] }],
  },
);

/**
 * One collection or annotation run and how it went. An annotation run counts
 * assets in the hosts columns, and the tokens its model calls took.
 */
export const assetRuns = defineTable(
  "asset_runs",
  {
    id: id(),
    // collect | annotate
    kind: varchar(16).notNull().default("collect"),
    // schedule | manual | host_event | collection
    trigger: varchar(16).notNull(),
    startedAt: timestamp().notNull(),
    finishedAt: timestamp(),
    // running | done | failed
    status: varchar(16).notNull(),
    hostsTotal: integer().notNull().default(0),
    hostsOk: integer().notNull().default(0),
    hostsFailed: integer().notNull().default(0),
    // JSON { "<hostId>": "<error>" }
    errorSummary: text(),
    tokens: integer().notNull().default(0),
  },
  { indexes: [{ name: "idx_ai_asset_runs_started", columns: ["startedAt"] }] },
);

/** An admin's CIDR to zone rule, ahead of the built-in ones. */
export const zones = defineTable("zones", {
  id: id(),
  name: varchar(120).notNull(),
  // internal | dmz | external | cloud | overlay
  kind: varchar(16).notNull(),
  cidr: varchar(64).notNull(),
  // Breaks a tie between rules with the same prefix length; higher wins.
  priority: integer().notNull().default(0),
  createdBy: varchar(255).notNull(),
  createdAt: timestamp().notNull().defaultNow(),
});

export const exposureObservations = defineTable(
  "exposure_observations",
  {
    id: varchar(64).primaryKey(),
    hostId: integer().notNull(),
    ownerId: varchar(255).notNull(),
    source: varchar(32).notNull(),
    at: timestamp().notNull(),
    payload: text().notNull(),
  },
  {
    indexes: [
      {
        name: "idx_ai_exposure_observation_source",
        columns: ["hostId", "ownerId", "source"],
      },
    ],
  },
);
export const exposureEntries = defineTable(
  "exposure_entries",
  {
    key: varchar(64).primaryKey(),
    hostId: integer().notNull(),
    ownerId: varchar(255).notNull(),
    source: varchar(32).notNull(),
    payload: text().notNull(),
  },
  {
    indexes: [
      {
        name: "idx_ai_exposure_entry_source",
        columns: ["hostId", "ownerId", "source"],
      },
    ],
  },
);
export const exposureChanges = defineTable(
  "exposure_changes",
  {
    id: varchar(64).primaryKey(),
    hostId: integer().notNull(),
    ownerId: varchar(255).notNull(),
    at: timestamp().notNull(),
    noticeStatus: varchar(16).notNull(),
    payload: text().notNull(),
  },
  {
    indexes: [
      { name: "idx_ai_exposure_notices", columns: ["noticeStatus", "ownerId"] },
    ],
  },
);

export const tables = [
  exposureObservations,
  exposureEntries,
  exposureChanges,
  providers,
  conversations,
  messages,
  proposals,
  agentSessions,
  agentEvents,
  agentQueue,
  opsRuns,
  cliRuns,
  usage,
  taskRuns,
  presetLinks,
  taskPresets,
  assets,
  assetEdges,
  assetRuns,
  zones,
];
