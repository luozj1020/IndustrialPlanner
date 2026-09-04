import { describe, expect, it } from "vitest";

import type { EntityDefinition } from "../../domain/registry/types/entity-definition";
import { hasValidGeneratedWarehouseHubAdjacency } from "../../headless/warehouse-hub-validation";
import type { HeadlessPlacedDevice } from "../../headless/types";

const sourceDefinition = {
  id: "item_port_log_hongs_bus_source",
  footprint: { width: 4, height: 4 },
  portGroups: [],
} as unknown as EntityDefinition;
const segmentDefinition = {
  id: "item_port_log_hongs_bus",
  footprint: { width: 4, height: 8 },
  portGroups: [],
} as unknown as EntityDefinition;
const portDefinition = {
  id: "item_port_unloader_1",
  footprint: { width: 3, height: 1 },
  portGroups: [{ ports: [{ edge: "SOUTH" }] }],
} as unknown as EntityDefinition;
const definitions = [sourceDefinition, segmentDefinition, portDefinition];

const device = (
  id: string,
  definitionId: string,
  kind: HeadlessPlacedDevice["kind"],
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: HeadlessPlacedDevice["rotation"] = 0,
): HeadlessPlacedDevice => ({
  id,
  definitionId,
  kind,
  recipeId: null,
  position: { x, y },
  rotation,
  width,
  height,
});

const connectedHub = (): HeadlessPlacedDevice[] => [
  device("source", sourceDefinition.id, "warehouse-bus", 0, 0, 4, 4),
  device("segment", segmentDefinition.id, "warehouse-bus", 4, 0, 4, 8),
  // rotation=0 output faces south, so the bus must touch the north side.
  device("port", portDefinition.id, "warehouse-port", 4, 8, 3, 1),
];

describe("generated warehouse hub validation", () => {
  it("accepts a connected segment chain and a port touching its required side", () => {
    expect(hasValidGeneratedWarehouseHubAdjacency({
      devices: connectedHub(),
      entityDefinitions: definitions,
    })).toBe(true);
  });

  it("rejects disconnected bus segments and warehouse ports", () => {
    expect(hasValidGeneratedWarehouseHubAdjacency({
      devices: connectedHub().map((entry) => entry.id === "segment"
        ? { ...entry, position: { x: 5, y: 0 } }
        : entry),
      entityDefinitions: definitions,
    })).toBe(false);
    expect(hasValidGeneratedWarehouseHubAdjacency({
      devices: connectedHub().map((entry) => entry.id === "port"
        ? { ...entry, position: { x: 4, y: 9 } }
        : entry),
      entityDefinitions: definitions,
    })).toBe(false);
  });

  it("uses the rotated physical port edge instead of any-edge adjacency", () => {
    expect(hasValidGeneratedWarehouseHubAdjacency({
      devices: connectedHub().map((entry) => entry.id === "port"
        ? { ...entry, rotation: 180 }
        : entry),
      entityDefinitions: definitions,
    })).toBe(false);
  });

  it("rejects a generated port without exactly one supported bus source", () => {
    const port = connectedHub().find((entry) => entry.id === "port")!;
    expect(hasValidGeneratedWarehouseHubAdjacency({
      devices: [port],
      entityDefinitions: definitions,
    })).toBe(false);
    expect(hasValidGeneratedWarehouseHubAdjacency({
      devices: [connectedHub()[0]!, { ...connectedHub()[0]!, id: "source-2" }, port],
      entityDefinitions: definitions,
    })).toBe(false);
  });

  it("admits a five-port side hub at y=0, disproving a universal shell-depth offset", () => {
    const devices = [
      device("source", sourceDefinition.id, "warehouse-bus", 4, 0, 4, 4),
      device("segment-1", segmentDefinition.id, "warehouse-bus", 4, 4, 4, 8),
      device("segment-2", segmentDefinition.id, "warehouse-bus", 4, 12, 4, 8),
      device("segment-3", segmentDefinition.id, "warehouse-bus", 4, 20, 4, 8),
      ...[0, 4, 7, 12, 15].map((y, index) =>
        // rotation=90 output faces west, so the connected bus is on the east.
        device(`port-${index + 1}`, portDefinition.id, "warehouse-port", 3, y, 1, 3, 90)),
    ];

    expect(Math.min(...devices
      .filter((entry) => entry.kind === "warehouse-port")
      .map((entry) => entry.position.y))).toBe(0);
    expect(hasValidGeneratedWarehouseHubAdjacency({
      devices,
      entityDefinitions: definitions,
    })).toBe(true);
  });
});
