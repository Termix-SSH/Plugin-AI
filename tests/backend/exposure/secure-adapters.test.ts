import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PYTHON_COLLECTOR } from "../../../src/backend/exposure/collector.js";
function run(body: string, input: unknown = {}) {
  const script =
    "import json,sys\nd=json.load(sys.stdin)\nscope={'__name__':'fixture'}\nexec(d['script'],scope)\nexec(d['body'],scope)";
  const result = spawnSync("python3", ["-c", script], {
    input: JSON.stringify({
      script: PYTHON_COLLECTOR,
      body:
        "data=" +
        JSON.stringify(JSON.stringify(input)) +
        "\ndata=json.loads(data)\n" +
        body,
    }),
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
const config = {
  apps: {
    http: {
      servers: {
        edge: {
          listen: [":443"],
          routes: [
            {
              match: [{ host: ["app.example"] }],
              handle: [
                {
                  handler: "subroute",
                  routes: [
                    {
                      match: [{ path: ["/api/*"] }],
                      handle: [
                        {
                          handler: "reverse_proxy",
                          headers: {
                            request: {
                              set: { Authorization: ["secret-auth"] },
                            },
                          },
                          upstreams: [{ dial: "127.0.0.1:8080" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  },
};
describe("credential-bearing configuration projection", () => {
  it("walks Caddy nested routes without exporting credentials", () => {
    const r = run(
      "r=caddy(json.dumps(data))\nprint(json.dumps({'records':r,'complete':r.complete}))",
      config,
    );
    expect(r.complete).toBe(true);
    expect(r.records[0]).toMatchObject({
      hostname: "app.example",
      path: "/api/*",
      endpoint: { port: 443 },
      backend: { port: 8080 },
    });
    expect(JSON.stringify(r)).not.toContain("secret-auth");
  });
  it("projects scalar frp and cloudflared configs without optional Python libraries", () => {
    const result = run(
      `import builtins
original=builtins.__import__
def without_optional(name,*args,**kwargs):
    if name in ('tomllib','yaml'): raise ModuleNotFoundError(name)
    return original(name,*args,**kwargs)
builtins.__import__=without_optional
try:
    print(json.dumps({'frp':frp(data['frp']),'cloudflared':cloudflared(data['cloudflared'])}))
finally: builtins.__import__=original`,
      {
        frp: 'serverAddr = "gateway.example"\n[auth]\ntoken = "secret-token"\n[[proxies]]\nname = "web"\ntype = "tcp"\nlocalPort = 8080\nremotePort = 8443',
        cloudflared:
          "tunnel: secret-id\ncredentials-file: /secret/credential.json\ningress:\n  - hostname: app.example\n    service: http://127.0.0.1:8080\n    originRequest:\n      access:\n        audTag: secret-aud\n  - service: http_status:404\n",
      },
    );
    expect(result.frp).toHaveLength(1);
    expect(result.cloudflared).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("discovers custom configuration flags without exporting other arguments", () => {
    const result = run(
      "print(json.dumps([config_path(data[0]),config_path(data[1])]))",
      [
        [
          "cloudflared",
          "tunnel",
          "--config",
          "/opt/tunnels/config.yml",
          "--token",
          "secret-token",
        ],
        ["frpc", "--config=/opt/frp/client.toml"],
      ],
    );
    expect(result).toEqual(["/opt/tunnels/config.yml", "/opt/frp/client.toml"]);
  });
  it("projects container proxies onto published ports and isolates loopback backends", () => {
    const result = run(
      `calls=[]
def fake(args):
    calls.append(args)
    if args[1:3]==['ps','-q']: return 'a'*64+'\\n'
    if args[1]=='inspect': return json.dumps({'path':'caddy','args':['run','--config','/etc/caddy/Caddyfile'],'ports':{'443/tcp':[{'HostIp':'0.0.0.0','HostPort':'8443'}]}})
    if args[1]=='exec': return json.dumps(data)
    raise ValueError('unexpected command')
read_command=fake
shutil.which=lambda name:'/usr/bin/docker'
print(json.dumps({'result':container_proxies(),'calls':calls}))`,
      config,
    );
    expect(result.result.records[0].endpoint.port).toBe(8443);
    expect(result.result.records[0].constraints).toContain(
      "container-backend-namespace-unresolved",
    );
    expect(
      result.calls.some(
        (args: string[]) => args.includes("--validate") || args.includes("sh"),
      ),
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-auth");
  });
  it("reports Docker command failure instead of an empty complete snapshot", () => {
    const result = run(
      "shutil.which=lambda name:'/usr/bin/docker'\ndef failed(args): raise ValueError('denied')\nread_command=failed\nprint(json.dumps(container_proxies()))",
    );
    expect(result).toMatchObject({
      status: "failed",
      complete: false,
      records: [],
    });
  });
});

const runtimeMock = `import http.client
calls=[]
class Socket:
    def settimeout(self,value): pass
class Response:
    def __init__(self): self.raw=json.dumps(data['config']).encode(); self.done=False; self.status=data.get('status',200)
    def isclosed(self): return self.done
    def read1(self,size):
        chunk=self.raw[:size]; self.raw=self.raw[size:]; self.done=not self.raw; return chunk
class Connection:
    def __init__(self,address,port,timeout): calls.append([address,port]); self.sock=Socket()
    def request(self,method,path,headers): calls.append([method,path,headers])
    def getresponse(self): return Response()
    def close(self): pass
http.client.HTTPConnection=Connection
`;
describe("Caddy runtime configuration", () => {
  it("prefers bounded loopback GET over adapt without exporting DNS credentials", () => {
    const result = run(
      runtimeMock +
        `
def no_adapt(args): raise AssertionError('adapt must not run')
caddy_config=no_adapt
print(json.dumps({'entry':collect_caddy(['/etc/caddy/Caddyfile']),'calls':calls}))`,
      {
        config: {
          ...config,
          apps: {
            ...config.apps,
            tls: {
              automation: {
                policies: [
                  {
                    issuers: [
                      { dns: { api_token: "cloudflare-secret-token" } },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    );
    expect(result.entry).toMatchObject({ status: "ok", complete: true });
    expect(result.entry.records).toHaveLength(1);
    expect(result.entry.records[0].constraints).toContain(
      "caddy-runtime-config",
    );
    expect(result.entry.records[0].constraints).not.toContain(
      "caddy-config-not-runtime",
    );
    expect(JSON.stringify(result)).not.toMatch(
      /cloudflare-secret-token|secret-auth/,
    );
    expect(result.calls[0]).toEqual(["127.0.0.1", 2019]);
    expect(result.calls[1].slice(0, 2)).toEqual(["GET", "/config/"]);
  });
  it("does not follow redirects and falls back to a static projection", () => {
    const result = run(
      runtimeMock +
        `
caddy_config=lambda args:caddy(json.dumps(data['config']))
print(json.dumps({'entry':collect_caddy(['/etc/caddy/Caddyfile']),'calls':calls}))`,
      { config, status: 302 },
    );
    expect(result.entry.records[0].constraints).toContain(
      "caddy-config-not-runtime",
    );
    expect(result.calls.filter((c: any[]) => typeof c[1] === "number")).toEqual(
      [
        ["127.0.0.1", 2019],
        ["::1", 2019],
      ],
    );
  });
  it("rejects oversized and invalid runtime documents without reporting a complete empty snapshot", () => {
    for (const value of [
      { config, status: 200, limit: 20 },
      { config: { error: "secret-error" }, status: 200, limit: 2000000 },
    ]) {
      const result = run(
        runtimeMock +
          `
MAX=data['limit']
def unavailable(args): raise ValueError('adapt failed')
caddy_config=unavailable
print(json.dumps(collect_caddy(['/etc/caddy/Caddyfile'])))`,
        value,
      );
      expect(result).toMatchObject({
        status: "failed",
        complete: false,
        records: [],
      });
      expect(JSON.stringify(result)).not.toContain("secret-error");
    }
  });
});

it("reads a bounded HTTP/1.0 response even when the admin server closes its connection", () => {
  const result = run(
    `import http.client, http.server, threading
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body=json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self,*args): pass
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
original=http.client.HTTPConnection
http.client.HTTPConnection=lambda address,port,timeout:original('127.0.0.1',server.server_port,timeout=timeout)
try: print(json.dumps(caddy_runtime()))
finally: server.shutdown();server.server_close();thread.join()`,
    config,
  );
  expect(result).toHaveLength(1);
  expect(result[0].constraints).toContain("caddy-runtime-config");
});
