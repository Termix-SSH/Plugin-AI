import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkCliArgs,
  checkReadOnlyCliArgs,
  redactCliArgs,
  requestToken,
  runCli,
  type CliTarget,
} from "../../../src/backend/ops/cli.js";
import { spawnRun, writeFakeCli } from "./fake-cli";

const cliPath = writeFakeCli();

function target(run: CliTarget["run"] = spawnRun): CliTarget {
  return {
    run,
    cliPath,
    url: "http://127.0.0.1:30001",
    token: async () => "jwt-1",
  };
}

const limits = (overrides: Partial<Parameters<typeof runCli>[2]> = {}) => ({
  timeoutMs: 10_000,
  outputLimit: 20_000,
  signal: new AbortController().signal,
  ...overrides,
});

afterEach(() => {
  delete process.env.FAKE_SERVER_SECRET;
});

describe("checkCliArgs", () => {
  it.each([
    [["ssh", "4"], "ssh"],
    [["login"], "login"],
    [["--json", "logout"], "logout"],
    [["tunnel", "start", "1", "0"], "tunnel start"],
    [["files", "get", "1", "/etc/hosts"], "files get"],
    [["files", "put", "./a", "1:/tmp/a"], "files put"],
    [["hosts", "import", "hosts.json"], "hosts import"],
    [["hosts", "export"], "hosts export"],
    [["api-keys", "create", "--name", "x"], "api-keys create"],
  ])("refuses %j", (args, named) => {
    expect(checkCliArgs(args, true)).toContain(`termix ${named} `);
  });

  it.each([
    ["--url", "http://elsewhere"],
    ["--url=http://elsewhere"],
    ["--api-key", "tmx_x"],
    ["--insecure"],
    ["--key-file", "/root/.ssh/id_rsa"],
    ["--data-file", "/etc/shadow"],
    ["--content-file=/etc/passwd"],
    ["--output", "/tmp/out.json"],
    ["--password-stdin"],
  ])("refuses the flag in %j", (...flag) => {
    expect(checkCliArgs(["hosts", "list", ...flag], true)).toMatch(/^--/);
  });

  it.each([
    ["/host/db/hosts/export"],
    ["/database/export"],
    ["/admin/export/user-1"],
    ["/plugin-api/x/export?all=1"],
    ["/credentials/5"],
    ["/credentials/5/?x=1"],
    ["/host/db/host/3/password"],
    ["/host/db/host/3/local-connection-auth"],
    ["/users/me/token"],
    ["/sync/v2/changes?cursor=0"],
    ["credentials/5"],
    ["sync/v2/changes"],
    ["host/db/hosts/export"],
  ])("refuses the secret route %s through api", (route) => {
    expect(checkCliArgs(["api", "GET", route], true)).toContain(
      "return secrets",
    );
  });

  it.each([
    ["/credentials"],
    ["/credentials/folders"],
    ["/credentials/5/hosts"],
  ])("lets the credential route %s through api", (route) => {
    expect(checkCliArgs(["api", "GET", route], true)).toBeNull();
  });

  it("lets help through for every command, and ordinary commands", () => {
    expect(checkCliArgs(["ssh", "--help"], true)).toBeNull();
    expect(checkCliArgs(["help", "tunnel"], true)).toBeNull();
    expect(checkCliArgs(["tunnel", "start", "-h"], true)).toBeNull();
    expect(checkCliArgs(["hosts", "list"], true)).toBeNull();
    expect(checkCliArgs(["tunnel", "list"], true)).toBeNull();
    expect(checkCliArgs(["files", "cat", "1", "/etc/hosts"], true)).toBeNull();
    expect(checkCliArgs(["api", "GET", "/version"], true)).toBeNull();
    expect(checkCliArgs(["api", "GET", "/exports-list"], true)).toBeNull();
    expect(checkCliArgs(["hosts", "export", "--help"], true)).toBeNull();
    expect(checkCliArgs([], true)).toContain("empty");
  });

  it.each([
    [["exec", "1", "uptime"]],
    [["--json", "exec", "1", "rm", "-rf", "/tmp/x"]],
    [["fleets", "exec", "3", "uptime"]],
    [["snippets", "run", "4", "--host", "1"]],
    [["api", "POST", "/plugin-api/snippets/execute", "--data", "{}"]],
    [["api", "POST", "/plugin-api/fleets/3/execute"]],
    [["api", "POST", "/plugin-api/docker/1/c1/exec?tty=0"]],
  ])("refuses %j without a shell on hosts", (args) => {
    expect(checkCliArgs(args, false)).toContain("ai.ops.use");
    expect(checkCliArgs(args, true)).toBeNull();
  });

  it("lets the rest through without a shell on hosts", () => {
    expect(checkCliArgs(["hosts", "list"], false)).toBeNull();
    expect(checkCliArgs(["fleets", "list"], false)).toBeNull();
    expect(checkCliArgs(["snippets", "list"], false)).toBeNull();
    expect(checkCliArgs(["docker", "restart", "1", "c1"], false)).toBeNull();
    expect(checkCliArgs(["exec", "--help"], false)).toBeNull();
    expect(
      checkCliArgs(["api", "GET", "/plugin-api/snippets"], false),
    ).toBeNull();
    // What is blocked for everyone stays blocked.
    expect(checkCliArgs(["ssh", "1"], false)).toContain("termix ssh ");
  });

  it("still refuses a disk flag next to --help", () => {
    expect(
      checkCliArgs(["snippets", "create", "--content-file", "/x", "-h"], true),
    ).toMatch(/^--content-file/);
  });
});

describe("checkReadOnlyCliArgs", () => {
  it.each([
    ["hosts", "list"],
    ["hosts", "list", "--folder", "prod"],
    ["hosts", "get", "4"],
    ["credentials", "list"],
    ["fleets", "members", "2"],
    ["alerts", "list", "--unread"],
    ["sessions", "list"],
    ["plugins", "list"],
    ["audit-logs", "--limit", "20"],
    ["status"],
    ["status", "3"],
    ["version"],
    ["whoami"],
    ["api", "GET", "/host/db/host"],
    ["api", "get", "/plugin-api/automations/runs"],
    ["hosts", "delete", "--help"],
    ["help", "hosts"],
  ])("allows %j", (...args) => {
    expect(checkReadOnlyCliArgs(args)).toBeNull();
  });

  it.each([
    ["hosts", "delete", "4"],
    ["hosts", "create", "--ip", "10.0.0.9"],
    ["hosts", "update", "4", "--name", "x"],
    ["hosts"],
    ["hosts", "--folder", "list", "delete", "4"],
    ["--quiet", "hosts", "list"],
    ["alerts", "dismiss", "3"],
    ["alerts", "delete", "3"],
    ["sessions", "revoke-all"],
    ["fleets", "exec", "1", "uptime"],
    ["snippets", "run", "1"],
    ["exec", "1", "uptime"],
    ["files", "cat", "1", "/etc/shadow"],
    ["tunnel", "stop", "x"],
    ["api", "POST", "/host/db/host"],
    ["api", "DELETE", "/host/db/host/1"],
    ["api", "/host/db/host"],
    ["constructor", "list"],
    [],
  ])("refuses %j", (...args) => {
    expect(checkReadOnlyCliArgs(args)).toEqual(expect.any(String));
  });
});

describe("redactCliArgs", () => {
  it("masks secret flag values, request bodies and secret-shaped words", () => {
    expect(
      redactCliArgs([
        "credentials",
        "create",
        "--password",
        "hunter2",
        "--key-password=pp",
        "--token",
        "t",
        "--secret",
        "s",
        "--passphrase",
        "p",
        "--name",
        "web",
        "-d",
        '{"password":"x","name":"n"}',
        "tmx_abcdefghijklmnopqrstuvwxyz",
      ]),
    ).toEqual([
      "credentials",
      "create",
      "--password",
      "[redacted]",
      "--key-password=[redacted]",
      "--token",
      "[redacted]",
      "--secret",
      "[redacted]",
      "--passphrase",
      "[redacted]",
      "--name",
      "web",
      "-d",
      '{"password":"[redacted]","name":"n"}',
      "[redacted token]",
    ]);
  });
});

describe("requestToken", () => {
  it("reads the jwt cookie first, then a bearer header", () => {
    expect(
      requestToken({
        headers: { authorization: "Bearer b" },
        cookies: { jwt: "c" },
      }),
    ).toBe("c");
    expect(requestToken({ headers: { authorization: "Bearer b" } })).toBe("b");
    expect(requestToken({ headers: {} })).toBeNull();
    expect(requestToken({ headers: { authorization: "Basic x" } })).toBeNull();
  });
});

describe("runCli", () => {
  it("runs the bundle with the server's node and no shell, as the user, in a throwaway home", async () => {
    process.env.FAKE_SERVER_SECRET = "server-only";
    const run = vi.fn(spawnRun);
    const result = await runCli(
      target(run),
      ["hosts", "list", "$(touch /tmp/x); echo"],
      limits(),
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(process.execPath);
    expect(result.exitCode).toBe(0);
    const seen = JSON.parse(result.output);
    expect(seen.argv.slice(1)).toEqual([
      cliPath,
      "--json",
      "--no-color",
      "hosts",
      "list",
      "$(touch /tmp/x); echo",
    ]);
    expect(seen.env).toMatchObject({
      TERMIX_URL: "http://127.0.0.1:30001",
      TERMIX_TOKEN: "jwt-1",
      TERMIX_API_KEY: null,
      NO_COLOR: "1",
      SECRET: null,
    });
    expect(seen.env.HOME).toBe(seen.env.XDG_CONFIG_HOME);
    expect(seen.cwd).toBe(seen.env.HOME);
    expect(seen.env.HOME).not.toBe(process.env.HOME);
    // The home is gone once the call returns.
    expect(existsSync(seen.env.HOME)).toBe(false);
  });

  it("hands the model compact JSON, so long listings fit the limit", async () => {
    const result = await runCli(target(), ["pretty"], limits());
    expect(result.output).not.toContain("\n");
    expect(JSON.parse(result.output).env.NO_COLOR).toBe("1");
  });

  it("returns the exit code and stderr of a failed call", async () => {
    const result = await runCli(target(), ["fail"], limits());
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("boom");
  });

  it("kills the CLI when it runs past the timeout", async () => {
    const kill = vi.fn();
    const run: CliTarget["run"] = async (...args) => {
      const handle = await spawnRun(...args);
      return {
        ...handle,
        kill: (signal) => {
          kill(signal);
          handle.kill(signal);
        },
      };
    };
    const result = await runCli(
      target(run),
      ["sleep"],
      limits({ timeoutMs: 300 }),
    );
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.output).toContain("started");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills the CLI when the run is stopped", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const result = await runCli(
      target(),
      ["sleep"],
      limits({ signal: abort.signal }),
    );
    expect(result).toMatchObject({ exitCode: null, aborted: true });
  });

  it("reports a CLI that could not start", async () => {
    const result = await runCli(
      target(async () => {
        throw new Error("process:spawn not granted");
      }),
      ["hosts"],
      limits(),
    );
    expect(result).toMatchObject({
      exitCode: null,
      error: "process:spawn not granted",
    });
  });
});
