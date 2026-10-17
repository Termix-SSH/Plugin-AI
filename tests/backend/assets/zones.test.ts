import { describe, expect, it } from "vitest";
import { normalizeIp, parseCidr } from "../../../src/backend/assets/net";
import {
  classifyAsset,
  classifyIp,
  compileRules,
  type ZoneRule,
} from "../../../src/backend/assets/zones";

const rule = (overrides: Partial<ZoneRule>): ZoneRule => ({
  name: "lab",
  kind: "internal",
  cidr: "10.0.0.0/8",
  priority: 0,
  ...overrides,
});

describe("addresses", () => {
  it("normalizes what ss prints", () => {
    expect(normalizeIp("[::ffff:10.0.0.1]")).toBe("10.0.0.1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeIp("FD7A::1")).toBe("fd7a::1");
    expect(normalizeIp("web-1")).toBeNull();
  });

  it("parses CIDRs and rejects nonsense", () => {
    expect(parseCidr("10.1.1.0/24")).toMatchObject({ prefix: 24 });
    expect(parseCidr("2001:db8::/32")).toMatchObject({ version: 6 });
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/x")).toBeNull();
    expect(parseCidr("nope/8")).toBeNull();
  });
});

describe("built-in zones", () => {
  const none = compileRules([]);

  it.each([
    ["10.1.2.3", "internal"],
    ["172.20.0.5", "internal"],
    ["192.168.1.10", "internal"],
    ["fd12:3456::1", "internal"],
    ["100.79.120.126", "overlay"],
    ["fd7a:115c:a1e0::4e37:787e", "overlay"],
    ["203.0.113.10", "external"],
    ["2606:4700::1111", "external"],
  ])("%s is %s", (ip, zone) => {
    expect(classifyIp(ip, none)?.name).toBe(zone);
  });

  it.each(["127.0.0.1", "169.254.169.254", "::1", "fe80::1", "0.0.0.0"])(
    "%s has no zone",
    (ip) => {
      expect(classifyIp(ip, none)).toBeNull();
    },
  );

  it("puts a cloud host's addresses in cloud, but not its overlay", () => {
    expect(classifyIp("172.31.5.9", none, true)?.name).toBe("cloud");
    expect(classifyIp("54.1.2.3", none, true)?.name).toBe("cloud");
    expect(classifyIp("100.64.0.9", none, true)?.name).toBe("overlay");
  });
});

describe("user rules", () => {
  it("come before the built-in ones", () => {
    const rules = compileRules([rule({ name: "dc", cidr: "10.1.1.0/24" })]);
    expect(classifyIp("10.1.1.7", rules)).toEqual({
      name: "dc",
      kind: "internal",
      builtin: false,
    });
    expect(classifyIp("10.2.0.1", rules)?.name).toBe("internal");
  });

  it("pick the most specific prefix, then the higher priority", () => {
    const rules = compileRules([
      rule({ name: "wide", cidr: "10.0.0.0/8", priority: 100 }),
      rule({ name: "dgx", cidr: "10.0.1.0/24", kind: "dmz" }),
      rule({ name: "dgx-low", cidr: "10.0.1.0/24", priority: -5 }),
    ]);
    expect(classifyIp("10.0.1.9", rules)?.name).toBe("dgx");
    expect(classifyIp("10.9.9.9", rules)?.name).toBe("wide");
  });

  it("override the cloud and overlay rules too", () => {
    const rules = compileRules([
      rule({ name: "tailnet", kind: "overlay", cidr: "100.64.0.0/10" }),
      rule({ name: "vpc", kind: "cloud", cidr: "172.31.0.0/16" }),
    ]);
    expect(classifyIp("100.79.1.1", rules)?.name).toBe("tailnet");
    expect(classifyIp("172.31.5.9", rules, true)?.name).toBe("vpc");
  });

  it("skip a rule whose CIDR does not parse", () => {
    expect(compileRules([rule({ cidr: "bogus" })])).toEqual([]);
  });
});

describe("asset zones", () => {
  it("take the first address's zone and flag more than one", () => {
    expect(
      classifyAsset(["10.0.0.1", "100.79.120.126"], compileRules([])),
    ).toEqual({
      zone: "internal",
      multiZone: true,
      zones: ["internal", "overlay"],
    });
  });

  it("are single when every address agrees", () => {
    expect(
      classifyAsset(["10.0.0.1", "192.168.0.4", "127.0.0.1"], compileRules([])),
    ).toEqual({ zone: "internal", multiZone: false, zones: ["internal"] });
  });

  it("are empty without addresses", () => {
    expect(classifyAsset([], compileRules([]))).toEqual({
      zone: null,
      multiZone: false,
      zones: [],
    });
  });

  it("can be split by a user rule inside one built-in zone", () => {
    const rules = compileRules([
      rule({ name: "dmz", kind: "dmz", cidr: "10.9.0.0/16" }),
    ]);
    expect(classifyAsset(["10.0.0.1", "10.9.0.1"], rules).multiZone).toBe(true);
  });
});
