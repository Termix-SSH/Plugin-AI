import { exposureScript } from "../../../src/backend/exposure/collector.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePortable,
  portableScript,
} from "../../../src/backend/exposure/portable.js";
import {
  deriveEntries,
  linkPaths,
} from "../../../src/backend/exposure/derive.js";
import { host, derived, listener, observation } from "./fixtures.js";

describe("portable host metadata collection", () => {
  it("collects OpenWrt without Python and discards non-routing UCI fields on host", () => {
    const dir = mkdtempSync(join(tmpdir(), "termix-uci-"));
    try {
      symlinkSync(
        execFileSync("which", ["awk"], { encoding: "utf8" }).trim(),
        join(dir, "awk"),
      );
      writeFileSync(
        join(dir, "uci"),
        `#!/bin/sh\nprintf '%s\\n' 'firewall.web=redirect' "firewall.web.src_dport='443'" "firewall.web.dest_ip='10.0.0.2'" "firewall.web.dest_port='8443'" "firewall.web.proto='tcp'" "firewall.web.name='secret-token'"\n`,
        { mode: 0o700 },
      );
      const unavailable = JSON.parse(
        execFileSync("/bin/sh", ["-c", exposureScript()], {
          env: { PATH: dir },
          encoding: "utf8",
        }),
      );
      expect(
        unavailable.every(
          (s: { status: string }) => s.status === "unsupported",
        ),
      ).toBe(true);
      const raw = execFileSync("/bin/sh", ["-c", portableScript("uci")], {
        env: { PATH: dir },
        encoding: "utf8",
      });
      expect(raw).not.toContain("secret-token");
      const parsed = parsePortable("uci", raw);
      expect(parsed.complete).toBe(true);
      expect(parsed.records[0].backend?.port).toBe(8443);
      writeFileSync(join(dir, "uci"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const failure = execFileSync("/bin/sh", ["-c", portableScript("uci")], {
        env: { PATH: dir },
        encoding: "utf8",
      });
      expect(parsePortable("uci", failure).status).toBe("failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("represents Docker interface negation as a constraint, with unknown rules isolated", () => {
    const source =
      "-A DOCKER ! -i docker0 -p tcp -m tcp --dport 8080 -j DNAT --to-destination 172.17.0.2:80";
    const good = parsePortable("iptables", source);
    expect(good.complete).toBe(true);
    expect(good.records[0].constraints).toContain("not-interface:docker0");
    const mixed = parsePortable(
      "iptables",
      source +
        "\n-A TEST -p tcp --dport 1000:2000 -j DNAT --to-destination 10.0.0.2",
    );
    expect(mixed.records).toHaveLength(1);
    expect(mixed.issues).toHaveLength(1);
    const rows = deriveEntries(mixed, {
      host: host(),
      assets: [host()],
      ownerId: "owner",
      observationId: "snapshot",
      at: new Date().toISOString(),
    });
    expect(rows[0].staleAt).toBeNull();
    expect(mixed.complete).toBe(false);
  });
  it("does not export nft comments or script-like UCI values", () => {
    const parsed = parsePortable(
      "nft",
      JSON.stringify({
        nftables: [
          {
            rule: {
              comment: "credential=secret-value",
              expr: [
                {
                  match: {
                    op: "==",
                    left: { payload: { protocol: "tcp", field: "dport" } },
                    right: 443,
                  },
                },
                { dnat: { addr: "10.0.0.2", port: 80 } },
              ],
            },
          },
        ],
      }),
    );
    expect(JSON.stringify(parsed)).not.toContain("secret-value");
    const uci = parsePortable(
      "uci",
      "firewall.web=redirect\nfirewall.web.src_dport='$(touch /tmp/unsafe)'\nfirewall.web.dest_ip='10.0.0.2'\n__TERMIX_UCI_STATUS_0\n",
    );
    expect(uci.records).toEqual([]);
    expect(JSON.stringify(uci)).not.toContain("touch");
  });
  it("does not confuse container loopback with the host namespace", () => {
    const front = derived(
      observation([
        {
          ...listener(443),
          backend: { address: "127.0.0.1", port: 80, protocol: "tcp" },
          constraints: ["container-backend-namespace-unresolved"],
        },
      ]),
    )[0];
    const back = derived(
      observation([
        {
          ...listener(80),
          endpoint: { address: "127.0.0.1", port: 80, protocol: "tcp" },
        },
      ]),
    )[0];
    expect(linkPaths([front, back])[0].hops).toHaveLength(1);
  });
  it("does not guess the wildcard family and accepts scoped loopback", () => {
    const parsed = parsePortable(
      "listen",
      "tcp LISTEN 0 10 *:22 *:*\nudp UNCONN 0 10 127.0.0.53%lo:53 *:*",
    );
    expect(parsed.complete).toBe(true);
    expect(parsed.records[0].constraints).toContain("address-family-unknown");
  });
});

import samples from "./listener-samples.json";
describe("anonymized listener records reconstructed from seven audit snapshots", () => {
  for (const sample of samples)
    it(`parses snapshot ${sample.sample} without source-wide wildcard warnings`, () => {
      const result = parsePortable("listen", sample.text);
      expect(result.complete).toBe(true);
      expect(result.records).toHaveLength(sample.expected);
    });
  it("accepts BusyBox netstat when ss is absent", () => {
    const result = parsePortable(
      "listen",
      "Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address Foreign Address State\ntcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN\nudp 0 0 :::53 :::*",
    );
    expect(result.complete).toBe(true);
    expect(result.records).toHaveLength(2);
  });
});

describe("kube-proxy chain port association", () => {
  const rules = [
    "-A KUBE-SERVICES -d 10.43.0.10/32 -p tcp --dport 443 -j KUBE-SVC-APP",
    "-A KUBE-SVC-APP -m statistic --mode random --probability 0.5 -j KUBE-SEP-A",
    "-A KUBE-SVC-APP -j KUBE-SEP-B",
    "-A KUBE-SEP-A -p tcp -m tcp -j DNAT --to-destination 10.42.0.2:8443",
    "-A KUBE-SEP-B -p tcp -m tcp -j DNAT --to-destination 10.42.0.3:8443",
  ];
  it("inherits the actual service port and preserves conditional backend evidence", () => {
    const parsed = parsePortable("iptables", rules.join("\n"));
    expect(parsed.complete).toBe(true);
    expect(parsed.records).toHaveLength(2);
    expect(
      parsed.records.every(
        (r) => r.endpoint.port === 443 && r.endpoint.address === "10.43.0.10",
      ),
    ).toBe(true);
    expect(
      parsed.records.every((r) =>
        r.constraints.includes(
          "kube-proxy-chain-and-load-balancing-unverified",
        ),
      ),
    ).toBe(true);
  });
  it("keeps missing parents and negated entry rules as coverage gaps", () => {
    const orphan = parsePortable("iptables", rules.slice(1).join("\n"));
    expect(orphan.complete).toBe(false);
    expect(orphan.issues).toHaveLength(2);
    expect(orphan.records).toEqual([]);
    const negated = parsePortable(
      "iptables",
      rules.join("\n").replace("--dport 443", "! --dport 443"),
    );
    expect(negated.complete).toBe(false);
    expect(negated.records).toEqual([]);
  });
});
