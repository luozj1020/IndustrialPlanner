import { describe, expect, it } from "vitest";

import {
  collectRouteFailureEvidence,
  optimizeHeadlessLayout,
  type RoutedCellOccupation,
} from "../../headless/layout-optimizer";
import { createRegistryContract } from "../../registry";

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
