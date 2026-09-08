import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const solveMaster = vi.hoisted(() => vi.fn());
vi.mock("../../headless/bounded-box-master", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../headless/bounded-box-master")>(),
  solveBoundedBoxMaster: solveMaster,
}));
vi.mock("../../headless/cp-sat-layout", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../headless/cp-sat-layout")>(),
  solveCpSatLayouts: () => ({ status: "dependency-missing", layouts: [] }),
}));
vi.mock("../../headless/certified-area-relaxation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../headless/certified-area-relaxation")>(),
  solveCpSatAreaLowerBound: () => ({
    constraintProfile: "certified-area-relaxation-v3a",
    objective: "horizontal-span-times-origin-anchored-height", status: "dependency-missing",
  }),
}));

import { optimizeHeadlessLayout } from "../../headless/layout-optimizer";
import type { HeadlessOptimizationRequest, HeadlessOptimizationResult } from "../../headless/types";
import type { BoundedBoxMasterOptions } from "../../headless/bounded-box-master";
import { createRegistryContract } from "../../registry";

const request: HeadlessOptimizationRequest = {
  width: 24, height: 24, allowRotate: true,
  targets: [{ itemId: "item_iron_nugget", perMinute: 30 }],
  search: { iterations: 0, routingVariants: 1, scope: "global" },
};

describe("bounded-box optimizer integration", () => {
  beforeEach(() => { solveMaster.mockReset(); });

  it("keeps the same strict incumbent and proof when every box master is exhausted", () => {
    solveMaster.mockReturnValue({
      constraintProfile: "bounded-box-placement-v1", status: "master-infeasible",
      placements: [], stoppedBy: "exhausted",
    });
    const registry = createRegistryContract();
    const baseline = optimizeHeadlessLayout(request, registry);
    expect(solveMaster).not.toHaveBeenCalled();
    const searched = optimizeHeadlessLayout({
      ...request,
      search: { ...request.search, boundedBox: { enabled: true, maxBoxes: 2 } },
    }, registry);
    expect(searched.search.seed).toBe(baseline.search.seed);
    expect(searched.blueprint.blueprintId).toBe(baseline.blueprint.blueprintId);
    expect(searched.blueprint.entities).toEqual(baseline.blueprint.entities);
    expect(searched.layout).toEqual(baseline.layout);
    expect(searched.optimality).toEqual(baseline.optimality);
    expect(searched.optimality.boundingArea.strictRoutedUpperBoundVerified).toBe(true);
    expect(searched.search.boundedBox).toMatchObject({
      status: "no-routed-improvement", boxesAttempted: 2, boxesSat: 0, boxesUnknown: 2,
    });
  }, 30_000);

  it("reroutes a real smaller placement and accepts it only after full strict validation", () => {
    const archived = JSON.parse(readFileSync(resolve("benchmarks/global-layout/iron-nugget-m1-report.json"), "utf8")) as HeadlessOptimizationResult;
    const boundedRequest = JSON.parse(readFileSync(resolve("benchmarks/global-layout/iron-nugget-request.json"), "utf8")) as HeadlessOptimizationRequest;
    solveMaster.mockImplementation((options: BoundedBoxMasterOptions) => ({
      constraintProfile: "bounded-box-placement-v1", status: "success",
      placements: [options.devices.map(({ id }) => {
        const device = archived.layout.devices.find((entry) => entry.id === id)!;
        return { id, ...device.position, width: device.width, height: device.height, rotation: device.rotation };
      })],
    }));
    const result = optimizeHeadlessLayout({
      ...boundedRequest,
      search: {
        ...boundedRequest.search, initialLayout: "topology-sequential",
        iterations: 0, routingVariants: 3,
      },
    }, createRegistryContract());
    expect(result.search.boundedBox).toMatchObject({ status: "improved", boxesSat: 1 });
    expect(result.layout.boundingArea).toBeLessThan(result.search.boundedBox!.warmStartUpperBound);
    expect(result.optimality.boundingArea.strictRoutedUpperBoundVerified).toBe(true);
    expect(result.optimality.boundingArea.upperBound).toBe(result.layout.boundingArea);
    expect(result.validation).toMatchObject({
      errorCount: 0, productionConnectivityVerified: true,
      productionThroughputVerified: true, powerCoverageVerified: true,
    });
    expect(result.layout.boundingArea).toBeLessThanOrEqual(54);
  }, 30_000);

  it("rejects invalid configuration before any search or Python call", () => {
    for (const boundedBox of [{ enabled: true, maxBoxes: 0 }, { enabled: true, maxSecondsPerBox: 31 }]) {
      expect(() => optimizeHeadlessLayout({ ...request, search: { ...request.search, boundedBox } }, createRegistryContract()))
        .toThrow(/search\.boundedBox/);
    }
    expect(() => optimizeHeadlessLayout({
      ...request, search: { scope: "local", boundedBox: { enabled: true } },
    }, createRegistryContract())).toThrow(/global scope/);
    expect(solveMaster).not.toHaveBeenCalled();
  });
});
