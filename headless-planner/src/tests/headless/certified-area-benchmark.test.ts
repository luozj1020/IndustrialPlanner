import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  benchmarkCertifiedAreaBounds,
  certifyArchivedAreaBestKnownArtifact,
  createCertifiedAreaBenchmarkInstanceHash,
  createCertifiedAreaGameRuleAttribution,
  formatCertifiedAreaBenchmarkMarkdown,
  parseCertifiedAreaBestKnownArtifact,
  type CertifiedAreaBenchmarkSolver,
} from "../../headless/certified-area-benchmark";
import {
  CERTIFIED_AREA_RELAXATION_OBJECTIVE,
  CERTIFIED_AREA_RELAXATION_PROFILE,
} from "../../headless/certified-area-relaxation";
import {
  createCertifiedAreaMandatoryDevices,
  measureCertifiedAreaByCategory,
} from "../../headless/certified-area-mandatory-devices";
import { createRegistryContract } from "../../registry";
import { buildHeadlessMaterialGraph } from "../../headless/layout-optimizer";
import type { HeadlessOptimizationRequest, HeadlessOptimizationResult } from "../../headless/types";

const TEST_CASE = {
  name: "identical-rectangles",
  instanceHash: "fnv1a32:test0001",
  devices: [
    { id: "a", width: 2, height: 2 },
    { id: "b", width: 2, height: 2 },
  ],
  limitWidth: 8,
  limitHeight: 8,
  allowRotate: true,
  currentRoutedUpperBound: 12,
} as const;

const ATTRIBUTION = {
  rawFootprintAreaByKind: { production: 8, belt: 2 },
  chargedFootprintAreaByKind: { production: 8, belt: 1 },
  chargedFootprintArea: 9,
  chargedBoundingRemainderArea: 1,
  chargedBoundsWidth: 5,
  chargedBoundsSpanHeight: 2,
  chargedMinimumY: 0,
  originAnchoringArea: 0,
  interiorBoundingRemainderArea: 1,
  areaExcludedBeltArea: 1,
  warehouseBusArea: 0,
  materialLaneCountByKind: { belt: 1 },
  connectedPortEndpointCount: 2,
  minimumPowerDeviceCount: 0,
} as const;

describe("certified area benchmark", () => {
  it("includes frozen warehouse ports and one globally necessary power diffuser in v3a", () => {
    const registry = createRegistryContract();
    const devices = createCertifiedAreaMandatoryDevices({
      entities: [
        { id: "machine", kind: "production", definitionId: "item_port_furnance_1" },
        { id: "unloader", kind: "warehouse-port", definitionId: "item_port_unloader_1" },
      ],
      entityDefinitions: registry.entityDefinitions,
    });

    expect(devices.map((device) => device.category)).toEqual([
      "production",
      "warehouse-port",
      "minimum-power",
    ]);
    expect(measureCertifiedAreaByCategory(devices)).toEqual({
      production: 9,
      "warehouse-port": 3,
      "minimum-power": 4,
    });
  });

  it("measures CP-SAT bounds independently and formats the requested gap budget", () => {
    const solver: CertifiedAreaBenchmarkSolver = (options) => ({
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      status: "feasible",
      rawBestObjectiveBound: options.maxSeconds < 2 ? 8 : 10,
      certifiedIntegerLowerBound: options.maxSeconds < 2 ? 8 : 10,
      masterIncumbentArea: 11,
      elapsedMs: options.maxSeconds * 1_000,
    });
    const report = benchmarkCertifiedAreaBounds({
      cases: [TEST_CASE],
      budgetsSeconds: [10, 0.5, 2, 2],
    }, solver);

    expect(report.budgetsSeconds).toEqual([0.5, 2, 10]);
    expect(report.gapBudgetSeconds).toBe(2);
    expect(report.cases[0]).toMatchObject({
      mandatoryDeviceArea: 8,
      currentRoutedUpperBound: 12,
      benchmarkUpperBound: 12,
      samples: [
        {
          maxSeconds: 0.5,
          solverStatus: "feasible",
          cpSatArea: 8,
          lowerBound: 8,
          upperBound: 12,
          masterAbsoluteGap: 3,
          masterProofClosed: false,
        },
        {
          maxSeconds: 2,
          cpSatArea: 10,
          lowerBound: 10,
          absoluteGap: 2,
          masterIncumbentArea: 11,
          masterAbsoluteGap: 1,
        },
        { maxSeconds: 10, cpSatArea: 10, lowerBound: 10, absoluteGap: 2 },
      ],
    });
    expect(report.cases[0]!.samples[1]!.relativeGap).toBeCloseTo(1 / 6);
    const markdown = formatCertifiedAreaBenchmarkMarkdown(report);
    expect(markdown).toContain("current UB | best UB | benchmark UB");
    expect(markdown).toContain("feasible; LB=10; M=11; ΔM=1/9.1%");
  });

  it("uses a matched validated best-known UB and exposes current search regression", () => {
    const bestKnown = {
      schemaVersion: 1,
      validationProfile: "strict-routed-bounding-area-v2",
      instanceHash: TEST_CASE.instanceHash,
      strictRoutedUpperBound: 10,
      blueprintId: "best-blueprint",
      topologyId: "best-topology",
      sourceArtifact: "best-report.json",
      areaAttribution: ATTRIBUTION,
    } as const;
    const report = benchmarkCertifiedAreaBounds({
      cases: [{ ...TEST_CASE, validatedBestKnown: bestKnown }],
      budgetsSeconds: [2],
    }, () => ({
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      status: "optimal",
      rawBestObjectiveBound: 8,
      certifiedIntegerLowerBound: 8,
      masterIncumbentArea: 8,
    }));

    expect(report.cases[0]).toMatchObject({
      currentRoutedUpperBound: 12,
      bestKnownStrictUpperBound: 10,
      benchmarkUpperBound: 10,
      currentRoutedUpperBoundRegression: 2,
      bestKnownArtifact: "best-report.json",
    });
    expect(report.cases[0]!.samples[0]).toMatchObject({
      upperBound: 10,
      absoluteGap: 2,
      masterProofClosed: true,
    });
    expect(() => benchmarkCertifiedAreaBounds({
      cases: [{
        ...TEST_CASE,
        validatedBestKnown: { ...bestKnown, instanceHash: "fnv1a32:wrong" },
      }],
      budgetsSeconds: [2],
    })).toThrow(/instance hash mismatch/);
    expect(parseCertifiedAreaBestKnownArtifact(bestKnown, TEST_CASE.instanceHash))
      .toEqual(bestKnown);
    expect(() => parseCertifiedAreaBestKnownArtifact(bestKnown, "fnv1a32:other"))
      .toThrow(/Invalid or mismatched/);
  });

  it("re-certifies the tracked 330-cell medium best-known artifact", () => {
    const registry = createRegistryContract();
    const request = JSON.parse(readFileSync(resolve(
      process.cwd(),
      "examples/headless/medium-valley-battery-topology-global-request.json",
    ), "utf8")) as HeadlessOptimizationRequest;
    const result = JSON.parse(readFileSync(resolve(
      process.cwd(),
      "examples/headless/medium-valley-battery-topology-global-report.json",
    ), "utf8")) as HeadlessOptimizationResult;
    const graph = buildHeadlessMaterialGraph(request, registry);
    const devices = createCertifiedAreaMandatoryDevices({
      entities: graph.nodes.map(({ id, kind, definitionId }) => ({ id, kind, definitionId })),
      entityDefinitions: registry.entityDefinitions,
    });
    const instanceHash = createCertifiedAreaBenchmarkInstanceHash({
      request,
      graph,
      devices,
      registry,
    });
    const certified = certifyArchivedAreaBestKnownArtifact({
      instanceHash,
      result,
      expectedGraph: graph,
      request,
      registry,
      sourceArtifact: "examples/headless/medium-valley-battery-topology-global-report.json",
    });
    const stored = parseCertifiedAreaBestKnownArtifact(JSON.parse(readFileSync(resolve(
      process.cwd(),
      "benchmarks/certified-area/medium-valley-battery-topology-global-best-known.json",
    ), "utf8")) as unknown, instanceHash);

    expect(instanceHash).toBe("fnv1a32:c8ff94e5");
    expect(certified.strictRoutedUpperBound).toBe(330);
    expect(stored).toEqual(certified);
  });

  it("attributes the incumbent area to game entity classes without treating it as a bound", () => {
    const attribution = createCertifiedAreaGameRuleAttribution({
      layout: {
        devices: [
          { id: "p", definitionId: "machine", kind: "production", position: { x: 0, y: 1 }, width: 2, height: 2 },
          { id: "w", definitionId: "item_port_unloader_1", kind: "warehouse-port", position: { x: 0, y: 3 }, width: 1, height: 3 },
          { id: "b1", definitionId: "belt", kind: "belt", position: { x: 2, y: 0 }, width: 1, height: 1 },
          { id: "b2", definitionId: "belt", kind: "belt", position: { x: 3, y: 1 }, width: 1, height: 1 },
          { id: "bus", definitionId: "bus", kind: "warehouse-bus", position: { x: 4, y: 0 }, width: 4, height: 4 },
          { id: "power", definitionId: "power", kind: "power", position: { x: 1, y: 4 }, width: 2, height: 2 },
        ],
        areaExcludedBeltCellCount: 1,
        boundingArea: 24,
        minimumPowerDeviceCount: 1,
      },
      validation: {
        materialConnections: [{
          itemId: "item",
          kind: "belt",
          sourceDeviceId: "w",
          targetDeviceId: "p",
        }],
      },
      blueprint: {
        entities: {
          b1: { tags: ["connection:item:w->p:1"] },
          b2: { tags: ["connection:other"] },
        },
      },
    } as never);

    expect(attribution).toMatchObject({
      chargedFootprintArea: 12,
      chargedBoundingRemainderArea: 12,
      chargedBoundsWidth: 4,
      chargedBoundsSpanHeight: 5,
      chargedMinimumY: 1,
      originAnchoringArea: 4,
      interiorBoundingRemainderArea: 8,
      areaExcludedBeltArea: 1,
      warehouseBusArea: 16,
      materialLaneCountByKind: { belt: 1 },
      connectedPortEndpointCount: 2,
    });
  });

  it("keeps the static bound when the proof dependency is unavailable", () => {
    const report = benchmarkCertifiedAreaBounds({
      cases: [TEST_CASE],
      budgetsSeconds: [0.5],
    }, () => ({
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      status: "dependency-missing",
    }));

    expect(report.cases[0]!.samples[0]).toMatchObject({
      status: "bounded",
      mandatoryDeviceArea: 8,
      lowerBound: 8,
      upperBound: 12,
      absoluteGap: 4,
    });
    expect(report.cases[0]!.samples[0]!.cpSatArea).toBeUndefined();
  });

  it("fails loudly when a benchmark proof crosses the strict routed UB", () => {
    expect(() => benchmarkCertifiedAreaBounds({
      cases: [TEST_CASE],
      budgetsSeconds: [2],
    }, () => ({
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      status: "feasible",
      rawBestObjectiveBound: 13,
      certifiedIntegerLowerBound: 13,
      masterIncumbentArea: 14,
    }))).toThrow(/lower bound 13 exceeds routed upper bound 12/);
  });
});
