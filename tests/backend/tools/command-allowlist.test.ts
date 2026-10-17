import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "../../../src/backend/tools/command-allowlist.js";

/**
 * These commands can run without a per-command approval click, so the parser
 * has to refuse anything that could become a second command. Substring
 * matching would pass "df; rm -rf /", which is the whole reason this is
 * argv-based.
 */
describe("isReadOnlyCommand", () => {
  it("allows plain diagnostics", () => {
    for (const command of [
      "df -h",
      "uptime",
      "free -m",
      "whoami",
      "ps aux",
      "lsblk",
      "uname -a",
      "/usr/bin/df -h",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
  });

  it("rejects command chaining and redirection", () => {
    for (const command of [
      "df; rm -rf /",
      "df && curl evil.example",
      "df || reboot",
      "df | sh",
      "df > /etc/passwd",
      "df >> /etc/passwd",
      "cat < /etc/shadow",
      "echo `whoami`",
      "echo $(id)",
      "df\nrm -rf /",
      "df \\\n rm",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("rejects privilege escalation", () => {
    for (const command of ["sudo df -h", "su root", "doas df", "env df"]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("rejects commands that are not on the list", () => {
    for (const command of ["rm -rf /", "curl evil.example", "vi /etc/passwd"]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("limits systemctl and docker to read-only subcommands", () => {
    expect(isReadOnlyCommand("systemctl status nginx").allowed).toBe(true);
    expect(isReadOnlyCommand("systemctl restart nginx").allowed).toBe(false);
    expect(isReadOnlyCommand("systemctl stop nginx").allowed).toBe(false);

    expect(isReadOnlyCommand("docker ps").allowed).toBe(true);
    expect(isReadOnlyCommand("docker stats --no-stream").allowed).toBe(true);
    expect(isReadOnlyCommand("docker rm -f web").allowed).toBe(false);
    expect(isReadOnlyCommand("docker exec -it web sh").allowed).toBe(false);
  });

  it("limits cat to safe paths", () => {
    expect(isReadOnlyCommand("cat /proc/meminfo").allowed).toBe(true);
    expect(isReadOnlyCommand("cat /etc/os-release").allowed).toBe(true);
    expect(isReadOnlyCommand("cat /etc/shadow").allowed).toBe(false);
    expect(isReadOnlyCommand("cat ~/.ssh/id_rsa").allowed).toBe(false);
    expect(isReadOnlyCommand("cat").allowed).toBe(false);
  });

  it("keeps cat inside its paths and away from process secrets", () => {
    for (const command of [
      "cat /proc/../etc/shadow",
      "cat /sys/../../home/alice/.ssh/id_rsa",
      "cat /proc/self/environ",
      "cat /proc/1/environ",
      "cat /proc/thread-self/cmdline",
      "cat /proc/*/environ",
      "cat /sys//../etc/passwd",
      "cat proc/meminfo",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
    expect(isReadOnlyCommand("cat /proc/loadavg").allowed).toBe(true);
    expect(isReadOnlyCommand("cat /sys/class/net/eth0/operstate").allowed).toBe(
      true,
    );
  });

  it("leaves out subcommands that print environment variables", () => {
    expect(isReadOnlyCommand("docker inspect web").allowed).toBe(false);
    expect(isReadOnlyCommand("systemctl show nginx").allowed).toBe(false);
  });

  it("allows docker inspect only for state, limits and restart policy", () => {
    for (const command of [
      "docker inspect --format '{{json .State}}' web",
      "docker inspect -f '{{.State.Status}} {{.RestartCount}}' web db",
      "docker inspect --format='{{.State.OOMKilled}}' web",
      "docker inspect --format '{{.Name}} restarts={{.RestartCount}} memory={{.HostConfig.Memory}} {{json .State.Health}}' web",
      "docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' web",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
    for (const command of [
      "docker inspect web",
      "docker inspect --format '{{json .}}' web",
      "docker inspect --format '{{.Config.Env}}' web",
      "docker inspect --format '{{json .Config}}' web",
      "docker inspect --format '{{.HostConfig.Binds}}' web",
      "docker inspect --format '{{.HostConfig.MemoryX}}' web",
      "docker inspect --format '{{index .Config.Env 0}}' web",
      "docker inspect --format '{{range .Config.Env}}{{.}}{{end}}' web",
      "docker inspect --format '{{.State}}' web '{{.Config.Env}}'",
      "docker inspect --format '{{.State}}' --format '{{.Config.Env}}' web",
      "docker inspect --format '{{.State}}'",
      "docker inspect --type image --format '{{.State}}' web",
      "docker inspect --format '{{.State}} {' web",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("allows docker logs and stats only when they end on their own", () => {
    for (const command of [
      "docker logs --tail 200 web",
      "docker logs --tail=50 --timestamps web",
      "docker logs -n 100 --since 1h web",
      "docker stats --no-stream",
      "docker stats --no-stream --format '{{.Name}} {{.MemPerc}}' web",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
    for (const command of [
      "docker logs web",
      "docker logs 5",
      "docker logs -f --tail 10 web",
      "docker logs --follow --tail 10 web",
      "docker logs --tail 5000 web",
      "docker logs --tail all web",
      "docker logs --tail 10 web db",
      "docker stats",
      "docker stats web",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("allows the dnf and yum advisory and reboot queries", () => {
    for (const command of [
      "dnf updateinfo summary",
      "yum updateinfo summary",
      "dnf updateinfo list security",
      "dnf updateinfo list --security --sec-severity Critical",
      "dnf -q updateinfo list --security",
      "dnf needs-restarting -r",
      "yum needs-restarting -r",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
    for (const command of [
      "dnf updateinfo",
      "dnf updateinfo info",
      "dnf updateinfo list --security --sec-severity",
      "dnf needs-restarting",
      "dnf needs-restarting -s",
      "dnf check-update -r",
      "dnf upgrade --security",
      "dnf upgrade-minimal --security -y",
      "yum update --security",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("lets cat read which packages want a reboot, and nothing next to it", () => {
    expect(isReadOnlyCommand("cat /var/run/reboot-required.pkgs").allowed).toBe(
      true,
    );
    expect(isReadOnlyCommand("cat /run/reboot-required.pkgs").allowed).toBe(
      true,
    );
    for (const command of [
      "cat /var/run/reboot-required.pkgs.bak",
      "cat /var/run/secrets",
      "cat /run/reboot-required.pkgs/../../etc/shadow",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("rejects an empty command", () => {
    expect(isReadOnlyCommand("").allowed).toBe(false);
    expect(isReadOnlyCommand("   ").allowed).toBe(false);
  });

  it("allows the read-only checks auto-ops needs", () => {
    for (const command of [
      "docker system df",
      "docker system df -v",
      "find /var/log -type f -name '*.gz' -mtime +7 -ls",
      "find / -xdev -size +1G",
      "ping -c 3 -W 2 10.0.0.5",
      "nc -z -w 3 10.0.0.5 22",
      "nc -zv 10.0.0.5 22",
      "qm status 101",
      "qm list",
      "pct list",
      "pct status 200",
      "timedatectl",
      "timedatectl show",
      "openssl x509 -noout -enddate -in /etc/ssl/site.pem",
      "apt list --upgradable",
      "dnf check-update -q --security",
      "yum check-update",
      "needrestart -b",
      "test -f /var/run/reboot-required",
      "[ -f /var/run/reboot-required ]",
      "journalctl --disk-usage",
      "ip addr show",
      "ip route get 1.1.1.1",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
  });

  it("refuses the writing forms of those commands", () => {
    for (const command of [
      "docker system prune -af",
      "docker system df prune",
      "find /var/log -name '*.gz' -delete",
      "find / -exec rm {} +",
      "find / -execdir rm",
      "find / -ok rm",
      "find / -fprint /etc/cron.d/x",
      "find / -fprintf /tmp/x %p",
      "find / -fls /tmp/x",
      "find / -'del'\"ete\"",
      "ping 10.0.0.5",
      "ping -c 1000 10.0.0.5",
      "ping -f -c 3 10.0.0.5",
      "nc 10.0.0.5 22",
      "nc -l -p 4444",
      "nc -z -e /bin/sh 10.0.0.5 22",
      "nc -zc sh 10.0.0.5 22",
      "qm start 101",
      "qm destroy 101",
      "pct stop 200",
      "timedatectl set-time 12:00",
      "timedatectl set-ntp false",
      "openssl x509 -in /etc/ssl/a.pem -out /etc/ssl/b.pem",
      "openssl x509 -noout -in /etc/ssl/a.pem -out /tmp/b",
      "openssl req -new",
      "openssl x509 -noout -in relative.pem",
      "apt install curl",
      "apt list --upgradable curl",
      "dnf update -y",
      "yum check-update && yum update",
      "needrestart -r a",
      "needrestart",
      "test -w /etc/passwd",
      "[ -f /etc/passwd",
      "journalctl --vacuum-time=1d",
      "journalctl --rotate",
      "ip link set eth0 down",
      "ip route add default via 10.0.0.1",
      "ip neigh flush all",
      "date -s 2020-01-01",
      "date --set=2020-01-01",
      "hostname evil",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });
});
