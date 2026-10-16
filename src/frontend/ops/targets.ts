import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";

/**
 * The Cluster Ops target picker's data. The selection is one set of host ids:
 * checking a fleet, folder or tag adds its hosts, unchecking removes them, and
 * a group shows checked when all of its hosts are in the set.
 */

export interface TargetHost {
  id: number;
  name: string;
  ip: string;
  folder: string;
  tags: string[];
}

export interface TargetGroup {
  key: string;
  name: string;
  hostIds: number[];
  /** Folder nesting, for indentation. */
  depth?: number;
}

/** How core joins folder path segments. */
const FOLDER_SEPARATOR = " / ";

/** Hosts commands can run on: SSH turned on. */
export function toTargetHosts(hosts: PluginHostRecord[]): TargetHost[] {
  return hosts
    .filter((host) => host.enableSsh !== false)
    .map((host) => ({
      id: Number(host.id),
      name: host.name || host.ip,
      ip: host.ip,
      folder: host.folder?.trim() ?? "",
      tags: host.tags ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every folder and parent folder, each holding the hosts anywhere under it. */
export function folderGroups(hosts: TargetHost[]): TargetGroup[] {
  const groups = new Map<string, TargetGroup>();
  for (const host of hosts) {
    const parts = host.folder
      .split(FOLDER_SEPARATOR)
      .map((part) => part.trim())
      .filter(Boolean);
    parts.forEach((part, depth) => {
      const key = parts.slice(0, depth + 1).join(FOLDER_SEPARATOR);
      const group = groups.get(key) ?? { key, name: part, hostIds: [], depth };
      group.hostIds.push(host.id);
      groups.set(key, group);
    });
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function tagGroups(hosts: TargetHost[]): TargetGroup[] {
  const groups = new Map<string, TargetGroup>();
  for (const host of hosts) {
    for (const tag of host.tags) {
      const group = groups.get(tag) ?? { key: tag, name: tag, hostIds: [] };
      group.hostIds.push(host.id);
      groups.set(tag, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Fleet members the picker knows, so a fleet never adds an unseen host. */
export function fleetGroups(
  fleets: Array<{ id: number; name: string; hostIds: number[] }>,
  hosts: TargetHost[],
): TargetGroup[] {
  const known = new Set(hosts.map((host) => host.id));
  return fleets.map((fleet) => ({
    key: String(fleet.id),
    name: fleet.name,
    hostIds: fleet.hostIds.filter((id) => known.has(id)),
  }));
}

export function toggleHosts(
  selected: Set<number>,
  hostIds: number[],
  on: boolean,
): Set<number> {
  const next = new Set(selected);
  for (const id of hostIds) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

export function groupState(
  selected: Set<number>,
  hostIds: number[],
): boolean | "indeterminate" {
  const count = hostIds.filter((id) => selected.has(id)).length;
  if (!count) return false;
  return count === hostIds.length ? true : "indeterminate";
}

export function hostMatches(host: TargetHost, query: string): boolean {
  if (!query) return true;
  return [host.name, host.ip, host.folder, ...host.tags]
    .join(" ")
    .toLowerCase()
    .includes(query.toLowerCase());
}
