import { describe, expect, it } from "vitest";

import { DEFAULT_CP_SAT_OBJECTIVE_WEIGHTS } from "../../headless/cp-sat-layout";
import {
  comparePortPairRoutes,
  compareObjectiveVectors,
  computeAffectedConnections,
  countRouteCrossings,
  countTurnsAndCrossings,
  findCompressibleStraightBeltRows,
  optimizeHeadlessLayout,
} from "../../headless/layout-optimizer";
import { DEFAULT_LAYOUT_OBJECTIVE, type LayoutObjective, type ObjectiveVector } from "../../headless/types";
import { createRegistryContract } from "../../registry";

function makeVector(overrides: Partial<ObjectiveVector> = {}): ObjectiveVector {
  const base: Record<string, number> = {};
  for (const metric of DEFAULT_LAYOUT_OBJECTIVE.priorities) {
    base[metric] = overrides[metric] ?? 0;
  }
  return base as unknown as ObjectiveVector;
}

describe("LayoutObjective default", () => {
  it("defines the frozen 11-metric priority order", () => {
    expect(DEFAULT_LAYOUT_OBJECTIVE.priorities).toEqual([
      "hardViolations",
      "frontageOverflow",
      "boundingArea",
      "contourArea",
      "turnsAndCrossings",
      "logisticsCells",
      "contourVoid",
      "enclosedVoid",
      "boundingVoid",
      "maxSide",
      "powerDevices",
    ]);
    expect(new Set(DEFAULT_LAYOUT_OBJECTIVE.priorities).size).toBe(11);
  });

  it("defines the named CP-SAT projection weights passed by production callers", () => {
    expect(DEFAULT_CP_SAT_OBJECTIVE_WEIGHTS).toEqual({
      boundingArea: 1,
      maxSide: 1,
      logisticsCells: 1,
    });
  });

  it("reports the same winning vector for deterministic runs", () => {
    const request = {
      width: 24,
      height: 24,
      targets: [{ itemId: "item_iron_nugget", perMinute: 30 }],
      search: { iterations: 0, routingVariants: 1, seed: 17 },
    } as const;
    const first = optimizeHeadlessLayout(request, createRegistryContract());
    const second = optimizeHeadlessLayout(request, createRegistryContract());

    expect(first.search.objective).toEqual(second.search.objective);
    expect(first.search.objective.priorities).toEqual(DEFAULT_LAYOUT_OBJECTIVE.priorities);
  });
});

describe("countTurnsAndCrossings", () => {
  it("adds distinct tagged crossing entities to path direction changes", () => {
    expect(countTurnsAndCrossings({
      connections: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }],
      entities: {
        crossing: { tags: ["logistics:crossing", "logistics:crossing"] },
        straight: { tags: ["logistics:belt"] },
      },
    })).toBe(2);
  });
});

describe("findCompressibleStraightBeltRows", () => {
  const devices = [
    {
      id: "source",
      definitionId: "source",
      kind: "production",
      recipeId: null,
      position: { x: 1, y: 0 },
      rotation: 0,
      width: 1,
      height: 1,
    },
    {
      id: "target",
      definitionId: "target",
      kind: "storage",
      recipeId: null,
      position: { x: 1, y: 4 },
      rotation: 0,
      width: 1,
      height: 1,
    },
  ] as const;

  it("finds equipment-free rows occupied only by vertical straight segments", () => {
    expect(findCompressibleStraightBeltRows({
      devices,
      connections: [{
        points: [
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 1, y: 2 },
          { x: 1, y: 3 },
          { x: 1, y: 4 },
        ],
      }],
    })).toEqual([1, 2, 3]);
  });

  it("rejects a complete row when any route turns or ends on it", () => {
    expect(findCompressibleStraightBeltRows({
      devices,
      connections: [
        {
          points: [
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 1, y: 2 },
            { x: 1, y: 3 },
            { x: 1, y: 4 },
          ],
        },
        {
          points: [
            { x: 3, y: 1 },
            { x: 3, y: 2 },
            { x: 4, y: 2 },
          ],
        },
      ],
    })).toEqual([3]);
  });

  it("protects a single-cell bridge that directly joins two outside port cells", () => {
    expect(findCompressibleStraightBeltRows({
      devices,
      connections: [
        {
          points: [
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 1, y: 2 },
            { x: 1, y: 3 },
            { x: 1, y: 4 },
          ],
        },
        {
          points: [{ x: 3, y: 2 }],
        },
      ],
    })).toEqual([1, 3]);
  });
});

describe("port-pair route comparison", () => {
  it("prefers an alternate input route that avoids an existing belt crossing", () => {
    const routedCellOccupations = new Map([
      ["1,1", {
        entityId: "existing-horizontal-belt",
        kind: "belt" as const,
        axis: "horizontal" as const,
        crossed: false,
      }],
    ]);
    const crossed = [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ];
    const uncrossed = [
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ];
    const referenceCells = Array.from({ length: 3 }, (_, y) =>
      Array.from({ length: 4 }, (_unused, x) => ({ x, y }))).flat();

    expect(countRouteCrossings(crossed, routedCellOccupations)).toBe(1);
    expect(countRouteCrossings(uncrossed, routedCellOccupations)).toBe(0);
    expect(comparePortPairRoutes({
      width: 4,
      height: 3,
      referenceCells,
      routedCellOccupations,
      left: crossed,
      right: uncrossed,
    })).toBeGreaterThan(0);
  });

  it("can prioritize a shorter free-port route before a small contour difference", () => {
    const referenceCells = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 0, y: 5 },
      { x: 5, y: 5 },
    ];
    const short = [
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
    ];
    const long = [
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
    ];

    expect(comparePortPairRoutes({
      width: 6,
      height: 6,
      referenceCells,
      routedCellOccupations: new Map(),
      left: short,
      right: long,
      preferShortestPortPair: true,
    })).toBeLessThan(0);
  });
});

describe("compareObjectiveVectors", () => {
  it("returns negative when first differing frozen-priority metric is smaller in left", () => {
    const left = makeVector({ frontageOverflow: 5, boundingArea: 100 });
    const right = makeVector({ frontageOverflow: 5, boundingArea: 200 });
    expect(compareObjectiveVectors(left, right)).toBeLessThan(0);
  });

  it("returns positive when first differing frozen-priority metric is larger in left", () => {
    const left = makeVector({ frontageOverflow: 10, boundingArea: 100 });
    const right = makeVector({ frontageOverflow: 5, boundingArea: 200 });
    expect(compareObjectiveVectors(left, right)).toBeGreaterThan(0);
  });

  it("returns zero when all metrics are equal", () => {
    const left = makeVector({ frontageOverflow: 5, boundingArea: 100 });
    const right = makeVector({ frontageOverflow: 5, boundingArea: 100 });
    expect(compareObjectiveVectors(left, right)).toBe(0);
  });

  it("respects a custom objective priority order", () => {
    const custom: LayoutObjective = {
      priorities: ["boundingArea", "frontageOverflow", "enclosedVoid"],
    };
    const left = makeVector({ frontageOverflow: 10, boundingArea: 100 });
    const right = makeVector({ frontageOverflow: 5, boundingArea: 200 });
    // Custom order: boundingArea first (100 vs 200, left < right -> negative)
    expect(compareObjectiveVectors(left, right, custom)).toBeLessThan(0);
  });

  it("uses the default objective when no custom objective is provided", () => {
    // frontageOverflow is the first metric in default (after hardViolations=0)
    const left = makeVector({ frontageOverflow: 3 });
    const right = makeVector({ frontageOverflow: 5 });
    expect(compareObjectiveVectors(left, right)).toBeLessThan(0);
  });

  it("keeps post-layout power cardinality below primary compactness", () => {
    const fewerPowerDevices = makeVector({ powerDevices: 1, boundingArea: 200 });
    const compactButPowerHeavy = makeVector({ powerDevices: 2, boundingArea: 100 });
    expect(compareObjectiveVectors(compactButPowerHeavy, fewerPowerDevices)).toBeLessThan(0);
  });

  it("uses minimum-required power devices as the final deterministic tie-breaker", () => {
    const fewerPowerDevices = makeVector({ powerDevices: 1 });
    const morePowerDevices = makeVector({ powerDevices: 2 });
    expect(compareObjectiveVectors(fewerPowerDevices, morePowerDevices)).toBeLessThan(0);
  });

  it("prefers a smaller physical contour before filling void with more logistics", () => {
    const compact = makeVector({
      boundingArea: 100,
      contourArea: 80,
      logisticsCells: 30,
      contourVoid: 20,
    });
    const beltFilled = makeVector({
      boundingArea: 100,
      contourArea: 90,
      logisticsCells: 50,
      contourVoid: 5,
    });
    expect(compareObjectiveVectors(compact, beltFilled)).toBeLessThan(0);
  });

  it("treats hardViolations as the highest priority in the frozen order", () => {
    const left = makeVector({ hardViolations: 0, frontageOverflow: 100 });
    const right = makeVector({ hardViolations: 1, frontageOverflow: 0 });
    expect(compareObjectiveVectors(left, right)).toBeLessThan(0);
  });
});

describe("computeAffectedConnections", () => {
  it("returns only connection with a moved source", () => {
    const result = computeAffectedConnections([
      { id: "a", sourceDeviceId: "moved", targetDeviceId: "fixed" },
      { id: "b", sourceDeviceId: "x", targetDeviceId: "y" },
    ], new Set(["moved"]));
    expect(result.connectionIds).toEqual(["a"]);
    expect(result.reasonsByConnectionId["a"]).toEqual(["moved-source"]);
  });

  it("returns only connection with a moved target", () => {
    const result = computeAffectedConnections([
      { id: "a", sourceDeviceId: "fixed", targetDeviceId: "moved" },
      { id: "b", sourceDeviceId: "x", targetDeviceId: "y" },
    ], new Set(["moved"]));
    expect(result.connectionIds).toEqual(["a"]);
    expect(result.reasonsByConnectionId["a"]).toEqual(["moved-target"]);
  });

  it("combines both reasons when source and target are both moved", () => {
    const result = computeAffectedConnections([
      { id: "a", sourceDeviceId: "moved", targetDeviceId: "moved2" },
    ], new Set(["moved", "moved2"]));
    expect(result.connectionIds).toEqual(["a"]);
    expect(result.reasonsByConnectionId["a"]).toEqual(["moved-source", "moved-target"]);
  });

  it("returns sorted unique connection IDs when multiple connections are affected", () => {
    const result = computeAffectedConnections([
      { id: "c", sourceDeviceId: "moved", targetDeviceId: "fixed" },
      { id: "a", sourceDeviceId: "moved", targetDeviceId: "fixed" },
      { id: "b", sourceDeviceId: "x", targetDeviceId: "moved" },
    ], new Set(["moved"]));
    expect(result.connectionIds).toEqual(["a", "b", "c"]);
  });

  it("deduplicates repeated descriptors and unions their reasons deterministically", () => {
    const result = computeAffectedConnections([
      { id: "same", sourceDeviceId: "moved-source", targetDeviceId: "fixed" },
      { id: "same", sourceDeviceId: "fixed", targetDeviceId: "moved-target" },
      { id: "same", sourceDeviceId: "moved-source", targetDeviceId: "moved-target" },
    ], new Set(["moved-source", "moved-target"]));

    expect(result.connectionIds).toEqual(["same"]);
    expect(result.reasonsByConnectionId["same"]).toEqual(["moved-source", "moved-target"]);
  });

  it("returns empty when no moved device IDs match any connection endpoints", () => {
    const result = computeAffectedConnections([
      { id: "a", sourceDeviceId: "x", targetDeviceId: "y" },
    ], new Set(["moved"]));
    expect(result.connectionIds).toEqual([]);
    expect(result.reasonsByConnectionId).toEqual({});
  });

  it("returns empty when movedDeviceIds is empty", () => {
    const result = computeAffectedConnections([
      { id: "a", sourceDeviceId: "moved", targetDeviceId: "fixed" },
    ], new Set([]));
    expect(result.connectionIds).toEqual([]);
  });

  it("does not mutate input arrays", () => {
    const connections = [
      { id: "a", sourceDeviceId: "moved", targetDeviceId: "fixed" },
    ];
    const connectionsCopy = JSON.parse(JSON.stringify(connections));
    const movedIds = new Set(["moved"]);
    computeAffectedConnections(connections, movedIds);
    expect(connections).toEqual(connectionsCopy);
  });
});
