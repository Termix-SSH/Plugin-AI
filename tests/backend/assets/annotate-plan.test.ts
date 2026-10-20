import { describe, expect, it } from "vitest";
import {
  batchLimits,
  batchUnits,
  selectUnits,
} from "../../../src/backend/assets/annotate-plan";
import { buildUnits } from "../../../src/backend/assets/annotate-summary";
import { assetRecord, edgeRecord } from "./records";

/** a -> b -> c connected, d alone, a container on a. */
function inventory() {
  const a = assetRecord("host:1", { hostId: 1, name: "a", facts: {} });
  const b = assetRecord("host:2", { hostId: 2, name: "b", facts: {} });
  const c = assetRecord("host:3", { hostId: 3, name: "c", facts: {} });
  const d = assetRecord("host:4", { hostId: 4, name: "d", facts: {} });
  const box = assetRecord("container:1/box", { hostId: 1, facts: {} });
  const edges = [
    edgeRecord(a, b, "connects_to", { detail: { ports: [80] } }),
    edgeRecord(b, c, "connects_to", { detail: { ports: [5432] } }),
    edgeRecord(box, a, "runs_on"),
  ];
  return { assets: [a, b, c, d, box], edges, a, b, c, d, box };
}

/** Marks every asset as annotated with its current summary. */
function annotated(data: ReturnType<typeof inventory>) {
  for (const unit of buildUnits(data.assets, data.edges, new Map())) {
    for (const member of unit.members) {
      member.asset.annotationFingerprint = member.fingerprint;
    }
  }
}

const keys = (units: Array<{ key: string }>) => units.map((unit) => unit.key);

describe("annotation selection", () => {
  it("takes everything never annotated, and nothing once all is current", () => {
    const data = inventory();
    const units = () => buildUnits(data.assets, data.edges, new Map());
    expect(keys(selectUnits(units(), data.edges, false))).toEqual([
      "host:1",
      "host:2",
      "host:3",
      "host:4",
    ]);
    annotated(data);
    expect(selectUnits(units(), data.edges, false)).toEqual([]);
    expect(keys(selectUnits(units(), data.edges, true))).toHaveLength(4);
  });

  it("takes a changed asset with its one-hop neighbours, not two hops away", () => {
    const data = inventory();
    annotated(data);
    data.c.facts = { kubernetes: ["k3s"] };
    const units = buildUnits(data.assets, data.edges, new Map());
    // c changed and b is its neighbour; a is two hops away.
    expect(keys(selectUnits(units, data.edges, false))).toEqual([
      "host:2",
      "host:3",
    ]);
  });

  it("sends a container's whole host unit when the container changed", () => {
    const data = inventory();
    annotated(data);
    data.box.facts = { container: { image: "nginx:2", state: "running" } };
    const units = buildUnits(data.assets, data.edges, new Map());
    const selected = selectUnits(units, data.edges, false);
    expect(keys(selected)).toEqual(["host:1"]);
    expect(selected[0].members.map((m) => m.asset.key)).toEqual([
      "host:1",
      "container:1/box",
    ]);
  });

  it("selects an unlocked asset, whose fingerprint was cleared", () => {
    const data = inventory();
    annotated(data);
    data.d.annotationFingerprint = null;
    const units = buildUnits(data.assets, data.edges, new Map());
    expect(keys(selectUnits(units, data.edges, false))).toEqual(["host:4"]);
  });
});

describe("annotation batches", () => {
  it("are sized to the context and the reply", () => {
    expect(
      batchLimits({ budget: 180_000, reservedOutput: 8_192 }, 1_000),
    ).toEqual({
      tokens: 24_000,
      assets: 40,
    });
    const small = batchLimits({ budget: 6_000, reservedOutput: 1_024 }, 1_000);
    expect(small).toEqual({ tokens: 1_400, assets: 8 });
  });

  it("keep a unit together and split only one too large for any batch", () => {
    const data = inventory();
    const units = buildUnits(data.assets, data.edges, new Map());
    const roomy = batchUnits(units, { tokens: 10_000, assets: 40 });
    expect(roomy).toHaveLength(1);
    expect(roomy[0].members).toHaveLength(5);

    const two = batchUnits(units, { tokens: 10_000, assets: 2 });
    expect(two.map((batch) => batch.members.map((m) => m.asset.key))).toEqual([
      ["host:1", "container:1/box"],
      ["host:2", "host:3"],
      ["host:4"],
    ]);
    const tiny = batchUnits(units, { tokens: 1, assets: 40 });
    expect(tiny).toHaveLength(5);
    expect(tiny.every((batch) => batch.members.length === 1)).toBe(true);
  });
});
