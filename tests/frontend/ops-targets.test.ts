import { describe, expect, it } from "vitest";
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import {
  fleetGroups,
  folderGroups,
  groupState,
  mentionTargets,
  tagGroups,
  targetChips,
  targetGroups,
  toggleHosts,
  toTargetHosts,
} from "../../src/frontend/ops/targets";

const HOSTS = toTargetHosts([
  {
    id: "1",
    name: "web-1",
    ip: "10.0.0.1",
    port: 22,
    folder: "prod / web",
    tags: ["nginx"],
  },
  {
    id: "2",
    name: "web-2",
    ip: "10.0.0.2",
    port: 22,
    folder: "prod / web",
    tags: ["nginx", "edge"],
  },
  {
    id: "3",
    name: "db-1",
    ip: "10.0.0.3",
    port: 22,
    folder: "prod",
    tags: ["postgres"],
  },
  { id: "4", name: "lab", ip: "10.0.0.4", port: 22 },
  { id: "5", name: "rdp", ip: "10.0.0.5", port: 3389, enableSsh: false },
] as PluginHostRecord[]);

describe("Cluster Ops targets", () => {
  it("keeps only hosts with SSH, by name", () => {
    expect(HOSTS.map((host) => host.id)).toEqual([3, 4, 1, 2]);
  });

  it("nests folders and counts every host under one", () => {
    expect(
      folderGroups(HOSTS).map(({ key, depth, hostIds }) => ({
        key,
        depth,
        hostIds,
      })),
    ).toEqual([
      { key: "prod", depth: 0, hostIds: [3, 1, 2] },
      { key: "prod / web", depth: 1, hostIds: [1, 2] },
    ]);
  });

  it("groups hosts by tag", () => {
    expect(
      tagGroups(HOSTS).map(({ name, hostIds }) => [name, hostIds]),
    ).toEqual([
      ["edge", [2]],
      ["nginx", [1, 2]],
      ["postgres", [3]],
    ]);
  });

  it("drops fleet members the picker cannot see", () => {
    expect(
      fleetGroups([{ id: 9, name: "all", hostIds: [1, 5, 77] }], HOSTS),
    ).toEqual([{ key: "9", name: "all", hostIds: [1] }]);
  });

  it("selects the union of groups and shows partial groups", () => {
    const tags = tagGroups(HOSTS);
    const nginx = tags.find((group) => group.name === "nginx")!;
    const postgres = tags.find((group) => group.name === "postgres")!;
    const prod = folderGroups(HOSTS)[0];

    let selected = toggleHosts(new Set(), nginx.hostIds, true);
    selected = toggleHosts(selected, postgres.hostIds, true);
    selected = toggleHosts(selected, prod.hostIds, true);
    expect([...selected].sort()).toEqual([1, 2, 3]);
    expect(groupState(selected, prod.hostIds)).toBe(true);

    selected = toggleHosts(selected, [2], false);
    expect(selected.size).toBe(2);
    expect(groupState(selected, nginx.hostIds)).toBe("indeterminate");
    expect(groupState(selected, [4])).toBe(false);
  });

  it("shows a selection as the fewest chips: groups first, then hosts", () => {
    const groups = targetGroups(HOSTS, [
      { id: 9, name: "web", hostIds: [1, 2] },
    ]);
    const chips = (ids: number[]) =>
      targetChips(new Set(ids), HOSTS, groups).map((chip) => chip.key);

    expect(chips([1, 2])).toEqual(["fleet:9"]);
    expect(chips([1, 2, 3])).toEqual(["fleet:9", "folder:prod"]);
    expect(chips([3, 4])).toEqual(["tag:postgres", "host:4"]);
    expect(chips([2])).toEqual(["tag:edge"]);
    // Hosts the picker does not know have no chip.
    expect(chips([77])).toEqual([]);
  });

  it("finds hosts and groups to @-mention by name", () => {
    const groups = targetGroups(HOSTS, null);
    expect(
      mentionTargets(HOSTS, groups, "WEB").map((chip) => [
        chip.key,
        chip.hostIds,
      ]),
    ).toEqual([
      ["host:1", [1]],
      ["host:2", [2]],
      ["folder:prod / web", [1, 2]],
    ]);
    expect(mentionTargets(HOSTS, groups, "", 2)).toHaveLength(2);
  });
});
