---
title: Auto-ops
order: 3
---

Auto-ops lets the assistant work when nobody is at the keyboard. An automation from the Automations plugin starts it, on a schedule, when a metric crosses a threshold, when a host goes down, or on any other trigger. The assistant follows a runbook you wrote, looks into the hosts, and writes a report. It can also propose a fix, which runs only after someone approves it.

It needs the Automations plugin, the `ai.ops.use` permission and a provider. Admins have `ai.ops.use` by default.

## Two levels

| Level          | What the assistant does                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Report only    | Runs read-only diagnostics and writes a report. It changes nothing.                                                                 |
| Propose a plan | Investigates read-only, then proposes exact commands per host. Nothing changes until the plan is approved; then it runs as written. |

Read-only is enforced, not asked for: while it investigates, the assistant can only run commands from a fixed list such as `df`, `du`, `free`, `systemctl status`, `journalctl --disk-usage`, `docker ps`, `docker system df`, `find` without `-delete` or `-exec`, `ping -c`, `nc -z`, `qm status`, `timedatectl`, `openssl x509 -noout`, `apt list --upgradable`, `dnf updateinfo`, `docker inspect` limited to a container's state, limits and restart policy, `docker logs --tail`, `docker stats --no-stream`, `systemctl list-timers`, and on clusters, GPU, ZFS and Proxmox hosts the read-only forms of `kubectl` (also `k3s kubectl`), `crictl`, `nvidia-smi`, `zpool`, `zfs`, `pvesm`, `pvecm`, `pveversion` and `pvesh get`. Commands that would print secrets stay refused: `kubectl` never touches secrets, prints full objects only for kinds without pod templates or data (nodes, services, events, volumes and the like) and needs `--tail` for logs; `crictl inspect` and `info`, `qm config`, `pct config` and the k3s config file are refused; `pvesh get` reads only a listed set of status, task, storage and log paths; `zfs get all` and user properties are refused. Nothing that loops forever is allowed: `zpool iostat` needs a count, and `nvidia-smi` loop flags are refused. Anything else is refused.

With Termix 26.10.2+ tasks can also read Termix through the CLI and report in your language. Each CLI call signs in as the task's owner with a session of its own that lasts five minutes and is never stored, and only read-only commands run: `hosts` and `credentials` `list` and `get`, `fleets` `list` and `members`, `snippets`, `alerts`, `sessions`, `users`, `api-keys` and `plugins` `list`, `tunnel` `list` and `show`, `docker ps`, `audit-logs`, `status`, `version`, `whoami` and `api GET`. Plans still only hold shell commands. On older Termix versions tasks have no CLI.

## Get started

1. Open AI from the sidebar and switch to Auto-ops at the top.
2. Pick the provider and model your tasks use. Reports are written in your interface language: the language you chose in Termix on 26.10.2+, else the one the AI tab last saw.
3. Under Presets, press Enable on a preset, check the hosts, threshold or time, what the assistant may do and the time limit, and press Enable. This creates an automation that you can change further in Automations.

Without the Automations plugin, presets show Needs Automations.

You can also add an AI task step to any automation in the Automations editor.

## Presets

| Preset                    | When                                                                                   | Level          | What it does                                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Daily patrol              | Every day at 09:00                                                                     | Report only    | Checks every host's disks, memory, load, failed services, containers, certificates, pending updates, pending reboots and time sync.                                                                                                                                                        |
| Disk space cleanup        | A disk at 85% or more for 5 minutes                                                    | Propose a plan | Finds what fills the disk and proposes a cleanup limited to dangling Docker images and build cache, journal older than 7 days, package caches and old rotated logs. Business data is never touched.                                                                                        |
| Host down triage          | A host goes offline                                                                    | Report only    | Probes the host from other hosts and Proxmox nodes and reports whether it is the network, a stopped machine or SSH.                                                                                                                                                                        |
| Service failure           | A health check starts failing                                                          | Propose a plan | Finds the systemd unit behind the check, reads its status and log, and looks for dependency, port, disk, permission and memory causes. Proposes at most `systemctl reset-failed` and one `systemctl restart` of that unit. Never edits configuration, disables or masks units, or reboots. |
| Container anomaly         | A container exits (or turns unhealthy, or restarts: pick the event when you enable it) | Propose a plan | Reads the container's state, exit code, OOM kill, health log, logs and memory against its limit. Proposes at most one `docker start` or `docker restart` of that container. Never removes containers, images or volumes or changes compose files.                                          |
| CPU overload              | CPU at 95% or more for 15 minutes                                                      | Report only    | Finds the top processes and the units and containers they belong to, with load trend, pressure, I/O wait and steal, and recommends what to do.                                                                                                                                             |
| Memory overload           | Memory at 95% or more for 10 minutes                                                   | Report only    | The CPU overload runbook on memory: top processes by memory, swapping and out-of-memory kills.                                                                                                                                                                                             |
| Weekly security updates   | Mondays at 09:30                                                                       | Report only    | Pending security updates by severity (apt, dnf, yum), pending reboots and the packages behind them, running and installed kernels and days since the last update, in one table for all hosts.                                                                                              |
| Weekly certificate expiry | Mondays at 09:45                                                                       | Report only    | Reads the expiry of Let's Encrypt, nginx, Caddy, Apache, kubeadm and k3s certificates and lists Traefik `acme.json` stores; warns under 30 days, critical under 7. Certificates served on live ports are not checked.                                                                      |

Health checks come from Host Metrics and are named by an id, not by the service they probe. When the service failure preset cannot tell which unit a check belongs to, add a line such as `Check c_ab12cd3: nginx.service` at the end of its runbook in the enable form.

When a newer version of a preset ships, its card shows Update available. Your automation is not changed; press Enable again to create one from the new version.

Change a preset's runbook in the enable form, then press Save as preset to keep it as your own. Turn on Share when saved as a preset to offer it to everyone who may use auto-ops.

## Tasks and reports

Every run is listed under Tasks with its status, severity, summary, how long it took and the tokens it used. Open one to read its report: a verdict, the evidence, what was done and what to do next. Open in assistant shows the whole run as a conversation, where you can ask follow-up questions.

You get an alert in the Alerts inbox when a report is ready, a plan is waiting for approval, a plan has run, or a task failed. Test runs from the Automations editor never send alerts and are always report only.

## Approving a plan

Plans waiting for a decision are under Approvals, per host: the commands, why, the risk, how to roll back and the commands that check the result.

- The automation's owner, or anyone with `ai.ops.use` who can connect to every host in the plan, may approve or reject it.
- Approve and run runs the plan as the owner, host by host, each command exactly as shown and in order. A host stops at its first failed command. Then its verify commands run, and a report of what happened is added to the task.
- A plan nobody decides on expires after 24 hours. A host that cannot be reached when the plan runs is skipped.

## Guardrails

An admin sets these under Settings, AI Assistant.

| Setting                          | Default   | What it does                                                                                     |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| Pause AI auto-ops                | Off       | Stops every running task and plan at once and skips new ones.                                    |
| AI tasks per automation per hour | 6         | More triggers in the same hour are skipped.                                                      |
| Token budget per AI task         | 200,000   | A task near its budget is told to report; at the budget it is stopped and reports what it found. |
| Daily AI token budget per user   | 2,000,000 | Counted per UTC day across all AI use. Once used up, that user's tasks are skipped or stopped.   |

A trigger is also skipped while a task for the same automation and host is still running or waiting for approval. A task stops investigating shortly before the automation's time limit to write its report. Every command a task runs is in the audit log as `ai_ops_command`, marked with the task.
