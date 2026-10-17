/**
 * Which commands the assistant may run without a per-command approval click,
 * for users who opted into read-only execution.
 *
 * The check parses the command into arguments and matches the resolved binary
 * against the allowlist. Substring matching would be trivially defeated
 * ("df; rm -rf /" contains "df"), so any shell metacharacter that could chain,
 * redirect or substitute a second command rejects the whole string outright.
 */

const READ_ONLY_COMMANDS = new Set([
  "df",
  "du",
  "free",
  "uptime",
  "uname",
  "whoami",
  "hostname",
  "id",
  "ps",
  "top",
  "systemctl",
  "journalctl",
  "docker",
  "ip",
  "ss",
  "netstat",
  "lsblk",
  "cat",
  "ls",
  "stat",
  "which",
  "date",
  "lscpu",
  "vmstat",
  "iostat",
  "find",
  "ping",
  "nc",
  "qm",
  "pct",
  "timedatectl",
  "openssl",
  "apt",
  "dnf",
  "yum",
  "needrestart",
  "test",
  "[",
  "kubectl",
  "k3s",
  "crictl",
  "nvidia-smi",
  "zpool",
  "zfs",
  "pvesm",
  "pvecm",
  "pveversion",
  "pvesh",
  "systemd-detect-virt",
]);

/** Characters that let one command become several. */
const SHELL_METACHARACTERS = /[;&|`$><\n\r\\]/;

/** Subcommands that are safe for otherwise-powerful binaries. */
const SUBCOMMAND_ALLOWLIST: Record<string, Set<string>> = {
  systemctl: new Set([
    "status",
    "list-units",
    "list-unit-files",
    "is-active",
    "is-enabled",
    "list-timers",
  ]),
  // inspect only with a --format limited to state fields, since its full
  // output holds container environment variables.
  docker: new Set([
    "inspect",
    "ps",
    "stats",
    "images",
    "logs",
    "version",
    "info",
    "system",
  ]),
  ip: new Set(["a", "addr", "link", "route", "neigh"]),
  qm: new Set(["status", "list"]),
  pct: new Set(["status", "list"]),
};

/** Paths `cat` may read. Anything else could disclose credentials. */
const CAT_ALLOWED_PREFIXES = [
  "/proc/",
  "/sys/",
  "/etc/os-release",
  "/run/reboot-required.pkgs",
  "/var/run/reboot-required.pkgs",
];

/** Wildcards the shell would expand into paths nobody checked. */
const GLOB_CHARACTERS = /[*?[\]{}~]/;

/**
 * Whether cat may read a path. It must be a plain absolute path under an
 * allowed prefix, with no ".." and no per-process /proc entry, since those
 * hold environment variables and command lines.
 */
function catPathAllowed(target: string): boolean {
  if (GLOB_CHARACTERS.test(target)) return false;
  if (!target.startsWith("/") || target.includes("//")) return false;
  if (
    target.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    return false;
  }
  const procEntry = target.startsWith("/proc/") ? target.split("/")[2] : "";
  if (
    /^\d+$/.test(procEntry) ||
    procEntry === "self" ||
    procEntry === "thread-self"
  ) {
    return false;
  }
  return CAT_ALLOWED_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? target.startsWith(prefix) : target === prefix,
  );
}

/** Primaries that make find delete, run or write something. */
const FIND_WRITES = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
]);

/** The words after a subcommand, ignoring flags. */
const positional = (args: string[]) =>
  args.filter((arg) => !arg.startsWith("-"));

const isCount = (value: string | undefined, max: number) =>
  value !== undefined && /^\d+$/.test(value) && +value >= 1 && +value <= max;

const plainPath = (value: string | undefined) =>
  !!value && value.startsWith("/") && !GLOB_CHARACTERS.test(value);

/**
 * Flags a command may take, the ones that take a value mapped to true. Any
 * other flag refuses the command, so a write option can never slip through.
 */
function onlyFlags(
  args: string[],
  allowed: Record<string, boolean>,
): { rest: string[] } | { error: string } {
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) {
      rest.push(arg);
      continue;
    }
    if (!(arg in allowed)) return { error: `${arg} is not allowed` };
    if (allowed[arg]) {
      if (args[index + 1] === undefined)
        return { error: `${arg} needs a value` };
      index += 1;
    }
  }
  return { rest };
}

const OPENSSL_X509_FLAGS: Record<string, boolean> = {
  "-noout": false,
  "-in": true,
  "-inform": true,
  "-enddate": false,
  "-startdate": false,
  "-dates": false,
  "-subject": false,
  "-issuer": false,
  "-serial": false,
  "-fingerprint": false,
  "-sha1": false,
  "-sha256": false,
  "-checkend": true,
  "-ext": true,
  "-nameopt": true,
  "-text": false,
};

/**
 * Per-binary argument rules, beyond the subcommand list. Each returns why
 * the arguments are refused, or nothing when they are read-only.
 */
const ARGUMENT_CHECKS: Record<string, (args: string[]) => string | undefined> =
  {
    docker: (args) => {
      const [subcommand, ...rest] = positional(args);
      if (subcommand === "system" && (rest[0] !== "df" || rest.length > 1)) {
        return "Only docker system df is allowed";
      }
      const after = splitEquals(args.slice(args.indexOf(subcommand) + 1));
      if (subcommand === "inspect") return dockerInspect(after);
      if (subcommand === "logs") return dockerLogs(after);
      if (subcommand === "stats") return dockerStats(after);
    },
    ip: (args) => {
      // ip a, ip route and friends show; any verb but show/list/get changes.
      const verb = positional(args)[1];
      if (verb !== undefined && !["show", "list", "ls", "get"].includes(verb)) {
        return `ip ... ${verb} is not allowed`;
      }
    },
    journalctl: (args) => {
      const write = args.find((arg) =>
        /^--(vacuum|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)/.test(
          arg,
        ),
      );
      if (write) return `journalctl ${write} is not allowed`;
    },
    date: (args) => {
      if (args.some((arg) => arg === "-s" || arg.startsWith("--set"))) {
        return "Setting the date is not allowed";
      }
    },
    hostname: (args) => {
      if (positional(args).length || args.some((arg) => arg.startsWith("-F"))) {
        return "Setting the hostname is not allowed";
      }
    },
    find: (args) => {
      const write = args.find(
        (arg) => FIND_WRITES.has(arg) || arg.startsWith("-fprint"),
      );
      if (write) return `find ${write} is not allowed`;
    },
    ping: (args) => {
      const flags = onlyFlags(args, {
        "-c": true,
        "-W": true,
        "-w": true,
        "-n": false,
        "-q": false,
        "-4": false,
        "-6": false,
      });
      if ("error" in flags) return `ping ${flags.error}`;
      // Without -c, indexOf is -1 and the check would read the host instead.
      const count = args.indexOf("-c");
      if (count < 0 || !isCount(args[count + 1], 10)) {
        return "ping needs -c with a count of 1 to 10";
      }
      if (flags.rest.length !== 1) return "ping takes one host";
    },
    nc: (args) => {
      // Only port probes: -z with no listen, exec or output options.
      const flags = args.filter((arg) => arg.startsWith("-"));
      if (!flags.some((flag) => /^-[vnu46]*z[vnu46]*$/.test(flag))) {
        return "nc needs -z";
      }
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg.startsWith("-")) continue;
        if (arg === "-w") {
          if (!isCount(args[index + 1], 60)) return "nc -w needs seconds";
          index += 1;
          continue;
        }
        if (!/^-[zvnu46]+$/.test(arg)) return `nc ${arg} is not allowed`;
      }
    },
    timedatectl: (args) => {
      const subcommand = positional(args)[0];
      const allowed = ["status", "show", "timesync-status", "show-timesync"];
      if (subcommand !== undefined && !allowed.includes(subcommand)) {
        return `timedatectl ${subcommand} is not allowed`;
      }
    },
    openssl: (args) => {
      if (args[0] !== "x509") return "Only openssl x509 is allowed";
      if (!args.includes("-noout")) return "openssl x509 needs -noout";
      const flags = onlyFlags(args.slice(1), OPENSSL_X509_FLAGS);
      if ("error" in flags) return `openssl x509 ${flags.error}`;
      if (flags.rest.length) return "openssl x509 reads a file with -in";
      const file = args[args.indexOf("-in") + 1];
      if (args.includes("-in") && !plainPath(file)) {
        return "openssl x509 -in needs an absolute path";
      }
    },
    apt: (args) => {
      const words = args.filter((arg) => arg !== "-qq" && arg !== "-q");
      if (words.join(" ") !== "list --upgradable") {
        return "Only apt list --upgradable is allowed";
      }
    },
    dnf: (args) => packageQuery("dnf", args),
    yum: (args) => packageQuery("yum", args),
    needrestart: (args) => {
      if (args.length !== 1 || args[0] !== "-b") {
        return "Only needrestart -b is allowed";
      }
    },
    kubectl: (args) => kubectl(args),
    k3s: (args) => {
      if (args[0] === "kubectl") return kubectl(args.slice(1));
      if (args[0] === "crictl") return crictl(args.slice(1));
      return "Only k3s kubectl and k3s crictl are allowed";
    },
    crictl: (args) => crictl(args),
    "nvidia-smi": (args) => nvidiaSmi(args),
    zpool: (args) => zpool(args),
    zfs: (args) => zfs(args),
    pvesm: (args) => pvesm(args),
    pvecm: (args) => {
      if (args.length !== 1 || !["status", "nodes"].includes(args[0])) {
        return "Only pvecm status and pvecm nodes are allowed";
      }
    },
    pveversion: (args) => {
      if (
        args.length > 1 ||
        (args.length && !["-v", "--verbose"].includes(args[0]))
      ) {
        return "Only pveversion and pveversion -v are allowed";
      }
    },
    pvesh: (args) => pvesh(args),
    "systemd-detect-virt": (args) => {
      if (
        args.length > 1 ||
        (args.length && !["-c", "--container", "-v", "--vm"].includes(args[0]))
      ) {
        return "Only systemd-detect-virt with no option, --container or --vm is allowed";
      }
    },
    test: (args) => fileTest(args),
    "[": (args) =>
      args.at(-1) === "]" ? fileTest(args.slice(0, -1)) : "[ needs a closing ]",
  };

/** The dnf and yum queries that report and install nothing. */
const PACKAGE_QUERIES = new Set([
  "check-update",
  "updateinfo summary",
  "updateinfo list",
  "updateinfo list security",
  "needs-restarting",
]);

function packageQuery(binary: string, args: string[]): string | undefined {
  const flags = onlyFlags(args, {
    "-q": false,
    "--quiet": false,
    "--security": false,
    "--sec-severity": true,
    "-C": false,
    "--cacheonly": false,
    "-r": false,
  });
  if ("error" in flags) return `${binary} ${flags.error}`;
  const query = flags.rest.join(" ");
  if (!PACKAGE_QUERIES.has(query)) {
    return `Only ${binary} check-update, updateinfo summary or list, and needs-restarting -r are allowed`;
  }
  if ((query === "needs-restarting") !== args.includes("-r")) {
    return `-r is only for ${binary} needs-restarting -r`;
  }
}

/** --flag=value as two words, so flag checks see the flag. */
const splitEquals = (args: string[]) =>
  args.flatMap((arg) =>
    arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg],
  );

const CONTAINER_NAME = /^[A-Za-z0-9][\w.-]*$/;

const containerNames = (names: string[], required: boolean) =>
  (!required || names.length > 0) &&
  names.every((name) => CONTAINER_NAME.test(name));

/** Fields docker inspect may print: state, limits and restart policy. */
const INSPECT_FIELDS = [
  ".State",
  ".RestartCount",
  ".Name",
  ".Id",
  ".Created",
  ".Image",
  ".Config.Image",
  ".HostConfig.Memory",
  ".HostConfig.MemoryReservation",
  ".HostConfig.MemorySwap",
  ".HostConfig.NanoCpus",
  ".HostConfig.OomKillDisable",
  ".HostConfig.RestartPolicy",
];

const inspectField = (field: string) =>
  INSPECT_FIELDS.some(
    (allowed) => field === allowed || field.startsWith(`${allowed}.`),
  );

/** One {{...}} action: a field, or json of a field, and nothing else. */
function inspectAction(action: string): boolean {
  const tokens = action.trim().split(/\s+/);
  const fields = tokens[0] === "json" ? tokens.slice(1) : tokens;
  return fields.length === 1 && /^(\.\w+)+$/.test(fields[0])
    ? inspectField(fields[0])
    : false;
}

/** A template of allowed actions joined by plain text. */
function inspectTemplate(template: string): boolean {
  let valid = true;
  const literal = template.replace(/\{\{([^{}]*)\}\}/g, (_, action) => {
    valid &&= inspectAction(action);
    return "";
  });
  return valid && /^[\w\s=:,./-]*$/.test(literal);
}

const braces = (word: string, pair: string) => word.split(pair).length - 1;

/**
 * docker inspect --format <template> <container>... The template is the
 * words from the one after --format until its braces close, and as long as
 * the next word holds another action; the rest must be container names.
 */
function dockerInspect(args: string[]): string | undefined {
  const names: string[] = [];
  const template: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--format" && args[index] !== "-f") {
      names.push(args[index]);
      continue;
    }
    if (template.length) return "docker inspect takes one --format";
    let open = 0;
    while (
      index + 1 < args.length &&
      (open > 0 || !template.length || args[index + 1].includes("{{"))
    ) {
      index += 1;
      template.push(args[index]);
      open += braces(args[index], "{{") - braces(args[index], "}}");
    }
  }
  if (!template.length || !inspectTemplate(template.join(" "))) {
    return `docker inspect needs --format with only ${INSPECT_FIELDS.join(", ")}`;
  }
  if (!containerNames(names, true)) {
    return "docker inspect takes container names after --format";
  }
}

/** docker logs with a bounded --tail, never following. */
function dockerLogs(args: string[]): string | undefined {
  const flags = onlyFlags(args, {
    "--tail": true,
    "-n": true,
    "--since": true,
    "--until": true,
    "-t": false,
    "--timestamps": false,
  });
  if ("error" in flags) return `docker logs ${flags.error}`;
  const tail = Math.max(args.indexOf("--tail"), args.indexOf("-n"));
  if (tail < 0 || !isCount(args[tail + 1], 1000)) {
    return "docker logs needs --tail with 1 to 1000 lines";
  }
  if (flags.rest.length !== 1 || !containerNames(flags.rest, true)) {
    return "docker logs takes one container";
  }
}

/** docker stats as one sample, never streaming. */
function dockerStats(args: string[]): string | undefined {
  const flags = onlyFlags(args, {
    "--no-stream": false,
    "--no-trunc": false,
    "-a": false,
    "--all": false,
    "--format": true,
  });
  if ("error" in flags) return `docker stats ${flags.error}`;
  if (!args.includes("--no-stream")) return "docker stats needs --no-stream";
}

/** test -f /path and its -e, -d, -s forms: an exit code and nothing else. */
function fileTest(args: string[]): string | undefined {
  if (
    args.length !== 2 ||
    !["-f", "-e", "-d", "-s"].includes(args[0]) ||
    !plainPath(args[1])
  ) {
    return "Only a file test like test -f /path is allowed";
  }
}

/** The values given to any of the named flags. */
const flagValues = (args: string[], names: string[]) =>
  args.flatMap((arg, index) => (names.includes(arg) ? [args[index + 1]] : []));

/** Flags every kubectl verb here may take. */
const KUBECTL_COMMON: Record<string, boolean> = {
  "-n": true,
  "--namespace": true,
  "--context": true,
  "--kubeconfig": true,
  "--request-timeout": true,
};

const KUBECTL_LISTING: Record<string, boolean> = {
  ...KUBECTL_COMMON,
  "-A": false,
  "--all-namespaces": false,
  "-l": true,
  "--selector": true,
  "--field-selector": true,
  "--no-headers": false,
};

/**
 * Kinds whose whole object holds no pod template, environment or data, so
 * describe, -o json and the like may print them. Pods and workloads carry
 * literal environment values and configmaps carry data, the way docker
 * inspect does, so those stay tables.
 */
const KUBECTL_DETAIL_KINDS = new Set([
  "node",
  "nodes",
  "no",
  "namespace",
  "namespaces",
  "ns",
  "service",
  "services",
  "svc",
  "endpoints",
  "ep",
  "endpointslice",
  "endpointslices",
  "event",
  "events",
  "ev",
  "persistentvolume",
  "persistentvolumes",
  "pv",
  "persistentvolumeclaim",
  "persistentvolumeclaims",
  "pvc",
  "storageclass",
  "storageclasses",
  "sc",
  "ingress",
  "ingresses",
  "ing",
  "ingressclass",
  "ingressclasses",
  "resourcequota",
  "resourcequotas",
  "quota",
  "limitrange",
  "limitranges",
  "limits",
  "poddisruptionbudget",
  "poddisruptionbudgets",
  "pdb",
  "horizontalpodautoscaler",
  "horizontalpodautoscalers",
  "hpa",
  "priorityclass",
  "priorityclasses",
  "pc",
  "networkpolicy",
  "networkpolicies",
  "netpol",
]);

const KUBECTL_DETAIL_HINT =
  "nodes, namespaces, services, endpoints, events, volumes and claims, storage classes, ingresses, quotas, limit ranges, disruption budgets, autoscalers, priority classes and network policies";

const KUBECTL_TABLE_OUTPUTS = new Set(["wide", "name"]);

const KUBECTL_FULL_OUTPUT =
  /^(json|yaml|(jsonpath|jsonpath-as-json|custom-columns|go-template|template)=.+)$/;

/** Sort keys that read nothing but names, ages and status, on any kind. */
const KUBECTL_PLAIN_SORT =
  /^\{?\.(metadata\.(name|namespace|creationTimestamp)|status(\.\w+|\[\d+\])+)\}?$/;

/** The kinds a get or describe names: pods,svc or pod/web, without group. */
function kubectlKinds(rest: string[]): string[] {
  const [types = "", ...names] = rest;
  return [types, ...names.filter((name) => name.includes("/"))]
    .flatMap((word) => word.split(","))
    .map((word) => word.split("/")[0].split(".")[0].toLowerCase());
}

const detailKinds = (kinds: string[]) =>
  kinds.every((kind) => KUBECTL_DETAIL_KINDS.has(kind));

/**
 * -o beyond a table, and --sort-by on fields other than names, ages and
 * status, can read any field, so they need detail kinds.
 */
function kubectlOutput(args: string[], kinds: string[]): string | undefined {
  const outputs = flagValues(args, ["-o", "--output"]);
  const unknown = outputs.find(
    (output) =>
      !KUBECTL_TABLE_OUTPUTS.has(output) && !KUBECTL_FULL_OUTPUT.test(output),
  );
  if (unknown !== undefined) return `kubectl -o ${unknown} is not allowed`;
  const full =
    outputs.some((output) => !KUBECTL_TABLE_OUTPUTS.has(output)) ||
    flagValues(args, ["--sort-by"]).some(
      (key) => !KUBECTL_PLAIN_SORT.test(key),
    );
  if (full && !detailKinds(kinds)) {
    return `kubectl -o other than wide or name, and --sort-by beyond names, ages and status, are only for ${KUBECTL_DETAIL_HINT}`;
  }
}

interface KubectlVerb {
  flags: Record<string, boolean>;
  check: (rest: string[], args: string[]) => string | undefined;
}

/** The read-only verbs, with the flags each may take. */
const KUBECTL_VERBS: Record<string, KubectlVerb> = {
  get: {
    flags: {
      ...KUBECTL_LISTING,
      "-o": true,
      "--output": true,
      "--sort-by": true,
      "-L": true,
      "--label-columns": true,
      "--show-labels": false,
      "--show-kind": false,
      "--ignore-not-found": false,
    },
    check: (rest, args) => {
      const kinds = kubectlKinds(rest);
      if (kinds.some((kind) => kind === "secret" || kind === "secrets")) {
        return "kubectl get secrets is not allowed";
      }
      return kubectlOutput(args, kinds);
    },
  },
  describe: {
    flags: KUBECTL_LISTING,
    check: (rest) =>
      detailKinds(kubectlKinds(rest))
        ? undefined
        : `kubectl describe is only for ${KUBECTL_DETAIL_HINT}`,
  },
  top: {
    flags: { ...KUBECTL_LISTING, "--containers": false, "--sort-by": true },
    check: (rest) =>
      ["node", "nodes", "no", "pod", "pods", "po"].includes(rest[0])
        ? undefined
        : "Only kubectl top nodes and top pods are allowed",
  },
  logs: {
    flags: {
      ...KUBECTL_COMMON,
      "--tail": true,
      "-c": true,
      "--container": true,
      "-p": false,
      "--previous": false,
      "--since": true,
      "--since-time": true,
      "--timestamps": false,
      "--all-containers": false,
    },
    check: (rest, args) => {
      const tails = flagValues(args, ["--tail"]);
      if (!tails.length || !tails.every((tail) => isCount(tail, 1000))) {
        return "kubectl logs needs --tail with 1 to 1000 lines";
      }
      if (rest.length !== 1) return "kubectl logs takes one pod";
    },
  },
  events: {
    flags: {
      ...KUBECTL_COMMON,
      "-A": false,
      "--all-namespaces": false,
      "--for": true,
      "--types": true,
      "-o": true,
      "--output": true,
      "--no-headers": false,
    },
    check: (rest, args) =>
      rest.length
        ? "kubectl events takes --for, not names"
        : kubectlOutput(args, ["events"]),
  },
  version: {
    flags: { ...KUBECTL_COMMON, "--client": false },
    check: (rest) =>
      rest.length ? "kubectl version takes no names" : undefined,
  },
  "cluster-info": {
    flags: KUBECTL_COMMON,
    check: (rest) =>
      rest.length
        ? "Only kubectl cluster-info is allowed, not dump"
        : undefined,
  },
  "api-resources": {
    flags: {
      ...KUBECTL_COMMON,
      "--api-group": true,
      "--no-headers": false,
      "-o": true,
      "--output": true,
    },
    check: (rest, args) =>
      rest.length ||
      !flagValues(args, ["-o", "--output"]).every((output) =>
        KUBECTL_TABLE_OUTPUTS.has(output),
      )
        ? "Only kubectl api-resources with -o wide or name is allowed"
        : undefined,
  },
  auth: {
    flags: {
      ...KUBECTL_COMMON,
      "-A": false,
      "--all-namespaces": false,
      "--list": false,
      "--subresource": true,
      "-q": false,
      "--quiet": false,
    },
    check: (rest) =>
      rest[0] === "can-i" ? undefined : "Only kubectl auth can-i is allowed",
  },
};

/** Every verb's flags, to find the verb behind flags such as -n before it. */
const KUBECTL_ANY_FLAG: Record<string, boolean> = Object.assign(
  {},
  ...Object.values(KUBECTL_VERBS).map((verb) => verb.flags),
);

/**
 * kubectl, never with --token, --as, --server, -v or --raw, which onlyFlags
 * refuses, and never near secrets.
 */
function kubectl(raw: string[]): string | undefined {
  const args = splitEquals(raw);
  const all = onlyFlags(args, KUBECTL_ANY_FLAG);
  if ("error" in all) return `kubectl ${all.error}`;
  const [verb = "", ...rest] = all.rest;
  if (!Object.hasOwn(KUBECTL_VERBS, verb)) {
    return `kubectl ${verb} is not on the read-only allowlist`;
  }
  const flags = onlyFlags(args, KUBECTL_VERBS[verb].flags);
  if ("error" in flags) return `kubectl ${verb} ${flags.error}`;
  if (!flagValues(args, ["--kubeconfig"]).every(plainPath)) {
    return "kubectl --kubeconfig needs an absolute path";
  }
  return KUBECTL_VERBS[verb].check(rest, args);
}

/**
 * crictl subcommands and their flags. inspect and info are left out: they
 * print container environment and the registry credentials of the runtime,
 * and -o or -v would print pod annotations.
 */
const CRICTL_FLAGS: Record<string, Record<string, boolean>> = {
  ps: {
    "-a": false,
    "--all": false,
    "-q": false,
    "--quiet": false,
    "--no-trunc": false,
    "--name": true,
    "--pod": true,
    "--state": true,
    "--label": true,
    "--namespace": true,
    "--image": true,
  },
  pods: {
    "-q": false,
    "--quiet": false,
    "--no-trunc": false,
    "--name": true,
    "--namespace": true,
    "--state": true,
    "--label": true,
  },
  images: {
    "-q": false,
    "--quiet": false,
    "--no-trunc": false,
    "--digests": false,
  },
  stats: {
    "-a": false,
    "--all": false,
    "--id": true,
    "--pod": true,
    "--label": true,
  },
  version: {},
  logs: {
    "--tail": true,
    "-p": false,
    "--previous": false,
    "-t": false,
    "--timestamps": false,
    "--since": true,
  },
};

/** crictl as one sample, and logs with a bounded --tail, never following. */
function crictl(raw: string[]): string | undefined {
  const [subcommand = "", ...args] = splitEquals(raw);
  if (!Object.hasOwn(CRICTL_FLAGS, subcommand)) {
    return `crictl ${subcommand} is not on the read-only allowlist`;
  }
  const flags = onlyFlags(args, CRICTL_FLAGS[subcommand]);
  if ("error" in flags) return `crictl ${subcommand} ${flags.error}`;
  if (subcommand !== "logs") return;
  const tails = flagValues(args, ["--tail"]);
  if (!tails.length || !tails.every((tail) => isCount(tail, 1000))) {
    return "crictl logs needs --tail with 1 to 1000 lines";
  }
  if (flags.rest.length !== 1 || !containerNames(flags.rest, true)) {
    return "crictl logs takes one container";
  }
}

const NVIDIA_SMI_FLAGS: Record<string, boolean> = {
  "-L": false,
  "--list-gpus": false,
  "-q": false,
  "--query": false,
  "-d": true,
  "--display": true,
  "-i": true,
  "--id": true,
  "--query-gpu": true,
  "--query-compute-apps": true,
  "--format": true,
};

const NVIDIA_SMI_FIELDS = /^[\w.]+(,[\w.]+)*$/;

/**
 * nvidia-smi queries. Every setter, reset and loop flag is outside the list,
 * and so is -f, which writes the output to a file.
 */
function nvidiaSmi(raw: string[]): string | undefined {
  if (raw[0] === "topo") {
    return raw.join(" ") === "topo -m"
      ? undefined
      : "Only nvidia-smi topo -m is allowed";
  }
  const args = splitEquals(raw);
  const flags = onlyFlags(args, NVIDIA_SMI_FLAGS);
  if ("error" in flags) return `nvidia-smi ${flags.error}`;
  if (flags.rest.length) return "nvidia-smi takes only flags";
  const display = ["-d", "--display"].some((flag) => args.includes(flag));
  if (display && !["-q", "--query"].some((flag) => args.includes(flag))) {
    return "nvidia-smi -d is only for -q";
  }
  const fields = flagValues(args, ["--query-gpu", "--query-compute-apps"]);
  const formats = flagValues(args, ["--format"]);
  if (!fields.every((field) => NVIDIA_SMI_FIELDS.test(field))) {
    return "nvidia-smi --query-gpu takes field names";
  }
  if (
    fields.length > 0 !== formats.length > 0 ||
    !formats.every((format) => /^csv(,(noheader|nounits))*$/.test(format))
  ) {
    return "nvidia-smi --query-gpu and --query-compute-apps need --format=csv";
  }
}

/** Pool names start with a letter, so a number after them is an interval. */
const ZFS_POOL = /^[A-Za-z][\w.:-]*$/;
const ZFS_DATASET = /^[A-Za-z][\w.:/@#-]*$/;

/** Native property and column names. User properties hold a ':', and all includes them. */
const zfsFields = (value: string) =>
  /^[a-z][\w.]*(,[a-z][\w.]*)*$/.test(value) &&
  !value.split(",").includes("all");

const ZPOOL_FLAGS: Record<string, Record<string, boolean>> = {
  status: { "-x": false, "-v": false },
  list: { "-H": false, "-p": false, "-v": false, "-o": true },
  iostat: { "-H": false, "-p": false, "-v": false, "-y": false },
};

/**
 * zpool status, list and iostat. Each repeats forever after an interval, so
 * only iostat takes one, and only with a count.
 */
function zpool(raw: string[]): string | undefined {
  const [subcommand = "", ...args] = raw;
  if (!Object.hasOwn(ZPOOL_FLAGS, subcommand)) {
    return `zpool ${subcommand} is not on the read-only allowlist`;
  }
  const flags = onlyFlags(args, ZPOOL_FLAGS[subcommand]);
  if ("error" in flags) return `zpool ${subcommand} ${flags.error}`;
  if (!flagValues(args, ["-o"]).every(zfsFields)) {
    return "zpool list -o takes property names";
  }
  const split = flags.rest.findIndex((word) => !ZFS_POOL.test(word));
  const pools = split < 0 ? flags.rest : flags.rest.slice(0, split);
  const timing = split < 0 ? [] : flags.rest.slice(split);
  if (subcommand === "iostat") {
    if (
      timing.length &&
      !(timing.length === 2 && isCount(timing[0], 10) && isCount(timing[1], 5))
    ) {
      return "zpool iostat takes an interval of 1 to 10 seconds only with a count of 1 to 5";
    }
    return;
  }
  if (timing.length || pools.length > 1) {
    return `zpool ${subcommand} takes one pool and no interval`;
  }
}

const ZFS_FLAGS: Record<string, Record<string, boolean>> = {
  list: { "-H": false, "-p": false, "-r": false, "-o": true, "-t": true },
  get: { "-H": false, "-p": false, "-r": false, "-o": true, "-t": true },
};

/** zfs list and zfs get of native properties. */
function zfs(raw: string[]): string | undefined {
  const [subcommand = "", ...args] = raw;
  if (!Object.hasOwn(ZFS_FLAGS, subcommand)) {
    return `zfs ${subcommand} is not on the read-only allowlist`;
  }
  const flags = onlyFlags(args, ZFS_FLAGS[subcommand]);
  if ("error" in flags) return `zfs ${subcommand} ${flags.error}`;
  if (!flagValues(args, ["-o", "-t"]).every(zfsFields)) {
    return `zfs ${subcommand} -o and -t take property names, not all`;
  }
  const [properties, ...datasets] =
    subcommand === "get" ? flags.rest : ["", ...flags.rest];
  if (subcommand === "get" && (!properties || !zfsFields(properties))) {
    return "zfs get takes native property names, not all";
  }
  if (
    datasets.length > 1 ||
    !datasets.every((name) => ZFS_DATASET.test(name))
  ) {
    return `zfs ${subcommand} takes one dataset`;
  }
}

/** pvesm status and pvesm list of one storage. */
function pvesm(raw: string[]): string | undefined {
  const [subcommand = "", ...args] = splitEquals(raw);
  if (subcommand === "status") {
    const flags = onlyFlags(args, { "--storage": true, "--content": true });
    if ("error" in flags) return `pvesm status ${flags.error}`;
    if (flags.rest.length) return "pvesm status takes no names";
    return;
  }
  if (subcommand !== "list")
    return "Only pvesm status and pvesm list are allowed";
  const flags = onlyFlags(args, { "--content": true, "--vmid": true });
  if ("error" in flags) return `pvesm list ${flags.error}`;
  if (flags.rest.length !== 1 || !/^[A-Za-z][\w.-]*$/.test(flags.rest[0])) {
    return "pvesm list takes one storage";
  }
}

/**
 * API paths pvesh get may read, * standing for one segment. Listed rather
 * than filtered: agent/file-read, file-restore/download and the ACME and
 * notification plugin settings are GETs that return files and credentials,
 * and guest configs may hold cloud-init passwords.
 */
const PVESH_PATHS = [
  "/version",
  "/cluster/status",
  "/cluster/resources",
  "/cluster/tasks",
  "/cluster/log",
  "/cluster/ha/status/current",
  "/cluster/ha/resources",
  "/cluster/ceph/status",
  "/access/users",
  "/nodes",
  "/nodes/*/status",
  "/nodes/*/version",
  "/nodes/*/time",
  "/nodes/*/dns",
  "/nodes/*/netstat",
  "/nodes/*/network",
  "/nodes/*/services",
  "/nodes/*/syslog",
  "/nodes/*/journal",
  "/nodes/*/rrddata",
  "/nodes/*/tasks",
  "/nodes/*/tasks/*/status",
  "/nodes/*/tasks/*/log",
  "/nodes/*/apt/update",
  "/nodes/*/apt/versions",
  "/nodes/*/disks/list",
  "/nodes/*/disks/smart",
  "/nodes/*/disks/zfs",
  "/nodes/*/storage",
  "/nodes/*/storage/*/status",
  "/nodes/*/storage/*/content",
  "/nodes/*/storage/*/rrddata",
  "/nodes/*/qemu",
  "/nodes/*/qemu/*/status/current",
  "/nodes/*/qemu/*/rrddata",
  "/nodes/*/lxc",
  "/nodes/*/lxc/*/status/current",
  "/nodes/*/lxc/*/rrddata",
];

const PVESH_PATTERNS = PVESH_PATHS.map(
  (path) => new RegExp(`^${path.replaceAll("*", "[\\w.:@-]+")}$`),
);

/** pvesh get of a listed path, with the read parameters those paths take. */
function pvesh(raw: string[]): string | undefined {
  const [method, ...args] = splitEquals(raw);
  if (method !== "get") return "Only pvesh get is allowed";
  const flags = onlyFlags(args, {
    "--output-format": true,
    "--type": true,
    "--timeframe": true,
    "--cf": true,
    "--disk": true,
    "--limit": true,
    "--start": true,
    "--since": true,
    "--until": true,
    "--lastentries": true,
    "--vmid": true,
    "--typefilter": true,
    "--source": true,
  });
  if ("error" in flags) return `pvesh get ${flags.error}`;
  const formats = flagValues(args, ["--output-format"]);
  if (
    !formats.every((format) =>
      ["json", "json-pretty", "text", "yaml"].includes(format),
    )
  ) {
    return "pvesh get --output-format is json, json-pretty, text or yaml";
  }
  if (
    flags.rest.length !== 1 ||
    !PVESH_PATTERNS.some((pattern) => pattern.test(flags.rest[0]))
  ) {
    return `pvesh get reads only ${PVESH_PATHS.join(", ")}`;
  }
}

/**
 * The words the shell will see. Metacharacters are already refused, so
 * removing quotes is all the shell would do: -'del'"ete" is -delete.
 */
function words(command: string): string[] {
  return command
    .split(/\s+/)
    .map((word) => word.replace(/['"]/g, ""))
    .filter(Boolean);
}

export interface CommandCheck {
  allowed: boolean;
  reason?: string;
}

export function isReadOnlyCommand(raw: string): CommandCheck {
  const command = raw.trim();
  if (!command) return { allowed: false, reason: "Empty command" };

  if (SHELL_METACHARACTERS.test(command)) {
    return {
      allowed: false,
      reason: "Command chaining, redirection and substitution are not allowed",
    };
  }

  const parts = words(command);
  if (!parts.length) return { allowed: false, reason: "Empty command" };

  // Reject env-prefixed and privilege-escalating forms outright.
  const head = parts[0];
  if (head === "sudo" || head === "su" || head === "doas" || head === "env") {
    return { allowed: false, reason: `${head} is not allowed` };
  }

  // A path like /usr/bin/df resolves to its basename.
  const binary = head.includes("/")
    ? head.slice(head.lastIndexOf("/") + 1)
    : head;

  if (!READ_ONLY_COMMANDS.has(binary)) {
    return {
      allowed: false,
      reason: `${binary} is not on the read-only allowlist`,
    };
  }

  const allowedSubcommands = SUBCOMMAND_ALLOWLIST[binary];
  if (allowedSubcommands) {
    const subcommand = parts.slice(1).find((part) => !part.startsWith("-"));
    if (!subcommand || !allowedSubcommands.has(subcommand)) {
      return {
        allowed: false,
        reason:
          `${binary} ${subcommand ?? ""}`.trim() +
          " is not on the read-only allowlist",
      };
    }
  }

  const argumentError = ARGUMENT_CHECKS[binary]?.(parts.slice(1));
  if (argumentError) return { allowed: false, reason: argumentError };

  if (binary === "cat") {
    const targets = parts.slice(1).filter((part) => !part.startsWith("-"));
    if (!targets.length) {
      return { allowed: false, reason: "cat needs a file path" };
    }
    for (const target of targets) {
      if (!catPathAllowed(target)) {
        return {
          allowed: false,
          reason: `cat is limited to ${CAT_ALLOWED_PREFIXES.join(", ")}`,
        };
      }
    }
  }

  return { allowed: true };
}
