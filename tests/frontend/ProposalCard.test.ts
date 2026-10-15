import { describe, expect, it } from "vitest";
import { fieldRows } from "../../src/frontend/ProposalCard";

describe("fieldRows", () => {
  const names = new Map([
    ["8", "nas"],
    ["9", "pihole"],
  ]);

  it("shows host names instead of ids", () => {
    expect(fieldRows({ hostId: 8 }, names)).toEqual([["hostId", "nas"]]);
    expect(fieldRows({ hostIds: [8, 9] }, names)).toEqual([
      ["hostIds", "nas, pihole"],
    ]);
  });

  it("falls back to the id for unknown hosts", () => {
    expect(fieldRows({ hostId: 42 }, names)).toEqual([["hostId", "42"]]);
  });

  it("skips fields shown in their own block", () => {
    expect(fieldRows({ command: "ls", name: "web" })).toEqual([
      ["name", "web"],
    ]);
  });
});
