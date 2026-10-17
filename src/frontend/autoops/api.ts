import { aiApp } from "../app-ref";

/** Auto-ops routes, under /plugin-api/ai/tasks. */

export type TaskStatus =
  | "running"
  | "reported"
  | "proposed"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "done"
  | "failed"
  | "skipped";

export type Severity = "info" | "warning" | "critical";
export type Autonomy = "report" | "propose";

export interface TaskItem {
  id: number;
  userId: string;
  mine: boolean;
  automationId: number;
  presetId: string | null;
  title: string;
  autonomy: Autonomy;
  status: TaskStatus;
  severity: Severity | null;
  summary: string | null;
  hostIds: number[];
  dryRun: boolean;
  conversationId: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}

export interface StepResult {
  command: string;
  phase: "execute" | "verify";
  exitCode: number | null;
  output: string;
  error?: string;
}

export interface PlanHost {
  hostId: number;
  commands: string[];
  rationale: string;
  risk: string;
  rollback: string;
  verify: string[];
  results?: StepResult[];
  error?: string;
}

export interface TaskDetail extends TaskItem {
  trigger: { kind?: string; summary?: string; hostId?: number };
  report: string | null;
  plan: PlanHost[] | null;
  decidedBy: string | null;
  decidedAt: string | null;
  hostNames: Record<string, string>;
  canDecide: boolean;
}

export type HostSelector =
  | { kind: "all" }
  | { kind: "trigger" }
  | { kind: "host"; hostId: number }
  | { kind: "hosts"; hostIds: number[] }
  | { kind: "fleet"; fleetId: number };

export interface Preset {
  id: string;
  version: number;
  autonomy: Autonomy;
  trigger: Record<string, unknown> & { kind: string };
  hostSelector: HostSelector;
  maxRunSeconds: number;
  runbook: string;
  enabled: Array<{ automationId: number; version: number; name: string }>;
  updateAvailable: boolean;
  /** Saved presets only. */
  name?: string;
  description?: string | null;
  shared?: boolean;
  mine?: boolean;
}

export interface PresetList {
  automationsAvailable: boolean;
  presets: Preset[];
  custom: Preset[];
}

export interface TaskPreferences {
  providerId: number | null;
  model: string | null;
  language: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface LooseClient {
  get(url: string): Promise<{ data: any }>;
  delete(url: string): Promise<{ data: any }>;
  post(url: string, body?: unknown): Promise<{ data: any }>;
  put(url: string, body?: unknown): Promise<{ data: any }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const api = () => aiApp().api as unknown as LooseClient;

/** The server's message when there is one. */
export function apiMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown } } })
    ?.response?.data;
  if (typeof data?.error === "string" && data.error) return data.error;
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function listTasks(): Promise<{
  tasks: TaskItem[];
  approvals: TaskItem[];
}> {
  return (await api().get("tasks")).data;
}

export async function getTask(id: number): Promise<TaskDetail> {
  return (await api().get(`tasks/${id}`)).data.task;
}

export async function approveTask(id: number): Promise<void> {
  await api().post(`tasks/${id}/approve`);
}

export async function rejectTask(id: number): Promise<void> {
  await api().post(`tasks/${id}/reject`);
}

export async function listPresets(): Promise<PresetList> {
  return (await api().get("tasks/presets")).data;
}

export interface EnableInput {
  title: string;
  trigger: Record<string, unknown>;
  hostSelector: HostSelector;
  autonomy: Autonomy;
  runbook: string;
  maxRunSeconds: number;
}

export async function enablePreset(
  presetId: string,
  input: EnableInput,
): Promise<void> {
  await api().post(
    `tasks/presets/${encodeURIComponent(presetId)}/enable`,
    input,
  );
}

export async function savePreset(input: {
  name: string;
  description?: string;
  shared: boolean;
  config: Omit<EnableInput, "title">;
}): Promise<void> {
  await api().post("tasks/custom-presets", input);
}

export async function deletePreset(id: string): Promise<void> {
  await api().delete(`tasks/custom-presets/${id.replace("custom:", "")}`);
}

export async function getPreferences(): Promise<TaskPreferences> {
  return (await api().get("tasks/preferences")).data.preferences;
}

export async function savePreferences(
  changes: Partial<TaskPreferences>,
): Promise<TaskPreferences> {
  return (await api().put("tasks/preferences", changes)).data.preferences;
}
