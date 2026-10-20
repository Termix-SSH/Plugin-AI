/**
 * The one script the collector runs on each host.
 *
 * Strictly read-only: every line reads a file, lists something or asks a
 * local service, and every probe that might be missing (ip, ss, docker,
 * pvesh, curl) is optional. Errors go to /dev/null so a section is either
 * output or empty. Sections are split by a marker line no command prints.
 *
 * Cloud metadata: plain GETs with a 1 s limit, asking only for the instance
 * id and region. Azure and GCP are asked for single leaf values with
 * format=text rather than the whole instance document, so nothing else
 * (tags, SSH keys, user data) ever leaves the host. Proxy variables are
 * dropped so the link-local address is asked directly.
 */

export const SECTION_MARKER = "@@termix-asset:";

export const SECTIONS = [
  "os",
  "hostname",
  "uptime",
  "addr",
  "route",
  "listen",
  "established",
  "services",
  "docker",
  "k8s",
  "pve",
  "cloud",
] as const;

export type SectionName = (typeof SECTIONS)[number];

const CLOUD_PROBES = [
  'if command -v curl >/dev/null 2>&1; then m() { curl -fsS --connect-timeout 1 -m 1 ${2:+-H "$2"} "$1" 2>/dev/null | head -c 200; }',
  'elif command -v wget >/dev/null 2>&1; then m() { wget -q -T 1 -t 1 ${2:+--header="$2"} -O - "$1" 2>/dev/null | head -c 200; }',
  "else m() { return 1; }; fi",
  'v=$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null | head -c 100); [ -n "$v" ] && echo "dmi_vendor=$v"',
  'g=$(m http://169.254.169.254/computeMetadata/v1/instance/id "Metadata-Flavor: Google") && [ -n "$g" ] && { echo "gcp_id=$g"; echo "gcp_zone=$(m http://169.254.169.254/computeMetadata/v1/instance/zone "Metadata-Flavor: Google")"; }',
  'a=$(m "http://169.254.169.254/metadata/instance/compute/vmId?api-version=2021-02-01&format=text" "Metadata: true") && [ -n "$a" ] && { echo "azure_id=$a"; echo "azure_region=$(m "http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text" "Metadata: true")"; }',
  'l=$(m http://100.100.100.200/latest/meta-data/instance-id) && [ -n "$l" ] && { echo "aliyun_id=$l"; echo "aliyun_region=$(m http://100.100.100.200/latest/meta-data/region-id)"; }',
  't=$(m http://metadata.tencentyun.com/latest/meta-data/instance-id) && [ -n "$t" ] && { echo "tencent_id=$t"; echo "tencent_region=$(m http://metadata.tencentyun.com/latest/meta-data/placement/region)"; }',
  'e=$(m http://169.254.169.254/latest/meta-data/instance-id) && [ -n "$e" ] && { echo "ec2_id=$e"; echo "ec2_region=$(m http://169.254.169.254/latest/meta-data/placement/region)"; }',
];

const BODY: Record<SectionName, string[]> = {
  os: ["cat /etc/os-release 2>/dev/null"],
  hostname: [
    "hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null",
  ],
  uptime: ["cat /proc/uptime 2>/dev/null"],
  addr: ["ip -j addr 2>/dev/null"],
  route: ["ip -j route 2>/dev/null"],
  // TCP and UDP in one listing; the first column says which.
  listen: ["ss -H -tulnp 2>/dev/null"],
  established: ["ss -H -tnp state established 2>/dev/null"],
  services: [
    "systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null",
  ],
  docker: [
    "command -v docker >/dev/null 2>&1 && docker ps --format '{{json .}}' 2>/dev/null",
  ],
  k8s: [
    'command -v systemctl >/dev/null 2>&1 && for u in k3s k3s-agent kubelet; do echo "$u $(systemctl is-active "$u" 2>/dev/null)"; done',
  ],
  pve: [
    "command -v pvesh >/dev/null 2>&1 && pvesh get /cluster/resources --type vm --output-format json 2>/dev/null",
  ],
  cloud: CLOUD_PROBES,
};

export function collectionScript(): string {
  const lines = [
    "export LC_ALL=C",
    "unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY",
  ];
  for (const section of SECTIONS) {
    lines.push(`echo; echo '${SECTION_MARKER}${section}'`, ...BODY[section]);
  }
  lines.push(`echo; echo '${SECTION_MARKER}end'`);
  return lines.join("\n");
}

/**
 * The output split back into sections. A section the host never reached
 * (cut short, timed out) is simply missing; `complete` says whether the end
 * marker arrived.
 */
export function splitSections(output: string): {
  sections: Partial<Record<SectionName, string>>;
  complete: boolean;
} {
  const sections: Partial<Record<SectionName, string>> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  let complete = false;
  const flush = () => {
    if (current && (SECTIONS as readonly string[]).includes(current)) {
      sections[current as SectionName] = buffer.join("\n").trim();
    }
    buffer = [];
  };
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(SECTION_MARKER)) {
      buffer.push(line);
      continue;
    }
    flush();
    current = line.slice(SECTION_MARKER.length).trim();
    if (current === "end") complete = true;
  }
  flush();
  return { sections, complete };
}
