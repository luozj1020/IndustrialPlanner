import { describe, expect, it } from "vitest";

import {
  collectRouteFailureEvidence,
  optimizeHeadlessLayout,
  proveRouteCutCapacityConflict,
  proveRouteGeneralCutCapacityConflict,
  proveRoutePlacementConflict,
  type RoutedCellOccupation,
} from "@/headless/layout-optimizer";
import { createRegistryContract } from "@/registry";

describe("headless routing observability", () => {
  it("reports deterministic production and already-routed logistics blockers", () => {
    const routedCellOccupations = new Map<string, RoutedCellOccupation>([[
      "0,1",
      { entityId: "belt-7", kind: "belt", axis: "vertical", crossed: false },
    ]]);
    const evidence = collectRouteFailureEvidence({
      start: { x: 0, y: 0 },
      width: 4,
      height: 4,
      blocked: new Set(["1,0"]),
      routedCellOccupations,
      productionDevices: [{
        id: "crusher-1",
        definitionId: "machine_crusher",
        kind: "production",
        recipeId: "recipe",
        position: { x: 1, y: 0 },
        rotation: 0,
        width: 1,
        height: 1,
      }],
      kind: "belt",
    });

    expect(evidence.reachableCells).toEqual([{ x: 0, y: 0 }]);
    expect(evidence.frontierBlockers).toEqual([
      { x: 1, y: 0, ownerDeviceId: "crusher-1", ownerKind: "production" },
      { x: 0, y: 1, ownerDeviceId: "belt-7", ownerKind: "logistics" },
    ]);
  });

  it("certifies a complete equipment separator but not a wall with a gap", () => {
    const wall = {
      id: "wall",
      definitionId: "machine-wall",
      kind: "production" as const,
      recipeId: "recipe-wall",
      position: { x: 2, y: 0 },
      rotation: 0 as const,
      width: 1,
      height: 5,
    };
    const blockedWall = new Set(["2,0", "2,1", "2,2", "2,3", "2,4"]);
    expect(proveRoutePlacementConflict({
      width: 5,
      height: 5,
      blocked: blockedWall,
      productionDevices: [wall],
      sourceDeviceId: "source",
      targetDeviceId: "target",
      sourceGridPoints: [{ x: 1, y: 2 }],
      targetGridPoints: [{ x: 3, y: 2 }],
    })).toEqual({
      proof: "static-free-space-separator",
      sourceIsBoundary: false,
      targetIsBoundary: false,
      sourceEndpointCount: 1,
      targetEndpointCount: 1,
      reachableCellCount: 10,
      separatorCellCount: 5,
      poseDeviceIds: ["wall"],
    });

    blockedWall.delete("2,3");
    expect(proveRoutePlacementConflict({
      width: 5,
      height: 5,
      blocked: blockedWall,
      productionDevices: [],
      sourceDeviceId: "source",
      targetDeviceId: "target",
      sourceGridPoints: [{ x: 1, y: 2 }],
      targetGridPoints: [{ x: 3, y: 2 }],
    })).toBeNull();
  });

  it("certifies a missing legal endpoint without using route-order evidence", () => {
    expect(proveRoutePlacementConflict({
      width: 5,
      height: 5,
      blocked: new Set(),
      productionDevices: [{
        id: "source",
        definitionId: "machine-source",
        kind: "production",
        recipeId: "recipe-source",
        position: { x: 1, y: 1 },
        rotation: 0,
        width: 1,
        height: 1,
      }],
      sourceDeviceId: "source",
      targetDeviceId: "target",
      sourceGridPoints: [],
      targetGridPoints: [{ x: 3, y: 2 }],
    })).toMatchObject({
      proof: "no-legal-endpoint",
      poseDeviceIds: ["source"],
    });
  });

  it("certifies a frozen multi-lane demand that exceeds a complete grid cut", () => {
    const source = {
      id: "source",
      definitionId: "machine-source",
      kind: "production" as const,
      recipeId: "recipe-source",
      position: { x: 0, y: 0 },
      rotation: 0 as const,
      width: 1,
      height: 2,
    };
    const target = {
      ...source,
      id: "target",
      definitionId: "machine-target",
      recipeId: "recipe-target",
      position: { x: 6, y: 0 },
    };
    const blocker = {
      ...source,
      id: "blocker",
      definitionId: "machine-blocker",
      recipeId: "recipe-blocker",
      position: { x: 3, y: 1 },
      height: 3,
    };
    const blocked = new Set([
      "0,0", "0,1", "6,0", "6,1", "3,1", "3,2", "3,3",
    ]);
    const lanes = [
      {
        id: "lane-a",
        sourceDeviceId: "source",
        targetDeviceId: "target",
        sourceGridPoints: [{ x: 1, y: 0 }],
        targetGridPoints: [{ x: 5, y: 0 }],
      },
      {
        id: "lane-b",
        sourceDeviceId: "source",
        targetDeviceId: "target",
        sourceGridPoints: [{ x: 1, y: 1 }],
        targetGridPoints: [{ x: 5, y: 1 }],
      },
    ];

    expect(proveRouteCutCapacityConflict({
      width: 7,
      height: 4,
      blocked,
      productionDevices: [source, target, blocker],
      lanes,
    })).toEqual({
      proof: "static-cut-capacity",
      axis: "vertical",
      coordinate: 3,
      gridWidth: 7,
      gridHeight: 4,
      demand: 2,
      capacity: 1,
      deficit: 1,
      crossingLaneIds: ["lane-a", "lane-b"],
      endpointPoseDeviceIds: ["source", "target"],
      blockingPoseDeviceIds: ["blocker"],
      fixedBlockedOffsets: [],
      poseDeviceIds: ["blocker", "source", "target"],
    });

    blocked.delete("3,2");
    expect(proveRouteCutCapacityConflict({
      width: 7,
      height: 4,
      blocked,
      productionDevices: [source, target, blocker],
      lanes,
    })).toBeNull();
  });

  it("does not count a lane whose legal endpoints straddle the candidate cut", () => {
    expect(proveRouteCutCapacityConflict({
      width: 7,
      height: 4,
      blocked: new Set(["3,1", "3,2", "3,3"]),
      productionDevices: [],
      lanes: [
        {
          id: "mandatory",
          sourceDeviceId: "source",
          targetDeviceId: "target",
          sourceGridPoints: [{ x: 1, y: 0 }],
          targetGridPoints: [{ x: 5, y: 0 }],
        },
        {
          id: "ambiguous",
          sourceDeviceId: "source",
          targetDeviceId: "target",
          sourceGridPoints: [{ x: 1, y: 1 }, { x: 4, y: 1 }],
          targetGridPoints: [{ x: 5, y: 1 }],
        },
      ],
    })).toBeNull();
  });

  it("certifies an arbitrary residual min-cut when every complete axis cut is wide enough", () => {
    const blocked = new Set(["2,2", "3,3", "2,4"]);
    const lanes = ["lane-a", "lane-b"].map((id) => ({
      id,
      sourceDeviceId: "fixed-source",
      targetDeviceId: "fixed-target",
      sourceGridPoints: [{ x: 2, y: 3 }],
      targetGridPoints: [{ x: 5, y: 3 }],
    }));
    const options = {
      width: 7,
      height: 7,
      blocked,
      productionDevices: [],
      lanes,
    };

    expect(proveRouteCutCapacityConflict(options)).toBeNull();
    expect(proveRouteGeneralCutCapacityConflict(options)).toEqual({
      proof: "static-general-cut-capacity",
      axis: "general",
      coordinate: null,
      gridWidth: 7,
      gridHeight: 7,
      demand: 2,
      capacity: 1,
      deficit: 1,
      crossingLaneIds: ["lane-a", "lane-b"],
      endpointPoseDeviceIds: [],
      blockingPoseDeviceIds: [],
      cutEdges: [
        { from: { x: 2, y: 2 }, to: { x: 2, y: 3 } },
        { from: { x: 1, y: 3 }, to: { x: 2, y: 3 } },
        { from: { x: 2, y: 3 }, to: { x: 3, y: 3 } },
        { from: { x: 2, y: 3 }, to: { x: 2, y: 4 } },
      ],
      fixedBlockedEdgeIndexes: [0, 2, 3],
      poseDeviceIds: [],
    });
  });

  it("does not promote an ambiguous endpoint choice into general-cut demand", () => {
    expect(proveRouteGeneralCutCapacityConflict({
      width: 7,
      height: 7,
      blocked: new Set(["2,2", "3,3", "2,4"]),
      productionDevices: [],
      lanes: [
        {
          id: "mandatory",
          sourceDeviceId: "fixed-source",
          targetDeviceId: "fixed-target",
          sourceGridPoints: [{ x: 2, y: 3 }],
          targetGridPoints: [{ x: 5, y: 3 }],
        },
        {
          id: "ambiguous",
          sourceDeviceId: "fixed-source",
          targetDeviceId: "fixed-target",
          sourceGridPoints: [{ x: 2, y: 3 }, { x: 5, y: 3 }],
          targetGridPoints: [{ x: 5, y: 3 }],
        },
      ],
    })).toBeNull();
  });

  it("shrinks a capacity no-good to the minimum movable blocker subset", () => {
    const wideBlocker = {
      id: "wide",
      definitionId: "machine-wide",
      kind: "production" as const,
      recipeId: "recipe-wide",
      position: { x: 3, y: 0 },
      rotation: 0 as const,
      width: 1,
      height: 2,
    };
    const redundantBlocker = {
      ...wideBlocker,
      id: "redundant",
      definitionId: "machine-redundant",
      recipeId: "recipe-redundant",
      position: { x: 3, y: 2 },
      height: 1,
    };
    const lanes = ["lane-a", "lane-b", "lane-c"].map((id) => ({
      id,
      sourceDeviceId: "fixed-source",
      targetDeviceId: "fixed-target",
      sourceGridPoints: [{ x: 1, y: 3 }],
      targetGridPoints: [{ x: 5, y: 3 }],
    }));

    expect(proveRouteCutCapacityConflict({
      width: 7,
      height: 4,
      blocked: new Set(["3,0", "3,1", "3,2"]),
      productionDevices: [wideBlocker, redundantBlocker],
      lanes,
    })).toMatchObject({
      proof: "static-cut-capacity",
      axis: "vertical",
      coordinate: 3,
      demand: 3,
      capacity: 1,
      blockingPoseDeviceIds: ["wide"],
      poseDeviceIds: ["wide"],
    });
  });

  it("keeps observability additive on a successful heuristic optimization", () => {
    const result = optimizeHeadlessLayout({
      width: 24,
      height: 24,
      targets: [{ itemId: "item_iron_nugget", perMinute: 30 }],
      search: { iterations: 0, routingVariants: 1, cpSat: { enabled: false } },
    }, createRegistryContract());

    expect(result.search.cpSatStatus).toBe("disabled");
    expect(result.search.cpSatPythonVersion).toBeUndefined();
    expect(result.search.cpSatOrToolsVersion).toBeUndefined();
    expect(result.validation.routeFailureDiagnostics).toEqual([]);
  });
});
