import { describe, expect, it } from "vitest";

import type { ItemDomain } from "../../domain/registry/types/entity-definition";
import { measureCertifiedLogisticsFootprintLowerBound } from "../../headless/certified-logistics-footprint";
import type { HeadlessMaterialGraph } from "../../headless/types";

const domainByItem = (itemId: string): ItemDomain =>
  itemId.startsWith("fluid-") ? "liquid" : "solid";

describe("certified logistics footprint lower bound", () => {
  it("uses an allocation-independent maximum for each consumer/item demand", () => {
    const proof = measureCertifiedLogisticsFootprintLowerBound({
      graph: graph([
        node("source-a", "production", [], ["solid"]),
        node("source-b", "production", [], ["solid"]),
        node("target-a", "production", ["solid"], []),
        node("target-b", "storage", ["solid"], []),
      ], [
        edge("source-a", "target-a", "solid", 3),
        edge("source-b", "target-a", "solid", 2),
        edge("source-a", "target-b", "solid", 1),
      ]),
      resolveItemDomain: domainByItem,
    });

    expect(proof).toEqual({
      constraintProfile: "certified-logistics-footprint-v1",
      inputLaneLowerBoundByKind: { belt: 4, pipe: 0 },
      maximumAreaExcludedLaneCountByKind: { belt: 0, pipe: 0 },
      chargedLaneLowerBoundByKind: { belt: 4, pipe: 0 },
      chargedCellLowerBoundByKind: { belt: 2, pipe: 0 },
      chargedCellLowerBound: 2,
    });
  });

  it("subtracts every possible free unloader lane and keeps belt/pipe cells separate", () => {
    const proof = measureCertifiedLogisticsFootprintLowerBound({
      graph: graph([
        node("unloader", "warehouse-port", [], ["solid"], "item_port_unloader_1"),
        node("source", "production", [], ["solid", "fluid-water"]),
        node("solid-target-a", "production", ["solid"], []),
        node("solid-target-b", "storage", ["solid"], []),
        node("pipe-target", "production", ["fluid-water"], []),
      ], [
        edge("unloader", "solid-target-a", "solid", 1),
        edge("source", "solid-target-b", "solid", 1),
        edge("source", "pipe-target", "fluid-water", 3),
      ]),
      resolveItemDomain: domainByItem,
    });

    expect(proof.inputLaneLowerBoundByKind).toEqual({ belt: 2, pipe: 3 });
    expect(proof.maximumAreaExcludedLaneCountByKind).toEqual({ belt: 1, pipe: 0 });
    expect(proof.chargedLaneLowerBoundByKind).toEqual({ belt: 1, pipe: 3 });
    expect(proof.chargedCellLowerBoundByKind).toEqual({ belt: 1, pipe: 2 });
    expect(proof.chargedCellLowerBound).toBe(3);
  });

  it("rejects malformed graph evidence instead of manufacturing a bound", () => {
    expect(() => measureCertifiedLogisticsFootprintLowerBound({
      graph: graph([
        node("source", "production", [], ["solid"]),
      ], [edge("source", "missing", "solid", 1)]),
      resolveItemDomain: domainByItem,
    })).toThrow(/missing endpoint/);

    expect(() => measureCertifiedLogisticsFootprintLowerBound({
      graph: graph([
        node("source", "production", [], ["other"]),
        node("target", "production", ["solid"], []),
      ], [edge("source", "target", "solid", 1)]),
      resolveItemDomain: domainByItem,
    })).toThrow(/inconsistent with its endpoint items/);
  });
});

function node(
  id: string,
  kind: HeadlessMaterialGraph["nodes"][number]["kind"],
  inputItemIds: readonly string[],
  outputItemIds: readonly string[],
  definitionId = "machine",
): HeadlessMaterialGraph["nodes"][number] {
  return {
    id,
    kind,
    definitionId,
    definitionNameKey: definitionId,
    recipeId: kind === "production" ? `recipe:${id}` : null,
    componentId: `component:${id}`,
    layer: 0,
    inputItemIds,
    outputItemIds,
  };
}

function edge(
  sourceId: string,
  targetId: string,
  itemId: string,
  laneCount: number,
): HeadlessMaterialGraph["edges"][number] {
  return { sourceId, targetId, itemId, laneCount };
}

function graph(
  nodes: HeadlessMaterialGraph["nodes"],
  edges: HeadlessMaterialGraph["edges"],
): Pick<HeadlessMaterialGraph, "nodes" | "edges"> {
  return { nodes, edges };
}
