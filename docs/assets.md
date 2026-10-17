# Asset inventory

Assets, in the AI tab next to Auto-ops, is an inventory of what runs where. It collects facts from your hosts with one read-only script, works out zones and relations from them, and shows the result as a table. Nothing here uses a model yet: every fact comes from a command, so a collection can be repeated and checked.

## What it collects

Once per host, one script over SSH with the same watchdog, timeout and parallel host limit as the assistant's commands (Settings, AI Assistant). Each part is optional; a host without `ip -j`, `ss`, systemd or Docker simply has less to show.

| Part           | Command                                                                                 |
| -------------- | --------------------------------------------------------------------------------------- |
| System         | `/etc/os-release`, `hostname`, `/proc/uptime`                                           |
| Network        | `ip -j addr`, `ip -j route`                                                             |
| Listening      | `ss -H -tulnp`                                                                          |
| Connections    | `ss -H -tnp state established`, grouped by peer and service port                        |
| Services       | `systemctl list-units --type=service --state=running`                                   |
| Containers     | `docker ps`                                                                             |
| Kubernetes     | `systemctl is-active k3s k3s-agent kubelet`                                             |
| Proxmox        | `pvesh get /cluster/resources --type vm`                                                |
| Cloud metadata | GETs with a 1 second limit to AWS, Alibaba Cloud, Tencent Cloud, Google Cloud and Azure |

What is kept is cut down on purpose: a process is only its executable name (never its arguments or environment), a container is its name, image, state, ports and networks (never its command, labels or mounts), and cloud metadata is only the provider, instance id and region. Google Cloud and Azure are asked for those single values, not the instance document, so tags, keys and user data never leave the host. Lists are capped at 300 entries per host.

## Assets

| Kind      | Key                         | What it is                                                                 |
| --------- | --------------------------- | -------------------------------------------------------------------------- |
| Host      | `host:<id>`                 | A Termix host. Every host is listed, also one that could not be collected. |
| Guest     | `guest:<node>/<vmid>`       | A Proxmox VM or LXC that is not a Termix host.                             |
| Container | `container:<hostId>/<name>` | A running Docker container.                                                |
| External  | `external:<ip>`             | An address outside the inventory that a host connects to.                  |

A host's addresses are the one Termix connects to, then those on its interfaces, without loopback, link-local and container or VM bridges (`docker0`, `br-*`, `veth*`, `cni*`, `virbr*` and similar). A guest or container that disappears, and a host deleted in Termix, is marked removed rather than deleted; Show removed lists them.

### Proxmox guests and Termix hosts

`pvesh` names guests but does not give their addresses, so a guest is matched to a Termix host by name: a guest whose name equals a host's Termix name or its collected hostname, ignoring case, is that host. It gets no asset of its own, and the host gets a `runs_on` edge to the Proxmox node. A name two hosts share matches neither. Nodes are found the same way. Every node of a cluster lists the whole cluster, so a guest reported twice is still one asset.

### Relations

| Edge          | From                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs_on`     | A guest, or a host matched to a guest, to its Proxmox node; a container to its host.                                                         |
| `connects_to` | A host's outbound connections, to the asset that owns the peer address, with ports, processes and a count. Its evidence is the `ss` summary. |

Only outbound connections count: the local port is not one the host listens on and the peer's port is a service port (below 32768). Inbound clients appear from their own side once they are collected, and the public clients of a web server would otherwise flood the inventory. An address no asset owns becomes an external asset, at most 25 per host, busiest first. An address two assets claim is skipped. An edge not seen again keeps its last seen time and shows as stale; edges are never deleted.

## Zones

Built-in rules, in order:

| Addresses                                          | Zone                                     |
| -------------------------------------------------- | ---------------------------------------- |
| Loopback, link-local                               | None                                     |
| `100.64.0.0/10`, Tailscale's `fd7a:115c:a1e0::/48` | Overlay                                  |
| A host whose cloud metadata answered               | Cloud (provider and region in its facts) |
| RFC 1918, IPv6 ULA                                 | Internal                                 |
| Anything else                                      | External                                 |

Zone rules come first: a CIDR mapped to a named zone of kind internal, DMZ, external, cloud or overlay, such as `10.1.1.0/24` as "Data center LAN". The most specific prefix wins, then the higher priority. Saving a rule zones every asset again at once.

An asset's zone is that of its first address that has one, so a host's is decided by the address Termix connects to. An asset with addresses in more than one zone is marked multi-zone: it can reach both sides, which makes it a potential pivot. A container or guest without addresses takes the zone of what it runs on.

A manager can pin an asset's zone in its detail view. Collections and rule changes never overwrite a pinned zone; Decided by the rules hands it back.

## When it collects

- Every day at 03:00 UTC, or the time set under Zones and schedule (also in Settings, AI Assistant).
- When a host is added or changed in Termix, for that host only. Adding needs a Termix version that sends `host.created`; older ones pick new hosts up in the daily run.
- On Collect now.

One collection runs at a time. What arrives during one waits: a host change becomes a run for that host afterwards, or is part of the next full run. Automatic collections need the AI assistant turned on for the server.

Collection runs as one user, the collector, so it reaches exactly the hosts that user can connect to. The first manager to press Collect now becomes the collector; another manager can take over with Collect as me. Nobody can name another user. Automatic runs stop while the collector does not hold `ai.assets.manage`, and the run list says so.

## Permissions

| Permission         | What it allows                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `ai.assets.view`   | See the inventory, zones, relations and runs. Admins only by default.                                          |
| `ai.assets.manage` | Collect now, edit zone rules, pin zones, change the schedule and become the collector. Admins only by default. |

Both also need the AI assistant turned on for the server and the user, like the rest of the AI tab.

## Not yet

AI annotations (role, importance, owning system), the graph view and impact analysis come next; the inventory already has room for them. Attack surface (exposed entry points, DNAT and reverse proxies, cross-zone paths) and cloud APIs come after.
