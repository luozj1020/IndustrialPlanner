import { describe, expect, it } from "vitest";

import { createBoundedBoxDevices, resolveBoundedBoxWarmStartRequest } from "@/headless/bounded-box-problem";
import type { HeadlessPlacedDevice } from "@/headless/types";
import { createRegistryContract } from "@/registry";

const registry = createRegistryContract();
const machine = {
  id: "machine", kind: "production", config: {},
  definition: registry.entityDefinitions.find((d) => d.id === "item_port_furnance_1")!,
  inputs: new Map([["ore", 60]]), outputs: new Map([["ingot", 30]]),
};
const incumbent: HeadlessPlacedDevice = {
  id: machine.id, kind: "production", definitionId: machine.definition.id,
  recipeId: null, position: { x: 4, y: 5 }, width: 3, height: 3, rotation: 180,
};
const options = {
  requests: [machine], incumbent: [incumbent], allowRotate: true,
  itemKind: () => "belt" as const, laneCapacity: () => 30,
};

describe("bounded-box search inventory", () => {
  it("isolates the local sequential constructor from global box configuration", () => {
    const request = {
      width: 64, height: 112, targets: [{ itemId: "battery", perMinute: 6 }],
      search: {
        scope: "global" as const, initialLayout: "topology-sequential" as const,
        iterations: 0, seed: 20260804, boundedBox: { enabled: true, maxBoxes: 4 },
      },
    };
    const warmStart = resolveBoundedBoxWarmStartRequest(request);
    expect(warmStart.search).toEqual({
      scope: "local", initialLayout: "topology-sequential", iterations: 0,
      seed: 20260804, boundedBox: undefined,
    });
    expect(request.search.scope).toBe("global");
    expect(request.search.boundedBox.enabled).toBe(true);
    const disabled = { ...request, search: { ...request.search, boundedBox: { enabled: false } } };
    expect(resolveBoundedBoxWarmStartRequest(disabled)).toBe(disabled);
  });

  it("derives lane cardinality and orientation-specific ports without current flow pairing", () => {
    const device = createBoundedBoxDevices(options)[0]!;
    expect(device.portRequirements!.map((r) => r.requiredCount)).toEqual([2, 1]);
    for (const requirement of device.portRequirements!) {
      expect(requirement.ports.length).toBeGreaterThanOrEqual(requirement.requiredCount);
      expect(Object.keys(requirement.ports[0]!.offsets)).toEqual(["0", "90", "180", "270"]);
      expect(requirement).not.toHaveProperty("escapeDepth");
    }
  });

  it("only shifts soft hints and respects the complete physical incumbent", () => {
    expect(createBoundedBoxDevices(options)[0]!.hintPlacement).toEqual({ x: 4, y: 0, rotation: 180 });
    const unchargedBus: HeadlessPlacedDevice = {
      ...incumbent, id: "bus", kind: "warehouse-bus", position: { x: 0, y: 0 },
    };
    expect(createBoundedBoxDevices({ ...options, incumbent: [incumbent, unchargedBus] })[0]!.hintPlacement)
      .toEqual({ x: 4, y: 5, rotation: 180 });
  });

  it("keeps warehouse auxiliaries uncharged and derives the port bus side for every rotation", () => {
    const requests = [
      ["source", "warehouse-bus", "item_port_log_hongs_bus_source"],
      ["segment", "warehouse-bus", "item_port_log_hongs_bus"],
      ["port", "warehouse-port", "item_port_unloader_1"],
    ].map(([id, kind, definitionId]) => ({
      ...machine, id: id!, kind: kind!, inputs: new Map<string, number>(), outputs: new Map<string, number>(),
      definition: registry.entityDefinitions.find((d) => d.id === definitionId)!,
    }));
    const devices = createBoundedBoxDevices({ ...options, requests, incumbent: [] });
    expect(devices.map((d) => [d.warehouseRole, d.charged])).toEqual([
      ["source", false], ["segment", false], ["port", true],
    ]);
    expect(new Set(Object.values(devices[2]!.busEdges!))).toEqual(new Set(["NORTH", "EAST", "SOUTH", "WEST"]));
    expect(devices[2]!.hintPlacement).toBeUndefined();
  });
});
