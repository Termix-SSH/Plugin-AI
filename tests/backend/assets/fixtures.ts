import {
  SECTION_MARKER,
  type SectionName,
} from "../../../src/backend/assets/script";

/**
 * Collection output as hosts print it, trimmed from real machines: an
 * Ubuntu box with Docker and Tailscale, a Proxmox node and a minimal host
 * with none of the optional tools.
 */

export const OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.4 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"`;

export const IP_ADDR = JSON.stringify([
  {
    ifindex: 1,
    ifname: "lo",
    flags: ["LOOPBACK", "UP", "LOWER_UP"],
    addr_info: [
      { family: "inet", local: "127.0.0.1", prefixlen: 8, scope: "host" },
      { family: "inet6", local: "::1", prefixlen: 128, scope: "host" },
    ],
  },
  {
    ifindex: 2,
    ifname: "eth0",
    flags: ["BROADCAST", "MULTICAST", "UP", "LOWER_UP"],
    addr_info: [
      { family: "inet", local: "10.0.0.1", prefixlen: 24, scope: "global" },
      {
        family: "inet6",
        local: "fe80::215:5dff:fe5a:bd03",
        prefixlen: 64,
        scope: "link",
      },
    ],
  },
  {
    ifindex: 3,
    ifname: "tailscale0",
    flags: ["POINTOPOINT", "MULTICAST", "NOARP", "UP", "LOWER_UP"],
    addr_info: [
      {
        family: "inet",
        local: "100.79.120.126",
        prefixlen: 32,
        scope: "global",
      },
      {
        family: "inet6",
        local: "fd7a:115c:a1e0::4e37:787e",
        prefixlen: 128,
        scope: "global",
      },
    ],
  },
  {
    ifindex: 4,
    ifname: "docker0",
    flags: ["NO-CARRIER", "BROADCAST", "MULTICAST", "UP"],
    addr_info: [
      { family: "inet", local: "172.17.0.1", prefixlen: 16, scope: "global" },
    ],
  },
]);

export const IP_ROUTE = JSON.stringify([
  {
    dst: "default",
    gateway: "10.0.0.254",
    dev: "eth0",
    protocol: "kernel",
    flags: [],
  },
  {
    dst: "172.17.0.0/16",
    dev: "docker0",
    protocol: "kernel",
    scope: "link",
    prefsrc: "172.17.0.1",
    flags: ["linkdown"],
  },
]);

export const SS_LISTEN = `udp UNCONN 0      0                   10.255.255.254%lo:53    0.0.0.0:*
udp UNCONN 0      0                          0.0.0.0:41641 0.0.0.0:*                                        users:(("tailscaled",pid=812,fd=14))
tcp LISTEN 0      4096                       0.0.0.0:22    0.0.0.0:*                                        users:(("sshd",pid=901,fd=3))
tcp LISTEN 0      511                        0.0.0.0:80    0.0.0.0:*    users:(("nginx",pid=1200,fd=6),("nginx",pid=1201,fd=6))
tcp LISTEN 0      511                      127.0.0.1:46311 0.0.0.0:* users:(("Paseo Daemon",pid=2436,fd=24))
tcp LISTEN 0      4096                          [::]:22       [::]:*                                        users:(("sshd",pid=901,fd=4))
tcp LISTEN 0      4096                             *:8080        *:*
tcp LISTEN 0      4096                          [::]:22       [::]:*                                        users:(("sshd",pid=901,fd=4))`;

export const SS_ESTABLISHED = `0      0      10.0.0.1:47092   10.0.0.2:5432  users:(("app",pid=995,fd=56))
0      0      10.0.0.1:47094   10.0.0.2:5432  users:(("app",pid=995,fd=57))
0      0      10.0.0.1:50000   172.17.0.2:6379 users:(("app",pid=995,fd=58))
0      0           127.0.0.1:54488      127.0.0.1:6379
0      0      10.0.0.1:22      10.0.0.9:53122 users:(("sshd",pid=4410,fd=4))
0      0      10.0.0.1:35286  93.184.216.34:443 users:(("curl",pid=2436,fd=30))
0      0      10.0.0.1:35290  93.184.216.34:443 users:(("curl",pid=2437,fd=30))
0      0      10.0.0.1:41000  198.51.100.7:45123
0      0      [::ffff:10.0.0.1]:80  [::ffff:203.0.113.50]:61000 users:(("nginx",pid=1200,fd=9))
0      0      100.79.120.126:50878 100.100.103.88:22    users:(("ssh",pid=12660,fd=3))`;

export const SYSTEMCTL = `cron.service                   loaded active running Regular background program processing daemon
docker.service                 loaded active running Docker Application Container Engine
nginx.service                  loaded active running A high performance web server and a reverse proxy server
ssh.service                    loaded active running OpenBSD Secure Shell server
tailscaled.service             loaded active running Tailscale node agent`;

export const DOCKER_PS = [
  {
    Command: '"docker-entrypoint.s…"',
    CreatedAt: "2026-10-17 11:25:48 +0800 CST",
    ID: "40d6a4ef8122",
    Image: "postgres:16-alpine",
    Labels: "com.example.secret=hunter2",
    Mounts: "/srv/pg",
    Names: "app-db",
    Networks: "bridge",
    Ports: "0.0.0.0:55432->5432/tcp",
    State: "running",
    Status: "Up 10 hours",
  },
  {
    Command: '"/run.sh"',
    ID: "6b29e1e7b9d2",
    Image: "grafana/grafana:8.3.0",
    Labels: "",
    Names: "grafana",
    Networks: "bridge,monitoring",
    Ports: "3000/tcp",
    State: "running",
    Status: "Up 12 hours",
  },
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");

export const K8S = `k3s active
k3s-agent inactive
kubelet inactive`;

export const PVESH = JSON.stringify([
  {
    id: "qemu/115",
    maxcpu: 4,
    maxmem: 8589934592,
    name: "k3s-master-1",
    node: "pve1",
    status: "running",
    template: 0,
    type: "qemu",
    uptime: 863012,
    vmid: 115,
  },
  {
    id: "lxc/201",
    name: "dns-secondary",
    node: "pve1",
    status: "running",
    type: "lxc",
    vmid: 201,
  },
  {
    id: "qemu/9000",
    name: "ubuntu-template",
    node: "pve1",
    status: "stopped",
    template: 1,
    type: "qemu",
    vmid: 9000,
  },
]);

export const CLOUD_AWS = `dmi_vendor=Amazon EC2
ec2_id=i-0abc123def4567890
ec2_region=us-east-1`;

/** Script output with the given sections, in the script's format. */
export function scriptOutput(
  sections: Partial<Record<SectionName, string>>,
  complete = true,
): string {
  const parts = Object.entries(sections).map(
    ([name, body]) => `\n${SECTION_MARKER}${name}\n${body}`,
  );
  if (complete) parts.push(`\n${SECTION_MARKER}end`);
  return parts.join("\n") + "\n";
}

/** A host with everything: Docker, Tailscale, k3s. */
export const FULL_HOST = scriptOutput({
  os: OS_RELEASE,
  hostname: "web-1",
  uptime: "57380.97 1320161.03",
  addr: IP_ADDR,
  route: IP_ROUTE,
  listen: SS_LISTEN,
  established: SS_ESTABLISHED,
  services: SYSTEMCTL,
  docker: DOCKER_PS,
  k8s: K8S,
  pve: "",
  cloud: "",
});

/** A minimal host: no ip -j, no ss, no systemd, nothing optional. */
export const BARE_HOST = scriptOutput({
  os: 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3',
  hostname: "edge",
  uptime: "120.5 100.0",
  addr: "",
  route: "",
  listen: "",
  established: "",
  services: "",
  docker: "",
  k8s: "",
  pve: "",
  cloud: "",
});

/** A Proxmox node named pve1. */
export function pveHost(address: string): string {
  return scriptOutput({
    os: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian',
    hostname: "pve1",
    addr: JSON.stringify([
      {
        ifname: "vmbr0",
        addr_info: [{ family: "inet", local: address, prefixlen: 24 }],
      },
      {
        ifname: "fwbr115i0",
        addr_info: [],
      },
    ]),
    pve: PVESH,
  });
}
