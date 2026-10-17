import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../locales/en.json";
import zhCN from "../../../locales/translated/zh_CN.json";
import zhTW from "../../../locales/translated/zh_TW.json";
import { applyOverrides, PRESETS } from "../../../src/backend/tasks/presets.js";
import { isReadOnlyCommand } from "../../../src/backend/tools/command-allowlist.js";
import { startServer, type TestServer } from "../helpers";
import { OPS_PERMISSIONS } from "./fixtures";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const AUTOMATION_TRIGGERS = ["schedule", "metric_threshold", "host_status"];

function automationsMock() {
  const created: Array<Record<string, unknown>> = [];
  const existing = new Map<number, { id: number; name: string }>();
  const access = {
    list: async () => [],
    get: async (id: number) => existing.get(id) ?? null,
    create: vi.fn(async (input: Record<string, unknown>) => {
      const id = created.length + 1;
      created.push(input);
      existing.set(id, { id, name: String(input.name) });
      return { id, name: String(input.name) };
    }),
  };
  return { access, created, existing };
}

async function start(
  options: { permissions?: string[]; automations?: object | null } = {},
) {
  const automations =
    options.automations === undefined
      ? automationsMock().access
      : options.automations;
  server = await startServer({
    permissions: options.permissions ?? OPS_PERMISSIONS,
    services: automations ? { "automations.access": automations } : {},
  });
  await server.enableFor("user-1");
  await server.enableFor("user-2");
  return server;
}

describe("shipped presets", () => {
  it("are the three presets, in the Automations shapes, with time limits", () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([
      "daily-patrol",
      "disk-cleanup",
      "host-down-triage",
    ]);
    for (const preset of PRESETS) {
      expect(preset.version).toBeGreaterThanOrEqual(1);
      expect(AUTOMATION_TRIGGERS).toContain(preset.trigger.kind);
      expect(preset.concurrencyPolicy).toBe("skip");
      expect(preset.maxRunSeconds).toBeGreaterThan(300);
      expect(preset.runbook.length).toBeGreaterThan(200);
      for (const locale of [en, zhCN, zhTW]) {
        const strings = (
          locale.autoOps.presets as Record<
            string,
            { title: string; description: string }
          >
        )[preset.id];
        expect(strings.title).toBeTruthy();
        expect(strings.description).toBeTruthy();
      }
    }
    const [patrol, disk, down] = PRESETS;
    expect(patrol).toMatchObject({
      autonomy: "report",
      trigger: { kind: "schedule", cron: "0 9 * * *" },
      hostSelector: { kind: "all" },
    });
    expect(disk).toMatchObject({
      autonomy: "propose",
      trigger: {
        kind: "metric_threshold",
        hostSelector: { kind: "all" },
        metric: { path: "disk.percent" },
        operator: ">=",
        value: 85,
        forSeconds: 300,
      },
      hostSelector: { kind: "trigger" },
    });
    expect(down).toMatchObject({
      autonomy: "report",
      trigger: { kind: "host_status", to: "offline" },
    });
  });

  it("only name read-only commands for their investigations", () => {
    for (const command of [
      "df -hP",
      "df -iP",
      "free -m",
      "uptime",
      "systemctl list-units --state=failed --no-pager --plain",
      "docker ps -a --format '{{.Names}} {{.Status}}'",
      "test -d /etc/letsencrypt/live",
      "find /etc/letsencrypt/live -name cert.pem",
      "openssl x509 -noout -enddate -in /etc/letsencrypt/live/a/cert.pem",
      "apt list --upgradable",
      "dnf check-update -q",
      "yum check-update -q",
      "test -f /var/run/reboot-required",
      "needrestart -b",
      "timedatectl show",
      "du -xh --max-depth=2 /var",
      "docker system df",
      "journalctl --disk-usage",
      "du -sh /var/cache/apt/archives",
      "find /var/log -type f -name '*.gz' -mtime +7 -ls",
      "id -u",
      "ping -c 3 -W 2 10.0.0.5",
      "nc -z -w 3 10.0.0.5 22",
      "qm list",
      "pct list",
      "qm status 101",
      "pct status 101",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
  });

  it("keeps the cleanup runbook to its safe actions", () => {
    const runbook = PRESETS[1].runbook;
    expect(runbook).toContain("docker image prune -f");
    expect(runbook).toContain("journalctl --vacuum-time=7d");
    expect(runbook).toMatch(/Never propose: docker system prune/);
    expect(runbook).toMatch(/\/home/);
  });

  it("applies the enable form's changes, keeping the trigger kind", () => {
    const disk = PRESETS[1];
    const result = applyOverrides(disk, {
      trigger: { kind: "schedule", value: 90 },
      autonomy: "report",
    });
    expect(result).toMatchObject({
      config: { trigger: { kind: "metric_threshold", value: 90 } },
    });
    expect(
      applyOverrides(PRESETS[0], { hostSelector: { kind: "trigger" } }),
    ).toHaveProperty("error");
    expect(applyOverrides(disk, { autonomy: "auto" })).toHaveProperty("error");
  });
});

describe("preset routes", () => {
  it("say presets need Automations while it is missing", async () => {
    const target = await start({ automations: null });
    const reply = await target.request("GET", "/tasks/presets");
    expect(reply.body.automationsAvailable).toBe(false);
    const enable = await target.request(
      "POST",
      "/tasks/presets/daily-patrol/enable",
      { body: {} },
    );
    expect(enable.status).toBe(503);
  });

  it("need ai.ops.use", async () => {
    const target = await start({ permissions: ["ai.use"] });
    expect((await target.request("GET", "/tasks/presets")).status).toBe(403);
    expect(
      (
        await target.request("POST", "/tasks/presets/daily-patrol/enable", {
          body: {},
        })
      ).status,
    ).toBe(403);
  });

  it("enable a preset as an automation with one ai_task step", async () => {
    const automations = automationsMock();
    const target = await start({ automations: automations.access });
    const reply = await target.request(
      "POST",
      "/tasks/presets/disk-cleanup/enable",
      {
        body: {
          name: "Disk cleanup",
          title: "Disk cleanup",
          trigger: { value: 90 },
          autonomy: "propose",
        },
      },
    );
    expect(reply.status).toBe(201);
    const [input] = automations.created;
    expect(input).toMatchObject({
      name: "Disk cleanup",
      enabled: true,
      concurrencyPolicy: "skip",
      maxRunSeconds: 900,
      definition: {
        version: 1,
        trigger: { kind: "metric_threshold", value: 90, forSeconds: 300 },
        steps: [
          {
            type: "ai_task",
            runbook: PRESETS[1].runbook,
            autonomy: "propose",
            hostSelector: { kind: "trigger" },
            presetId: "disk-cleanup",
            title: "Disk cleanup",
          },
        ],
      },
    });

    const list = await target.request("GET", "/tasks/presets");
    const disk = list.body.presets.find(
      (preset: { id: string }) => preset.id === "disk-cleanup",
    );
    expect(disk.enabled).toEqual([
      { automationId: 1, version: 1, name: "Disk cleanup" },
    ]);
    expect(disk.updateAvailable).toBe(false);
  });

  it("name the automation after the preset's title in the user's language", async () => {
    const automations = automationsMock();
    const target = await start({ automations: automations.access });
    await target.request("POST", "/tasks/presets/daily-patrol/enable", {
      body: {},
    });
    await target.request("PUT", "/tasks/preferences", {
      body: { language: "zh-CN" },
    });
    await target.request("POST", "/tasks/presets/disk-cleanup/enable", {
      body: {},
    });
    // A title from the form names it too; a name from the API wins.
    await target.request("POST", "/tasks/presets/host-down-triage/enable", {
      body: { title: "k3s 掉线" },
    });
    await target.request("POST", "/tasks/presets/daily-patrol/enable", {
      body: { name: "Morning check" },
    });
    // A language without a copy reads English.
    await target.request("PUT", "/tasks/preferences", {
      body: { language: "de_DE" },
    });
    await target.request("POST", "/tasks/presets/daily-patrol/enable", {
      body: {},
    });
    const named = automations.created.map((input) => ({
      name: input.name,
      title: (input.definition as { steps: Array<{ title: string }> }).steps[0]
        .title,
    }));
    expect(named).toEqual([
      { name: "AI · Daily patrol", title: "Daily patrol" },
      { name: "AI · 磁盘空间处理", title: "磁盘空间处理" },
      { name: "AI · k3s 掉线", title: "k3s 掉线" },
      { name: "Morning check", title: "每日巡检" },
      { name: "AI · Daily patrol", title: "Daily patrol" },
    ]);
  });

  it("show an update when an automation came from an older version", async () => {
    const automations = automationsMock();
    automations.existing.set(5, { id: 5, name: "Old patrol" });
    const target = await start({ automations: automations.access });
    target.db.sqlite
      .prepare(
        "INSERT INTO p_ai_preset_links (user_id, preset_id, preset_version, automation_id) VALUES (?, ?, ?, ?)",
      )
      .run("user-1", "daily-patrol", 0, 5);
    target.db.sqlite
      .prepare(
        "INSERT INTO p_ai_preset_links (user_id, preset_id, preset_version, automation_id) VALUES (?, ?, ?, ?)",
      )
      .run("user-1", "host-down-triage", 1, 404);
    const list = await target.request("GET", "/tasks/presets");
    const byId = Object.fromEntries(
      list.body.presets.map((preset: { id: string }) => [preset.id, preset]),
    );
    expect(byId["daily-patrol"].updateAvailable).toBe(true);
    // Deleted in Automations: no longer enabled.
    expect(byId["host-down-triage"].enabled).toEqual([]);
  });

  it("pass on what Automations refuses", async () => {
    const target = await start({
      automations: {
        ...automationsMock().access,
        create: async () => {
          throw new Error('Unknown step type "ai_task"');
        },
      },
    });
    const reply = await target.request(
      "POST",
      "/tasks/presets/daily-patrol/enable",
      { body: {} },
    );
    expect(reply.status).toBe(400);
    expect(reply.body.error).toMatch(/ai_task/);
  });

  it("save, share and delete custom presets", async () => {
    const automations = automationsMock();
    const target = await start({ automations: automations.access });
    const config = { ...PRESETS[0], runbook: "Check k3s nodes." };
    const saved = await target.request("POST", "/tasks/custom-presets", {
      body: { name: "k3s patrol", shared: true, config },
    });
    expect(saved.status).toBe(201);
    const id = saved.body.preset.id as string;
    expect(id).toMatch(/^custom:\d+$/);

    const seen = await target.request("GET", "/tasks/presets", {
      user: "user-2",
    });
    expect(seen.body.custom).toEqual([
      expect.objectContaining({ id, name: "k3s patrol", mine: false }),
    ]);

    const enabled = await target.request(
      "POST",
      `/tasks/presets/${id}/enable`,
      { user: "user-2", body: { name: "k3s" } },
    );
    expect(enabled.status).toBe(201);
    expect(automations.created[0]).toMatchObject({
      name: "k3s",
      definition: {
        steps: [
          { runbook: "Check k3s nodes.", presetId: id, title: "k3s patrol" },
        ],
      },
    });

    const numeric = id.replace("custom:", "");
    expect(
      (
        await target.request("DELETE", `/tasks/custom-presets/${numeric}`, {
          user: "user-2",
        })
      ).status,
    ).toBe(404);
    expect(
      (await target.request("DELETE", `/tasks/custom-presets/${numeric}`))
        .status,
    ).toBe(200);
  });

  it("keep a private preset to its creator", async () => {
    const target = await start();
    await target.request("POST", "/tasks/custom-presets", {
      body: { name: "mine", config: PRESETS[0] },
    });
    const seen = await target.request("GET", "/tasks/presets", {
      user: "user-2",
    });
    expect(seen.body.custom).toEqual([]);
  });

  it("save task preferences", async () => {
    const target = await start();
    expect(
      (
        await target.request("PUT", "/tasks/preferences", {
          body: { providerId: 99 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await target.request("PUT", "/tasks/preferences", {
          body: { language: "../etc" },
        })
      ).status,
    ).toBe(400);
    const saved = await target.request("PUT", "/tasks/preferences", {
      body: { language: "zh_TW", model: "gpt-5-mini" },
    });
    expect(saved.body.preferences).toEqual({
      providerId: null,
      model: "gpt-5-mini",
      language: "zh_TW",
    });
  });
});
