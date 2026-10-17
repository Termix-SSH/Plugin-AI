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
  ]),
  // inspect is left out: it prints container environment variables.
  docker: new Set([
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
const CAT_ALLOWED_PREFIXES = ["/proc/", "/sys/", "/etc/os-release"];

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
      if (!isCount(args[args.indexOf("-c") + 1], 10)) {
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
    dnf: (args) => checkUpdate("dnf", args),
    yum: (args) => checkUpdate("yum", args),
    needrestart: (args) => {
      if (args.length !== 1 || args[0] !== "-b") {
        return "Only needrestart -b is allowed";
      }
    },
    test: (args) => fileTest(args),
    "[": (args) =>
      args.at(-1) === "]" ? fileTest(args.slice(0, -1)) : "[ needs a closing ]",
  };

function checkUpdate(binary: string, args: string[]): string | undefined {
  const flags = onlyFlags(args, {
    "-q": false,
    "--quiet": false,
    "--security": false,
    "-C": false,
    "--cacheonly": false,
  });
  if ("error" in flags) return `${binary} ${flags.error}`;
  if (flags.rest.join(" ") !== "check-update") {
    return `Only ${binary} check-update is allowed`;
  }
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
