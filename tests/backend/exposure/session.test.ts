import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SECTION_LIMIT,
  quickScript,
  splitSession,
} from "../../../src/backend/exposure/session.js";

const mark = "__TERMIX_EXPOSURE__";
const section = (name: string, code: number | null, output = "") =>
  `\n${mark} ${name}\n${output}\n` +
  (code === null ? "" : `${mark} status ${code}\n`);

describe("splitSession", () => {
  it("keeps each section's output and exit status", () => {
    const sections = splitSession(
      section("listen", 0, "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*") +
        section("docker", 127),
    );
    expect(sections.get("listen")).toEqual({
      code: 0,
      output: "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
    });
    expect(sections.get("docker")).toEqual({ code: 127, output: "" });
  });

  it("drops a section that was cut short or is over its limit", () => {
    const sections = splitSession(
      section("nft", 0, "x".repeat(SECTION_LIMIT + 1)) +
        section("uci", null, "firewall.a=redirect"),
    );
    expect(sections.has("nft")).toBe(false);
    expect(sections.has("uci")).toBe(false);
  });
});

describe("quickScript", () => {
  // Only sh (and timeout where given) on the PATH: every probed tool and
  // python3 are missing.
  const bin = mkdtempSync(path.join(os.tmpdir(), "exposure-session-"));
  symlinkSync("/bin/sh", path.join(bin, "sh"));
  afterAll(() => rmSync(bin, { recursive: true, force: true }));
  const run = (shell: string, extra: string[] = [], python = false) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "exposure-path-"));
    if (python) symlinkSync("/bin/true", path.join(dir, "python3"));
    for (const tool of extra) {
      const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      }).stdout.trim();
      if (found) symlinkSync(found, path.join(dir, tool));
    }
    try {
      return spawnSync(shell, ["-c", quickScript()], {
        env: { PATH: `${bin}:${dir}` },
        encoding: "utf8",
        timeout: 20_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reports every source in one run, missing tools as 127", () => {
    const result = run("/bin/sh");
    expect(result.status).toBe(0);
    const sections = splitSession(result.stdout);
    for (const source of ["listen", "docker", "nft", "iptables", "uci"]) {
      expect(sections.get(source)?.code, source).toBe(127);
    }
    // dash answers 127 for a missing command, bash and zsh 1.
    expect(sections.get("python")?.code).not.toBe(0);
    const found = splitSession(run("/bin/sh", [], true).stdout);
    expect(found.get("python")?.code).toBe(0);
  });

  it("stays well under dropbear's exec command limit", () => {
    expect(quickScript().length).toBeLessThan(8000);
  });

  const zsh = spawnSync("/bin/sh", ["-c", "command -v zsh"], {
    encoding: "utf8",
  }).stdout.trim();
  it.skipIf(!zsh)("runs the bounded sections under zsh too", () => {
    // zsh does not split "$T": "timeout 5" ran as one command name, 127.
    const sections = splitSession(run(zsh, ["timeout"], true).stdout);
    expect(sections.get("python")?.code).toBe(0);
  });
});
