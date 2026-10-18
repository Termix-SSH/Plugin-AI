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

/**
 * The trigger shapes of Automations' src/types.ts (Trigger, HostSelector,
 * MetricPath, Operator), so a preset cannot ship a trigger it would refuse
 * or misread. Every key must be one the shape knows.
 */
const METRIC_PATHS = [
  "cpu.percent",
  "cpu.load1",
  "cpu.load5",
  "cpu.load15",
  "memory.percent",
  "memory.usedGiB",
  "disk.percent",
  "disk.availableBytes",
  "temperature.highestCelsius",
  "uptime.seconds",
  "processes.total",
  "network.rxBytes",
  "network.txBytes",
  "network.rxRateBps",
  "network.txRateBps",
];
const OPERATORS = [
  ">",
  "<",
  ">=",
  "<=",
  "==",
  "!=",
  "contains",
  "not_contains",
  "changed",
];

type Shape = Record<string, (value: unknown) => boolean>;
const optional = (check: (value: unknown) => boolean) => (value: unknown) =>
  value === undefined || check(value);
const oneOf = (values: string[]) => (value: unknown) =>
  values.includes(value as string);
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown) => typeof value === "string" && value !== "";
const watched = (value: unknown) => {
  const selector = value as Record<string, unknown>;
  return ["all", "host", "hosts", "fleet"].includes(selector?.kind as string);
};

const TRIGGER_SHAPES: Record<string, Shape> = {
  metric_threshold: {
    hostSelector: watched,
    metric: (value) =>
      METRIC_PATHS.includes((value as { path?: string })?.path ?? ""),
    operator: oneOf(OPERATORS),
    value: (value) => typeof value === "number" && Number.isFinite(value),
    forSeconds: optional(number),
    cooldownMinutes: number,
    severity: optional(oneOf(["info", "warning", "critical"])),
  },
  host_status: {
    hostSelector: watched,
    to: oneOf(["online", "offline"]),
    cooldownMinutes: number,
  },
  health_check: {
    hostSelector: watched,
    checkId: optional(text),
    to: oneOf(["failing", "recovered"]),
    cooldownMinutes: number,
  },
  schedule: {
    cron: optional((value) => /^(\S+ ){4}\S+$/.test(String(value))),
    intervalSeconds: optional((value) => number(value) && Number(value) >= 60),
    timezone: optional(text),
  },
  docker_event: {
    hostSelector: watched,
    container: optional(text),
    event: oneOf(["exited", "started", "unhealthy", "restarting"]),
    cooldownMinutes: number,
  },
};

function triggerErrors(trigger: Record<string, unknown>): string[] {
  const shape = TRIGGER_SHAPES[trigger.kind as string];
  if (!shape) return [`unknown kind ${String(trigger.kind)}`];
  const errors = Object.keys(trigger)
    .filter((key) => key !== "kind" && !(key in shape))
    .map((key) => `unknown key ${key}`);
  for (const [key, check] of Object.entries(shape)) {
    if (!check(trigger[key])) errors.push(`bad ${key}`);
  }
  if (
    trigger.kind === "schedule" &&
    !trigger.cron &&
    !trigger.intervalSeconds
  ) {
    errors.push("schedule needs a cron or an interval");
  }
  return errors;
}

/** The runbook's commands with sample values for its placeholders. */
const sample = (command: string) =>
  command
    .replace(/<unit>/g, "nginx.service")
    .replace(/<name>/g, "web")
    .replace(/<pid>/g, "1234")
    .replace(/<port>/g, "443")
    .replace(/<path>/g, "/srv/app/data")
    .replace(/<directory>/g, "/srv/app")
    .replace(/<file>/g, "/etc/nginx/ssl/site.crt");

const preset = (id: string) => {
  const found = PRESETS.find((entry) => entry.id === id);
  if (!found) throw new Error(`No preset ${id}`);
  return found;
};

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
  it("are the shipped presets, in the Automations shapes, with time limits", () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([
      "daily-patrol",
      "disk-cleanup",
      "host-down-triage",
      "service-failure",
      "container-anomaly",
      "resource-overload-cpu",
      "resource-overload-memory",
      "security-updates-weekly",
      "cert-expiry-weekly",
    ]);
    for (const preset of PRESETS) {
      expect(preset.version).toBeGreaterThanOrEqual(1);
      expect(triggerErrors(preset.trigger), preset.id).toEqual([]);
      expect(applyOverrides(preset, {}), preset.id).toEqual({
        config: {
          autonomy: preset.autonomy,
          trigger: preset.trigger,
          hostSelector: preset.hostSelector,
          concurrencyPolicy: "skip",
          maxRunSeconds: preset.maxRunSeconds,
          runbook: preset.runbook,
        },
      });
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

  it("set the triggers, targets and levels of the newer presets", () => {
    expect(preset("service-failure")).toMatchObject({
      autonomy: "propose",
      trigger: { kind: "health_check", to: "failing" },
      hostSelector: { kind: "trigger" },
    });
    expect(preset("container-anomaly")).toMatchObject({
      autonomy: "propose",
      trigger: { kind: "docker_event", event: "exited" },
      hostSelector: { kind: "trigger" },
    });
    expect(preset("resource-overload-cpu")).toMatchObject({
      autonomy: "report",
      trigger: {
        metric: { path: "cpu.percent" },
        operator: ">=",
        value: 95,
        forSeconds: 900,
      },
      hostSelector: { kind: "trigger" },
    });
    expect(preset("resource-overload-memory")).toMatchObject({
      autonomy: "report",
      trigger: {
        metric: { path: "memory.percent" },
        operator: ">=",
        value: 95,
        forSeconds: 600,
      },
      hostSelector: { kind: "trigger" },
    });
    expect(preset("resource-overload-memory").runbook).toBe(
      preset("resource-overload-cpu").runbook,
    );
    expect(preset("security-updates-weekly")).toMatchObject({
      autonomy: "report",
      trigger: { kind: "schedule", cron: "30 9 * * 1" },
      hostSelector: { kind: "all" },
    });
    expect(preset("cert-expiry-weekly")).toMatchObject({
      autonomy: "report",
      trigger: { kind: "schedule", cron: "45 9 * * 1" },
      hostSelector: { kind: "all" },
    });
    // A container event can be picked in the enable form.
    expect(
      applyOverrides(preset("container-anomaly"), {
        trigger: { event: "unhealthy" },
      }),
    ).toMatchObject({
      config: { trigger: { kind: "docker_event", event: "unhealthy" } },
    });
  });

  it("only name read-only commands for the newer investigations", () => {
    const investigations: Record<string, string[]> = {
      "service-failure": [
        "systemctl list-units --type=service --state=failed,activating --no-pager --plain",
        "ss -tlnp",
        "systemctl status <pid> --no-pager -n 0",
        "systemctl status <unit> --no-pager -n 20",
        "journalctl -u <unit> -n 100 --no-pager",
        "systemctl list-units --state=failed --no-pager --plain",
        "df -hP",
        "df -iP",
        "stat <path>",
        "ls -ld <directory>",
        "journalctl -k --since -2h -g oom --no-pager -n 20",
        "journalctl -k --since -2h -p warning --no-pager -n 50",
        "systemctl is-active <unit>",
        "nc -z -w 3 127.0.0.1 <port>",
        "id -u",
      ],
      "container-anomaly": [
        "docker inspect --format '{{.Name}} restarts={{.RestartCount}} memory={{.HostConfig.Memory}} policy={{.HostConfig.RestartPolicy.Name}} {{json .State}}' <name>",
        "docker ps -a --format '{{.Names}} {{.Status}}'",
        "docker logs --tail 200 --timestamps <name>",
        "docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.MemPerc}}' <name>",
        "journalctl -k --since -24h -g oom --no-pager -n 20",
        "journalctl -k --since -24h -p warning --no-pager -n 50",
        "df -hP",
        "free -m",
        "docker ps -a --filter name=<name> --format '{{.Names}} {{.Status}}'",
        "docker inspect --format '{{.State.Status}} {{json .State.Health}}' <name>",
        "id -u",
      ],
      "resource-overload-cpu": [
        "uptime",
        "free -m",
        "vmstat 1 5",
        "cat /proc/pressure/cpu",
        "cat /proc/pressure/memory",
        "cat /proc/pressure/io",
        "top -b -n 1 -o %CPU",
        "ps -eo pid,user,%mem,rss,etime,comm --sort=-rss",
        "ps -o pid,args -p <pid>,<pid>,<pid>",
        "systemctl status <pid> --no-pager -n 0",
        "docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.MemPerc}}'",
        "journalctl -k --since -24h -g oom --no-pager -n 20",
        "journalctl -k --since -24h -p warning --no-pager -n 50",
        "iostat -x 1 2",
      ],
      "security-updates-weekly": [
        "dnf updateinfo summary",
        "yum updateinfo summary",
        "dnf updateinfo list --security --sec-severity Critical",
        "dnf updateinfo list --security --sec-severity Important",
        "apt list --upgradable",
        "cat /var/run/reboot-required.pkgs",
        "test -f /var/run/reboot-required",
        "dnf needs-restarting -r",
        "uname -r",
        "find /boot -maxdepth 1 -name 'vmlinuz-*'",
        "stat -L -c '%y %n' /var/lib/dpkg/status /var/cache/apt/pkgcache.bin /var/lib/rpm/rpmdb.sqlite /var/lib/rpm/Packages /usr/lib/sysimage/rpm/rpmdb.sqlite",
      ],
      "cert-expiry-weekly": [
        "find /etc/letsencrypt/live -mindepth 2 -maxdepth 2 -name cert.pem",
        "find /etc/nginx /etc/caddy /etc/apache2 /etc/httpd -maxdepth 3 -name '*.crt' -o -name '*.pem'",
        "find /etc/traefik /opt /srv /var/lib/docker/volumes -maxdepth 4 -name acme.json",
        "openssl x509 -noout -enddate -subject -checkend 2592000 -in <file>",
        "openssl x509 -noout -enddate -subject -checkend 2592000 -in /etc/kubernetes/pki/apiserver.crt",
        "openssl x509 -noout -enddate -subject -checkend 2592000 -in /var/lib/rancher/k3s/server/tls/serving-kube-apiserver.crt",
      ],
    };
    for (const [id, commands] of Object.entries(investigations)) {
      const runbook = preset(id).runbook;
      for (const command of commands) {
        // The fixed certificate paths and the Important listing are filled in.
        if (!/kubernetes|k3s|Important/.test(command)) {
          expect(runbook, `${id}: ${command}`).toContain(`\`${command}\``);
        }
        expect(
          isReadOnlyCommand(sample(command)).allowed,
          `${id}: ${command}`,
        ).toBe(true);
      }
    }
  });

  it("keep the newer runbooks to their limits", () => {
    const service = preset("service-failure").runbook;
    expect(service).toContain("`systemctl restart <unit>`, exactly once");
    expect(service).toContain("`systemctl reset-failed <unit>`");
    expect(service).toMatch(
      /Never propose: editing, moving or deleting any file; systemctl edit, daemon-reload, stop, kill, disable, mask/,
    );
    expect(service).toMatch(/reboot, shutdown or poweroff/);
    expect(isReadOnlyCommand(sample("systemctl restart <unit>")).allowed).toBe(
      false,
    );

    const container = preset("container-anomaly").runbook;
    expect(container).toContain("with exactly one of these");
    expect(container).toContain("`docker start <name>`");
    expect(container).toContain("`docker restart <name>`");
    expect(container).toMatch(
      /Never propose: docker rm, rmi, kill, stop, update, rename, prune, volume/,
    );
    expect(container).toMatch(
      /docker compose in any form; editing compose files/,
    );
    for (const command of ["docker start <name>", "docker restart <name>"]) {
      expect(isReadOnlyCommand(sample(command)).allowed).toBe(false);
    }

    for (const id of [
      "resource-overload-cpu",
      "security-updates-weekly",
      "cert-expiry-weekly",
    ]) {
      expect(preset(id).runbook, id).toMatch(
        /Investigate only and change nothing/,
      );
      expect(preset(id).runbook, id).not.toContain("propose_plan");
    }
    expect(preset("resource-overload-cpu").runbook).toMatch(
      /never kill, renice, restart or stop anything/,
    );
    expect(preset("security-updates-weekly").runbook).toMatch(
      /never install, upgrade, refresh package lists or reboot/,
    );
    expect(preset("security-updates-weekly").runbook).toMatch(
      /at most 10 hosts per call/,
    );

    const certs = preset("cert-expiry-weekly").runbook;
    expect(certs).toMatch(/Never read private keys or acme.json/);
    expect(certs).toMatch(/never inspect the system CA store/);
    expect(certs).toMatch(/Live TLS ports are not checked/);
    expect(certs).toMatch(/Critical: under 7 days/);
    expect(certs).toMatch(/Warning: under 30 days/);
    expect(
      isReadOnlyCommand(
        "openssl s_client -connect 127.0.0.1:443 -servername example.com",
      ).allowed,
    ).toBe(false);
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
