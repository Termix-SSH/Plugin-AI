import {
  parsePortable,
  PORTABLE,
  type PortableSource,
} from "../../../src/backend/exposure/portable.js";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PYTHON_COLLECTOR } from "../../../src/backend/exposure/collector.js";
import { decodeObservations } from "../../../src/backend/exposure/derive.js";
function parse(adapter: string, input: unknown) {
  if (adapter in PORTABLE) {
    let text = typeof input === "string" ? input : JSON.stringify(input);
    if (adapter === "docker") {
      const d = typeof input === "string" ? JSON.parse(input) : (input as any);
      text =
        JSON.stringify(d.ID === "x" ? "abcdef" : d.ID) +
        " " +
        JSON.stringify(d.Ports);
    }
    if (adapter === "uci") text += "\n__TERMIX_UCI_STATUS_0\n";
    return parsePortable(adapter as PortableSource, text);
  }
  const source = `import json,sys\nd=json.load(sys.stdin)\nscope={'__name__':'fixture'}\nexec(d['script'],scope)\nr=scope[d['adapter']](d['input'])\nprint(json.dumps({'records':r,'complete':r.complete}))`;
  const result = spawnSync("python3", ["-c", source], {
    input: JSON.stringify({
      script: PYTHON_COLLECTOR,
      adapter,
      input: typeof input === "string" ? input : JSON.stringify(input),
    }),
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
describe("host-side exposure projection", () => {
  it("keeps IPv4 and IPv6 bindings distinct", () => {
    const r = parse(
      "listen",
      "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nudp UNCONN 0 0 [::]:53 [::]:*",
    );
    expect(r.records.map((x: any) => x.endpoint)).toEqual([
      { address: "0.0.0.0", port: 22, protocol: "tcp" },
      { address: "::", port: 53, protocol: "udp" },
    ]);
  });
  it("retains unknown wildcard families and preserves unchanged DNAT ports", () => {
    const wildcard = parse("listen", "tcp LISTEN 0 128 *:22 *:*");
    expect(wildcard.records[0].endpoint.address).toBe("*");
    expect(wildcard.complete).toBe(true);
    const nat = parse(
      "iptables",
      "-A PREROUTING -p tcp --dport 5432 -j DNAT --to-destination 10.0.0.2",
    );
    expect(nat.records[0].backend.port).toBe(5432);
    const proxy = parse("cloudflared", {
      ingress: [{ hostname: "app.example", service: "tcp://10.0.0.2" }],
    });
    expect(proxy.records).toEqual([]);
    expect(proxy.complete).toBe(false);
  });
  it("drops conflicting object identities instead of choosing the last record", () => {
    const record = {
      objectKey: "same",
      kind: "listener",
      endpoint: { address: "10.0.0.2", port: 80, protocol: "tcp" },
      constraints: [],
    };
    const result = decodeObservations(
      JSON.stringify([
        {
          source: "listen",
          status: "ok",
          complete: true,
          records: [
            record,
            { ...record, endpoint: { ...record.endpoint, port: 443 } },
          ],
        },
      ]),
    )[0];
    expect(result.complete).toBe(false);
    expect(result.records).toEqual([]);
  });
  it("does not claim completeness for unsupported Docker port ranges", () => {
    const r = parse("docker", {
      ID: "x",
      Ports: "0.0.0.0:8000-8005->80-85/tcp",
    });
    expect(r.complete).toBe(false);
  });
  it("projects static nginx routes without authentication credentials or private keys", () => {
    const r = parse(
      "nginx",
      `http { server { listen 443 ssl; server_name app.example; ssl_certificate_key /secret/key.pem; proxy_set_header Authorization "Bearer secret-token"; location /api { proxy_pass http://10.1.0.2:8080; } } }`,
    );
    expect(r.records).toHaveLength(1);
    expect(r.records[0].backend).toEqual({
      address: "10.1.0.2",
      port: 8080,
      protocol: "tcp",
    });
    expect(JSON.stringify(r)).not.toMatch(/secret-token|key.pem|Authorization/);
  });
  it("retains an incomplete status for dynamic proxy targets", () => {
    expect(
      parse(
        "nginx",
        "http { server { listen 80; location / { proxy_pass http://$backend; } } }",
      ).complete,
    ).toBe(false);
  });
  it("never exports credentials in proxy URLs", () => {
    const r = parse(
      "nginx",
      "server { listen 80; location / { proxy_pass http://user:password@10.1.0.2:8080; } }",
    );
    expect(r.records).toEqual([]);
    expect(r.complete).toBe(false);
  });
  it("records source constraints without claiming firewall acceptance", () => {
    const r = parse("nft", {
      nftables: [
        {
          rule: {
            family: "ip",
            table: "nat",
            chain: "prerouting",
            handle: 3,
            expr: [
              {
                match: {
                  op: "==",
                  left: { payload: { protocol: "tcp", field: "dport" } },
                  right: 443,
                },
              },
              {
                match: {
                  op: "==",
                  left: { payload: { protocol: "ip", field: "saddr" } },
                  right: "10.0.0.0/8",
                },
              },
              { dnat: { addr: "10.1.0.2", port: 8443 } },
            ],
          },
        },
      ],
    });
    expect(r.records[0].constraints).toEqual([
      "filter-chain-unverified",
      "source:10.0.0.0/8",
      "additional-match-conditions-unverified",
    ]);
  });
  it("leaves unsupported DNAT expressions incomplete", () => {
    expect(
      parse("nft", {
        nftables: [
          { rule: { expr: [{ dnat: { addr: { map: "dynamic" } } }] } },
        ],
      }).complete,
    ).toBe(false);
  });
  it("projects ingress routing but not annotations or secret references", () => {
    const r = parse("ingress", {
      items: [
        {
          metadata: {
            name: "app",
            namespace: "web",
            annotations: { secret: "hunter2" },
          },
          spec: {
            tls: [{ hosts: ["app.example"], secretName: "sensitive-name" }],
            rules: [
              {
                host: "app.example",
                http: {
                  paths: [
                    {
                      path: "/",
                      backend: {
                        service: { name: "app", port: { number: 80 } },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    expect(r.records[0].tls).toBe("configured");
    expect(JSON.stringify(r)).not.toMatch(/hunter2|sensitive-name/);
  });
  it("does not promote private Tailscale Serve to public Funnel", () => {
    const config = {
      Web: {
        "node.example:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
        },
      },
    };
    expect(parse("tailscale", config).records).toEqual([]);
    expect(
      parse("tailscale", {
        ...config,
        AllowFunnel: { "node.example:443": true },
      }).records,
    ).toHaveLength(1);
  });
  it("projects simple iptables DNAT and marks negated matches incomplete", () => {
    const r = parse(
      "iptables",
      "-A PREROUTING -s 10.0.0.0/8 -p tcp --dport 443 -j DNAT --to-destination 10.1.0.2:8443",
    );
    expect(r.records[0].backend.port).toBe(8443);
    expect(
      parse(
        "iptables",
        "-A PREROUTING -p tcp ! --dport 443 -j DNAT --to-destination 10.1.0.2:8443",
      ).complete,
    ).toBe(false);
  });
  it("projects OpenWrt redirects without comments and ignores disabled rules", () => {
    const r = parse(
      "uci",
      "firewall.web=redirect\nfirewall.web.src_dport='443'\nfirewall.web.dest_ip='10.0.0.2'\nfirewall.web.dest_port='8443'\nfirewall.web.proto='tcp'\nfirewall.web.name='secret comment'",
    );
    expect(r.records).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("secret comment");
  });
  it("projects frp TCP routes without authentication tokens and flags includes", () => {
    const r = parse(
      "frp",
      'serverAddr = "gateway.example"\n[auth]\ntoken = "top-secret"\n[[proxies]]\nname = "web"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 8080\nremotePort = 8443',
    );
    expect(r.records[0].endpoint.address).toBe("gateway.example");
    expect(JSON.stringify(r)).not.toContain("top-secret");
    expect(
      parse("frp", 'serverAddr = "gateway.example"\nincludes=["other.toml"]')
        .complete,
    ).toBe(false);
  });
  it("projects cloudflared ingress without tunnel credentials or origin request secrets", () => {
    const r = parse("cloudflared", {
      tunnel: "private-tunnel-id",
      "credentials-file": "/private/credential.json",
      ingress: [
        {
          hostname: "app.example",
          service: "http://127.0.0.1:8080",
          originRequest: { access: { audTag: ["private-aud"] } },
        },
        { service: "http_status:404" },
      ],
    });
    expect(r.records).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/private-/);
    expect(r.records[0].tls).toBe("unknown");
  });
  it("treats malformed and duplicate sources as incomplete, including invalid secret-shaped endpoints", () => {
    expect(decodeObservations("not json").every((x) => !x.complete)).toBe(true);
    const value = {
      source: "listen",
      status: "ok",
      complete: true,
      records: [
        {
          objectKey: "x",
          kind: "listener",
          endpoint: {
            address: "user:password@host",
            port: 22,
            protocol: "tcp",
          },
          constraints: [],
        },
      ],
    };
    expect(decodeObservations(JSON.stringify([value]))[0].complete).toBe(false);
    expect(decodeObservations(JSON.stringify([value, value]))[0].status).toBe(
      "failed",
    );
  });
});
