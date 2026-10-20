import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  aggregateConnections,
  bridgeSubnets,
  hostAddresses,
  parseCloud,
  parseDocker,
  parseEstablished,
  parseIpAddr,
  parseIpRoute,
  parseKubernetes,
  parseListening,
  parseOsRelease,
  parsePveGuests,
  parseSections,
  parseServices,
  parseUptime,
} from "../../../src/backend/assets/parsers";
import {
  collectionScript,
  splitSections,
} from "../../../src/backend/assets/script";
import {
  BARE_HOST,
  CLOUD_AWS,
  DOCKER_PS,
  FULL_HOST,
  IP_ADDR,
  IP_ROUTE,
  K8S,
  OS_RELEASE,
  PVESH,
  SS_ESTABLISHED,
  SS_LISTEN,
  SYSTEMCTL,
  scriptOutput,
} from "./fixtures";

describe("collection script", () => {
  it("is valid POSIX shell", () => {
    expect(() =>
      execFileSync("sh", ["-n", "-c", collectionScript()]),
    ).not.toThrow();
  });

  it("only ever redirects to /dev/null", () => {
    const stripped = collectionScript().replace(/[12]?>(\/dev\/null|&1)/g, "");
    expect(stripped).not.toContain(">");
  });

  it("asks cloud metadata only for ids and regions, with 1 s limits", () => {
    const script = collectionScript();
    expect(script).toContain("-m 1");
    expect(script).toContain("-T 1");
    expect(script).not.toMatch(/user-data|token|credentials|-X PUT/i);
    expect(script).toContain("Metadata-Flavor: Google");
    expect(script).toContain("Metadata: true");
  });

  it("splits output back into sections", () => {
    const { sections, complete } = splitSections(FULL_HOST);
    expect(complete).toBe(true);
    expect(sections.hostname).toBe("web-1");
    expect(sections.pve).toBe("");
    expect(sections.k8s).toBe(K8S);
  });

  it("reports output cut short as incomplete", () => {
    const { sections, complete } = splitSections(
      scriptOutput({ os: OS_RELEASE, hostname: "x" }, false),
    );
    expect(complete).toBe(false);
    expect(Object.keys(sections)).toEqual(["os", "hostname"]);
  });
});

describe("section parsers", () => {
  it("keeps the identifying os-release fields", () => {
    expect(parseOsRelease(OS_RELEASE)).toEqual({
      id: "ubuntu",
      name: "Ubuntu",
      version: "24.04",
      pretty: "Ubuntu 24.04.4 LTS",
    });
    expect(parseOsRelease("")).toEqual({});
  });

  it("reads uptime in whole seconds", () => {
    expect(parseUptime("57380.97 1320161.03")).toBe(57380);
    expect(parseUptime("")).toBeUndefined();
  });

  it("reads interfaces and routes from ip -j", () => {
    const interfaces = parseIpAddr(IP_ADDR);
    expect(interfaces.map((entry) => entry.name)).toEqual([
      "lo",
      "eth0",
      "tailscale0",
      "docker0",
    ]);
    expect(interfaces[1].addrs).toEqual([
      "10.0.0.1/24",
      "fe80::215:5dff:fe5a:bd03/64",
    ]);
    expect(parseIpRoute(IP_ROUTE)[0]).toEqual({
      dst: "default",
      gateway: "10.0.0.254",
      dev: "eth0",
    });
    expect(parseIpAddr('Option "-j" is unknown')).toEqual([]);
  });

  it("drops loopback, link-local and bridge addresses from the host's own", () => {
    const facts = { interfaces: parseIpAddr(IP_ADDR) };
    expect(hostAddresses(facts)).toEqual([
      "10.0.0.1",
      "100.79.120.126",
      "fd7a:115c:a1e0::4e37:787e",
    ]);
    expect(bridgeSubnets(facts)).toHaveLength(1);
  });

  it("reads listening sockets with their process name only", () => {
    const rows = parseListening(SS_LISTEN);
    expect(rows).toContainEqual({
      proto: "udp",
      address: "10.255.255.254",
      port: 53,
      process: null,
    });
    expect(rows).toContainEqual({
      proto: "tcp",
      address: "0.0.0.0",
      port: 80,
      process: "nginx",
    });
    expect(rows).toContainEqual({
      proto: "tcp",
      address: "127.0.0.1",
      port: 46311,
      // A process title, not an executable: only its first word.
      process: "Paseo",
    });
    expect(rows).toContainEqual({
      proto: "tcp",
      address: "0.0.0.0",
      port: 8080,
      process: null,
    });
    // The duplicate [::]:22 line counts once.
    expect(rows.filter((row) => row.port === 22)).toHaveLength(2);
  });

  it("aggregates established connections by direction, peer and port", () => {
    const rows = parseEstablished(SS_ESTABLISHED);
    expect(rows[0]).toEqual({
      localIp: "10.0.0.1",
      localPort: 47092,
      peerIp: "10.0.0.2",
      peerPort: 5432,
      process: "app",
    });
    const connections = aggregateConnections(rows, parseListening(SS_LISTEN));
    expect(connections).toContainEqual({
      direction: "out",
      peer: "10.0.0.2",
      port: 5432,
      processes: ["app"],
      count: 2,
    });
    expect(connections).toContainEqual({
      direction: "out",
      peer: "93.184.216.34",
      port: 443,
      processes: ["curl"],
      count: 2,
    });
    expect(connections).toContainEqual({
      direction: "in",
      peer: "10.0.0.9",
      port: 22,
      processes: ["sshd"],
      count: 1,
    });
    // IPv4-mapped addresses fold back, and loopback is not a peer.
    expect(connections).toContainEqual(
      expect.objectContaining({ direction: "in", peer: "203.0.113.50" }),
    );
    expect(connections.some((entry) => entry.peer === "127.0.0.1")).toBe(false);
  });

  it("tolerates ss builds that print the state column", () => {
    const rows = parseEstablished(
      'ESTAB 0 0 10.0.0.1:41000 10.0.0.2:443 users:(("curl",pid=1,fd=3))',
    );
    expect(rows[0]).toMatchObject({ peerIp: "10.0.0.2", peerPort: 443 });
  });

  it("reads running services", () => {
    const services = parseServices(SYSTEMCTL);
    expect(services).toHaveLength(5);
    expect(services[2]).toEqual({
      name: "nginx.service",
      description: "A high performance web server and a reverse proxy server",
    });
  });

  it("keeps containers without their command, labels or mounts", () => {
    const containers = parseDocker(DOCKER_PS);
    expect(containers[0]).toEqual({
      id: "40d6a4ef8122",
      name: "app-db",
      image: "postgres:16-alpine",
      state: "running",
      status: "Up 10 hours",
      ports: "0.0.0.0:55432->5432/tcp",
      networks: ["bridge"],
    });
    expect(JSON.stringify(containers)).not.toContain("hunter2");
    expect(containers[1].networks).toEqual(["bridge", "monitoring"]);
    expect(
      parseDocker(
        "permission denied while trying to connect to the Docker daemon socket",
      ),
    ).toEqual([]);
  });

  it("keeps only active Kubernetes agents", () => {
    expect(parseKubernetes(K8S)).toEqual(["k3s"]);
    expect(parseKubernetes("")).toEqual([]);
  });

  it("lists Proxmox guests, not templates", () => {
    expect(parsePveGuests(PVESH)).toEqual([
      {
        vmid: 115,
        node: "pve1",
        name: "k3s-master-1",
        type: "qemu",
        status: "running",
      },
      {
        vmid: 201,
        node: "pve1",
        name: "dns-secondary",
        type: "lxc",
        status: "running",
      },
    ]);
  });

  it("names the cloud from metadata, then from DMI", () => {
    expect(parseCloud(CLOUD_AWS)).toEqual({
      provider: "aws",
      instanceId: "i-0abc123def4567890",
      region: "us-east-1",
    });
    expect(
      parseCloud(
        "gcp_id=4520031799277581759\ngcp_zone=projects/123456/zones/us-central1-a",
      ),
    ).toEqual({
      provider: "gcp",
      instanceId: "4520031799277581759",
      region: "us-central1-a",
    });
    expect(parseCloud("ec2_id=i-000001\nec2_region=")).toEqual({
      provider: "ec2-compatible",
      instanceId: "i-000001",
    });
    expect(parseCloud("aliyun_id=i-bp1\naliyun_region=cn-hangzhou")).toEqual({
      provider: "aliyun",
      instanceId: "i-bp1",
      region: "cn-hangzhou",
    });
    expect(parseCloud("dmi_vendor=Tencent Cloud")).toEqual({
      provider: "tencent",
    });
    // A Hyper-V or VMware guest is not a cloud.
    expect(parseCloud("dmi_vendor=Microsoft Corporation")).toBeUndefined();
    expect(parseCloud("")).toBeUndefined();
  });

  it("refuses metadata values that are not plain identifiers", () => {
    expect(parseCloud('azure_id=abc\nazure_region={"secret":"x"}')).toEqual({
      provider: "azure",
      instanceId: "abc",
    });
  });
});

describe("parseSections", () => {
  it("builds the facts of a full host", () => {
    const facts = parseSections(splitSections(FULL_HOST).sections);
    expect(facts.hostname).toBe("web-1");
    expect(facts.os?.id).toBe("ubuntu");
    expect(facts.containers).toHaveLength(2);
    expect(facts.kubernetes).toEqual(["k3s"]);
    expect(facts.missing).toEqual(["pve", "cloud"]);
    expect(facts.cloud).toBeUndefined();
  });

  it("is fine with a host that has none of the optional tools", () => {
    const facts = parseSections(splitSections(BARE_HOST).sections);
    expect(facts).toMatchObject({
      hostname: "edge",
      os: { id: "alpine", version: "3.20.3" },
      interfaces: [],
      listening: [],
      connections: [],
      containers: [],
      guests: [],
    });
    expect(facts.missing).toContain("docker");
  });
});
