import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import {
  createAnnotationService,
  knownSystems,
  withSystems,
  type AnnotationService,
} from "../../../src/backend/assets/annotate";
import {
  createAssetRepository,
  type AssetRepository,
} from "../../../src/backend/assets/repository";
import {
  createAssetService,
  type AssetService,
} from "../../../src/backend/assets/service";
import { createModelInfoCache } from "../../../src/backend/model-info";
import { createAiRepository } from "../../../src/backend/repository";
import { fakeSshClient, type FakePlan } from "../ops/fake-ssh";
import { manifest, pluginDir } from "../helpers";
import { sse, text, toolCall } from "../tasks/fixtures";
import { BARE_HOST, FULL_HOST, pveHost, scriptOutput } from "./fixtures";

const HOSTS = [
  { id: 1, name: "web-1", ip: "10.0.0.1", folder: "Shop", tags: "prod" },
  { id: 2, name: "db-1", ip: "10.0.0.2" },
  { id: 3, name: "pve1", ip: "10.0.0.3" },
  { id: 7, name: "k3s-master-1", ip: "10.0.0.7" },
];

const OUTPUTS = new Map<number, FakePlan>([
  [1, { stdout: FULL_HOST }],
  [2, { stdout: BARE_HOST }],
  [3, { stdout: pveHost("10.0.0.3") }],
  [7, { stdout: BARE_HOST }],
]);

interface ModelBody {
  messages: Array<{ role: string; content: string }>;
}

type Reply = (keys: string[], body: ModelBody) => Response;

/** Annotates every [key] of the batch it is sent, as `reply` says. */
function fakeAnnotator(reply?: Reply) {
  const bodies: ModelBody[] = [];
  const fetch = async (_url: string, init?: unknown) => {
    const raw = (init as { body?: string } | undefined)?.body;
    // Model details are looked up first, without a body.
    if (!raw) return new Response("{}", { status: 404 });
    const body = JSON.parse(raw) as ModelBody;
    bodies.push(body);
    if (body.messages.some((message) => message.role === "tool")) {
      return sse(text("Done."));
    }
    const user = body.messages.find((message) => message.role === "user")!;
    const keys = [...user.content.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
    if (reply) return reply(keys, body);
    return sse(
      toolCall("submit_annotations", {
        annotations: keys.map((key) => ({
          key,
          role: `role of ${key}`,
          importance: key === "host:2" ? "critical" : "medium",
          importanceReason: "Others connect to it.",
          system: key.startsWith("container:") ? "shop" : "",
        })),
      }),
    );
  };
  return { fetch, bodies };
}

interface Setup {
  db: TestDb;
  mock: MockPluginContext;
  repo: AssetRepository;
  assets: AssetService;
  annotation: AnnotationService;
}

let current: Setup | null = null;

afterEach(() => {
  current?.assets.close();
  current?.annotation.close();
  current?.db.close();
  current = null;
});

async function setup(
  model: ReturnType<typeof fakeAnnotator>,
  options: { provider?: boolean; settings?: Record<string, unknown> } = {},
): Promise<Setup> {
  const db = await createTestDb(pluginDir);
  db.sqlite
    .prepare("INSERT INTO users (id, username) VALUES ('user-1', 'u')")
    .run();
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => express.Router(),
    permissions: ["ai.assets.view", "ai.assets.manage"],
    fetch: model.fetch as never,
    settings: {
      globallyEnabled: true,
      assetsCollector: "user-1",
      ...options.settings,
    },
    hosts: HOSTS.map((host) => ({
      folder: null,
      tags: null,
      ...host,
      userId: "user-1",
      port: 22,
      username: "root",
      authType: "password",
    })),
  });
  await mock.ctx.settings.setUser("user-1", "enabled", true);
  const ctx = {
    ...mock.ctx,
    ssh: {
      ...mock.ctx.ssh,
      withConnection: async (
        hostId: number,
        _options: unknown,
        fn: (client: unknown) => Promise<unknown>,
      ) => fn(fakeSshClient(() => OUTPUTS.get(hostId)!).client),
    },
  } as unknown as PluginContext;
  const repository = await createAiRepository(ctx);
  if (options.provider !== false) {
    await mock.actAs("user-1", () =>
      repository.createProvider("user-1", {
        providerType: "openai",
        // The mock speaks Chat Completions; official OpenAI uses the Responses API.
        baseUrl: "https://llm.example/v1",
        label: "Work",
        apiKey: "sk-test",
        defaultModel: "gpt-5",
      }),
    );
  }
  const repo = await createAssetRepository(ctx);
  const annotation = createAnnotationService({
    ctx,
    assets: repo,
    repository,
    modelInfo: createModelInfoCache(),
    collector: async () => "user-1",
  });
  const assets = createAssetService(ctx, repo, {
    afterCollect: () => annotation.afterCollect(),
  });
  current = { db, mock, repo, assets, annotation };
  return current;
}

/** Collects, which annotates afterwards, and waits for both. */
async function collect(s: Setup) {
  s.assets.requestFull("manual");
  await s.assets.idle();
  await s.annotation.idle();
}

async function annotate(s: Setup, all = false) {
  s.annotation.request("manual", all);
  await s.annotation.idle();
}

const find = async (s: Setup, key: string) => (await s.repo.findByKey(key))!;

const lastRun = async (s: Setup) => (await s.repo.listRuns(1, "annotate"))[0];

const usageRows = (s: Setup) =>
  s.db.sqlite
    .prepare("SELECT source, prompt_tokens FROM p_ai_usage")
    .all() as Array<{ source: string; prompt_tokens: number }>;

describe("asset annotation", () => {
  it("annotates every asset after a collection, as the collector, and records the run", async () => {
    const model = fakeAnnotator();
    const s = await setup(model);
    await collect(s);

    const run = await lastRun(s);
    expect(run).toMatchObject({
      kind: "annotate",
      trigger: "collection",
      status: "done",
      errorSummary: null,
    });
    expect(run.hostsOk).toBe(run.hostsTotal);
    expect(run.tokens).toBeGreaterThan(0);

    expect(await find(s, "host:2")).toMatchObject({
      role: "role of host:2",
      roleSource: "ai",
      importance: "critical",
      importanceSource: "ai",
      importanceReason: "Others connect to it.",
      system: null,
      systemSource: "ai",
    });
    const container = await find(s, "container:1/app-db");
    expect(container).toMatchObject({ system: "shop", importance: "medium" });
    expect(container.annotationFingerprint).toMatch(/^[0-9a-f]{32}$/);
    // The collection runs list stays the collector's.
    expect((await s.repo.listRuns()).every((r) => r.kind === "collect")).toBe(
      true,
    );

    // All accepted at once: no batch was sent twice.
    expect(
      model.bodies.some((b) => b.messages.some((m) => m.role === "tool")),
    ).toBe(false);
    // Every model call is counted as asset usage.
    expect(usageRows(s).length).toBe(model.bodies.length);
    expect(usageRows(s).every((row) => row.source === "assets")).toBe(true);

    // Hosts and their containers share a call; nothing external is sent.
    const sent = model.bodies.map(
      (body) => body.messages.find((m) => m.role === "user")!.content,
    );
    expect(sent.join("\n")).toContain("[container:1/app-db]");
    expect(sent.join("\n")).not.toMatch(/\[external:|93\.184\.216\.34/);
    expect(sent.join("\n")).toContain("termix: folder=Shop tags=prod");
    const system = model.bodies[0].messages.find((m) => m.role === "system");
    expect(system?.content ?? "").toContain("in English");
  });

  it("sends nothing again until something changes, then the asset and its neighbours", async () => {
    const model = fakeAnnotator();
    const s = await setup(model);
    await collect(s);
    const calls = model.bodies.length;

    await annotate(s);
    expect(model.bodies.length).toBe(calls);
    expect(await lastRun(s)).toMatchObject({ status: "done", hostsTotal: 0 });

    // k3s-master-1 starts running k3s: it changed, and pve1, its node, is
    // its only neighbour.
    OUTPUTS.set(7, {
      stdout: scriptOutput({ os: 'NAME="Alpine Linux"', k8s: "k3s active" }),
    });
    try {
      await collect(s);
    } finally {
      OUTPUTS.set(7, { stdout: BARE_HOST });
    }
    const sent = model.bodies
      .slice(calls)
      .map((body) => body.messages.find((m) => m.role === "user")!.content)
      .join("\n");
    expect(sent).toContain("[host:7]");
    expect(sent).toContain("[host:3]");
    expect(sent).not.toContain("[host:1]");

    await annotate(s, true);
    expect(await lastRun(s)).toMatchObject({ status: "done" });
    expect((await lastRun(s)).hostsTotal).toBeGreaterThan(5);
  });

  it("records progress after every batch, not only at the end", async () => {
    const model = fakeAnnotator();
    const s = await setup(model);
    await collect(s);
    const progress = vi.spyOn(s.repo, "progressRun");
    await annotate(s, true);
    expect(progress).toHaveBeenCalled();
    const [, last] = progress.mock.calls.at(-1)!;
    expect(last.hostsOk).toBeGreaterThan(0);
    expect(last.tokens).toBeGreaterThan(0);
  });

  it("tells later runs which system names exist", async () => {
    // Batches did not see each other's names: one system came back as
    // "OpenXDR" and "openxdr".
    const model = fakeAnnotator();
    const s = await setup(model);
    await collect(s);
    const before = model.bodies.length;
    await annotate(s, true);
    const sent = model.bodies
      .slice(before)
      .map((body) => body.messages.find((m) => m.role === "user")!.content);
    expect(sent[0]).toMatch(/^Systems already named in this inventory: shop\./);
  });

  it("never overwrites what a user set, until it is unlocked", async () => {
    const model = fakeAnnotator();
    const s = await setup(model);
    await collect(s);
    const web = await find(s, "host:1");
    await s.repo.setUserAnnotation(web.id, {
      role: "Shop front end",
      system: "shop",
    });

    await annotate(s, true);
    expect(await find(s, "host:1")).toMatchObject({
      role: "Shop front end",
      roleSource: "user",
      system: "shop",
      systemSource: "user",
      importance: "medium",
      importanceSource: "ai",
    });

    await s.repo.unlockAnnotation(web.id, "role");
    const unlocked = await find(s, "host:1");
    expect(unlocked).toMatchObject({
      role: "Shop front end",
      roleSource: null,
    });
    expect(unlocked.annotationFingerprint).toBeNull();
    await annotate(s);
    expect(await find(s, "host:1")).toMatchObject({
      role: "role of host:1",
      roleSource: "ai",
      system: "shop",
      systemSource: "user",
    });
  });

  it("writes depends_on with evidence as AI edges and rejects the rest", async () => {
    const model = fakeAnnotator((keys) =>
      sse(
        toolCall("submit_annotations", {
          annotations: keys.map((key) => ({
            key,
            role: "x",
            // One bad entry earns the batch its one retry turn.
            importance: key === "host:1" ? "huge" : "low",
            importanceReason: "y",
          })),
          depends_on: keys.includes("host:1")
            ? [
                {
                  from: "host:1",
                  to: "host:2",
                  evidence: {
                    type: "connects_to",
                    port: 5432,
                    fact: "outbound: db-1 [host:2] tcp/5432 (app)",
                  },
                },
                {
                  from: "host:1",
                  to: "host:3",
                  evidence: { type: "connects_to", fact: "guess" },
                },
                {
                  from: "host:1",
                  to: "host:404",
                  evidence: { type: "runs_on", fact: "x" },
                },
              ]
            : [],
        }),
      ),
    );
    const s = await setup(model);
    await collect(s);

    const web = await find(s, "host:1");
    const db = await find(s, "host:2");
    const dependsOn = await s.repo.listEdges({ type: "depends_on" });
    expect(dependsOn).toEqual([
      expect.objectContaining({
        fromAsset: web.id,
        toAsset: db.id,
        source: "ai",
        evidence: "connects_to 5432: outbound: db-1 [host:2] tcp/5432 (app)",
      }),
    ]);
    // The model was told what was rejected, in its one retry turn.
    const retry = model.bodies.find((body) =>
      body.messages.some((m) => m.role === "tool"),
    );
    const answer = retry?.messages.find((m) => m.role === "tool")?.content;
    expect(answer).toContain("no such connects_to was observed");
    expect(answer).toContain("host:1: importance must be one of");
    expect(
      model.bodies.filter((b) => b.messages.some((m) => m.role === "tool")),
    ).toHaveLength(1);
  });

  it("fails clearly without a provider", async () => {
    const s = await setup(fakeAnnotator(), { provider: false });
    await collect(s);
    expect(await lastRun(s)).toMatchObject({
      status: "failed",
      errorSummary: {
        run: "No AI provider: the collector has no enabled provider with a model",
      },
    });
    expect(s.mock.notifications.at(-1)?.notification).toMatchObject({
      category: "ai.assets_annotation_failed",
      audience: { userId: "user-1" },
    });
  });

  it("refuses while auto-ops is paused, and stops at the token budget", async () => {
    const paused = await setup(fakeAnnotator(), {
      settings: { autoOpsPaused: true },
    });
    await collect(paused);
    expect(await lastRun(paused)).toMatchObject({
      status: "failed",
      errorSummary: { run: "AI auto-ops is paused" },
    });
    paused.assets.close();
    paused.annotation.close();
    paused.db.close();
    current = null;

    const model = fakeAnnotator();
    const s = await setup(model, {
      settings: { assetsAnnotateRunTokens: 1 },
    });
    await collect(s);
    const run = await lastRun(s);
    expect(run.status).toBe("failed");
    expect(run.errorSummary?.run).toContain("token budget");
    expect(model.bodies).toHaveLength(1);
  });

  it("does not annotate after a collection when turned off", async () => {
    const model = fakeAnnotator();
    const s = await setup(model, {
      settings: { assetsAnnotateAfterCollect: false },
    });
    await collect(s);
    expect(await s.repo.listRuns(5, "annotate")).toEqual([]);
    expect(model.bodies).toEqual([]);
  });
});

describe("known systems", () => {
  it("lists the most used first, once each", () => {
    const assets = [
      { system: "shop" },
      { system: null },
      { system: "crm" },
      { system: "shop" },
    ];
    expect(knownSystems(assets)).toEqual(["shop", "crm"]);
    expect(withSystems("[host:1]", [])).toBe("[host:1]");
    expect(withSystems("[host:1]", ["shop"])).toContain("shop.");
  });
});
