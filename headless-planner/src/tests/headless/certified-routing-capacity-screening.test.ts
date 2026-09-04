import { describe, expect, it } from "vitest";

import {
  CERTIFIED_ROUTING_CAPACITY_SCREENING_PROFILE,
  screenCertifiedRoutingCapacity,
  type CertifiedRoutingCapacityNode,
} from "../../headless/certified-routing-capacity-screening";
import type { CertifiedAreaRelaxationPlacement } from "../../headless/certified-area-relaxation";

describe("certified routing-capacity screening", () => {
  it("finds a vertical material-balance deficit without using producer allocation", () => {
    const result = screenCertifiedRoutingCapacity({
      problem: problem([
        node("source", [], [["iron", 60]]),
        node("target", [["iron", 60]], []),
      ]),
      placements: [placement("source", 0, 0), placement("target", 3, 0)],
    });

    expect(result).toMatchObject({
      constraintProfile: CERTIFIED_ROUTING_CAPACITY_SCREENING_PROFILE,
      screenedPlacementArea: 4,
      activeCutCount: 1,
      violatingCutCount: 1,
      maximumDeficit: 1,
      necessaryConditionViolated: true,
      violatingCuts: [{
        axis: "vertical",
        coordinate: 2,
        demand: 2,
        capacity: 1,
        deficit: 1,
      }],
      strongestCut: {
        axis: "vertical",
        coordinate: 2,
        demand: 2,
        capacity: 1,
        deficit: 1,
        itemDemands: [{
          itemId: "iron",
          requiredLaneCount: 2,
          residualCrossingPerMinute: 60,
          warehouseExemptSupplyPerMinute: 0,
        }],
      },
    });
  });

  it("keeps a one-lane cut nonviolating when its capacity is sufficient", () => {
    const result = screenCertifiedRoutingCapacity({
      problem: problem([
        node("source", [], [["iron", 30]]),
        node("target", [["iron", 30]], []),
      ]),
      placements: [placement("source", 0, 0), placement("target", 3, 0)],
    });

    expect(result.maximumDeficit).toBe(0);
    expect(result.violatingCutCount).toBe(0);
    expect(result.strongestCut).toMatchObject({ demand: 1, capacity: 1, deficit: 0 });
  });

  it("treats warehouse-unloader output as globally available exempt supply", () => {
    const result = screenCertifiedRoutingCapacity({
      problem: problem([
        node("warehouse", [], [["iron", 60]], "warehouse-port"),
        node("target", [["iron", 60]], []),
      ]),
      placements: [placement("warehouse", 0, 0), placement("target", 3, 0)],
    });

    expect(result.activeCutCount).toBe(0);
    expect(result.violatingCutCount).toBe(0);
    expect(result.strongestCut).toBeUndefined();
  });

  it("does not create demand when endpoint halo makes a side ambiguous", () => {
    const result = screenCertifiedRoutingCapacity({
      problem: problem([
        node("source", [], [["iron", 60]]),
        node("target", [["iron", 60]], []),
      ]),
      placements: [placement("source", 1, 0), placement("target", 3, 0)],
    });

    expect(result.activeCutCount).toBe(0);
    expect(result.violatingCutCount).toBe(0);
  });

  it("applies the same conservative screen to horizontal cuts", () => {
    const result = screenCertifiedRoutingCapacity({
      problem: problem([
        node("source", [], [["iron", 60]]),
        node("target", [["iron", 60]], []),
      ]),
      placements: [placement("source", 0, 0), placement("target", 0, 3)],
    });

    expect(result.strongestCut).toMatchObject({
      axis: "horizontal",
      coordinate: 2,
      demand: 2,
      capacity: 1,
      deficit: 1,
    });
  });

  it("does not treat synthetic non-material proof rectangles as fixed blockers", () => {
    const result = screenCertifiedRoutingCapacity({
      problem: problem([
        node("source", [], [["iron", 30]]),
        node("target", [["iron", 30]], []),
      ]),
      placements: [
        placement("source", 0, 0),
        placement("certified-minimum-power-1", 1, 0),
        placement("target", 3, 0),
      ],
    });

    expect(result.violatingCutCount).toBe(0);
    expect(result.strongestCut).toMatchObject({ demand: 1, capacity: 1, deficit: 0 });
  });

  it("rejects an item whose external supply was not modeled", () => {
    expect(() => screenCertifiedRoutingCapacity({
      problem: problem([node("target", [["iron", 30]], [])]),
      placements: [placement("target", 0, 0)],
    })).toThrow(/unmodeled external supply/);
  });
});

function problem(nodes: readonly CertifiedRoutingCapacityNode[]) {
  return {
    items: [{ itemId: "iron", laneCapacityPerMinute: 30 }],
    nodes,
    omittedItems: [],
  } as const;
}

function node(
  id: string,
  inputs: ReadonlyArray<readonly [string, number]>,
  outputs: ReadonlyArray<readonly [string, number]>,
  kind: CertifiedRoutingCapacityNode["kind"] = "production",
): CertifiedRoutingCapacityNode {
  return {
    id,
    kind,
    inputs: inputs.map(([itemId, perMinute]) => ({ itemId, perMinute })),
    outputs: outputs.map(([itemId, perMinute]) => ({ itemId, perMinute })),
  };
}

function placement(
  id: string,
  x: number,
  y: number,
): CertifiedAreaRelaxationPlacement {
  return { id, x, y, width: 1, height: 1, rotation: 0 };
}
