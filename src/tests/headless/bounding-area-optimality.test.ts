import { describe, expect, it } from "vitest";

import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { EntityDefinition } from "@/domain/registry/types/entity-definition";
import type { WorldEntity } from "@/domain/document/world-document";
import {
  createBoundingAreaOptimalityReport,
  isStrictRoutedBoundingAreaUpperBound,
  measureMandatoryDeviceAreaLowerBound,
} from "@/headless/bounding-area-optimality";
import {
  CERTIFIED_AREA_RELAXATION_OBJECTIVE,
  CERTIFIED_AREA_RELAXATION_PROFILE,
  type CertifiedAreaRelaxationResult,
} from "@/headless/certified-area-relaxation";
import type { HeadlessPlacedDevice } from "@/headless/types";

const proof = (
  overrides: Partial<CertifiedAreaRelaxationResult> = {},
): CertifiedAreaRelaxationResult => ({
  constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
  objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
  status: "dependency-missing",
  ...overrides,
});

describe("certified bounding-area reporting", () => {
  it("combines valid lower bounds with max and keeps the master incumbent out of UB", () => {
    const report = createBoundingAreaOptimalityReport({
      mandatoryDeviceAreaLowerBound: 12,
      proof: proof({
        status: "feasible",
        rawBestObjectiveBound: 14,
        certifiedIntegerLowerBound: 14,
        masterIncumbentArea: 17,
      }),
      strictRoutedUpperBoundVerified: true,
      routedBoundingArea: 20,
    });

    expect(report).toMatchObject({
      status: "bounded",
      lowerBound: 14,
      upperBound: 20,
      absoluteGap: 6,
      relativeGap: 0.3,
      strictRoutedUpperBoundVerified: true,
      lowerBoundSources: { mandatoryDeviceArea: 12, cpSatArea: 14 },
      proof: { masterIncumbentArea: 17 },
    });
    expect(report.upperBound).not.toBe(report.proof.masterIncumbentArea);
  });

  it("reports static fallback, lower-bound-only, and unavailable states mechanically", () => {
    const fallback = createBoundingAreaOptimalityReport({
      mandatoryDeviceAreaLowerBound: 12,
      proof: proof(),
      strictRoutedUpperBoundVerified: true,
      routedBoundingArea: 20,
    });
    expect(fallback.status).toBe("bounded");
    expect(fallback.lowerBound).toBe(12);
    expect(fallback.proof.certifiedIntegerLowerBound).toBeUndefined();

    const lowerOnly = createBoundingAreaOptimalityReport({
      mandatoryDeviceAreaLowerBound: 12,
      proof: proof(),
      strictRoutedUpperBoundVerified: false,
      routedBoundingArea: 20,
    });
    expect(lowerOnly.status).toBe("lower-bound-only");
    expect(lowerOnly.upperBound).toBeUndefined();
    expect(lowerOnly.absoluteGap).toBeUndefined();

    const unavailable = createBoundingAreaOptimalityReport({
      proof: proof(),
      strictRoutedUpperBoundVerified: false,
      routedBoundingArea: 20,
    });
    expect(unavailable.status).toBe("bound-unavailable");
    expect(unavailable.lowerBound).toBeUndefined();
  });

  it("reports exact equality only as standalone bounding-area optimality", () => {
    const report = createBoundingAreaOptimalityReport({
      mandatoryDeviceAreaLowerBound: 10,
      proof: proof({
        status: "optimal",
        rawBestObjectiveBound: 20,
        certifiedIntegerLowerBound: 20,
        masterIncumbentArea: 20,
      }),
      strictRoutedUpperBoundVerified: true,
      routedBoundingArea: 20,
    });
    expect(report.status).toBe("bounding-area-optimal");
    expect(report.absoluteGap).toBe(0);
    expect(report.relativeGap).toBe(0);
  });

  it("throws instead of clamping contradictory proof chains", () => {
    expect(() => createBoundingAreaOptimalityReport({
      mandatoryDeviceAreaLowerBound: 21,
      proof: proof(),
      strictRoutedUpperBoundVerified: true,
      routedBoundingArea: 20,
    })).toThrow(/lower bound 21 exceeds routed upper bound 20/);

    expect(() => createBoundingAreaOptimalityReport({
      mandatoryDeviceAreaLowerBound: 10,
      proof: proof({ status: "infeasible" }),
      strictRoutedUpperBoundVerified: true,
      routedBoundingArea: 20,
    })).toThrow(/relaxation is infeasible/);
  });

  it("uses only the sum of mandatory rectangle areas for the static bound", () => {
    expect(measureMandatoryDeviceAreaLowerBound([
      { width: 2, height: 3 },
      { width: 4, height: 5 },
    ])).toBe(26);
  });

  it("independently verifies map, blueprint, footprint, overlap, and charged-area geometry", () => {
    const definition = {
      id: "machine",
      footprint: { width: 2, height: 3 },
    } as EntityDefinition;
    const entity: WorldEntity = {
      id: "device",
      definitionId: definition.id,
      position: { x: 1, y: 0 },
      rotation: 0,
      config: {},
      tags: [],
    };
    const blueprint = {
      entities: { device: entity },
      entityOrder: ["device"],
    } as unknown as BlueprintDocument;
    const device: HeadlessPlacedDevice = {
      id: "device",
      definitionId: definition.id,
      kind: "production",
      recipeId: "recipe",
      position: entity.position,
      rotation: 0,
      width: 2,
      height: 3,
    };
    const base = {
      blueprint,
      registry: { entityDefinitions: [definition] },
      devices: [device],
      routedConnections: [],
      areaExcludedDeviceIds: new Set<string>(),
      limitWidth: 8,
      limitHeight: 8,
      boundingArea: 6,
      topologyErrorCount: 0,
      productionConnectivityVerified: true,
      productionThroughputVerified: true,
      powerCoverageVerified: true,
      frontageConstraint: "hard" as const,
      frontageOverflowCellCount: 0,
    };

    expect(isStrictRoutedBoundingAreaUpperBound(base)).toBe(true);
    expect(isStrictRoutedBoundingAreaUpperBound({
      ...base,
      blueprint: {
        ...blueprint,
        entities: { device: { ...entity, position: { x: 2, y: 0 } } },
      },
    })).toBe(false);
    expect(isStrictRoutedBoundingAreaUpperBound({
      ...base,
      frontageOverflowCellCount: 1,
    })).toBe(false);
    expect(isStrictRoutedBoundingAreaUpperBound({
      ...base,
      frontageConstraint: "soft",
      frontageOverflowCellCount: 1,
    })).toBe(true);
    expect(isStrictRoutedBoundingAreaUpperBound({
      ...base,
      blueprint: {
        ...blueprint,
        entities: { device: entity, overlap: { ...entity, id: "overlap" } },
        entityOrder: ["device", "overlap"],
      },
      devices: [device, { ...device, id: "overlap" }],
    })).toBe(false);
    expect(isStrictRoutedBoundingAreaUpperBound({
      ...base,
      areaExcludedDeviceIds: new Set(["device"]),
      boundingArea: 0,
    })).toBe(false);
  });
});
