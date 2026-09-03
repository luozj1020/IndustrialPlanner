import { describe, expect, it } from "vitest";

import {
  benchmarkCertifiedAreaBounds,
  formatCertifiedAreaBenchmarkMarkdown,
  type CertifiedAreaBenchmarkSolver,
} from "@/headless/certified-area-benchmark";
import {
  CERTIFIED_AREA_RELAXATION_OBJECTIVE,
  CERTIFIED_AREA_RELAXATION_PROFILE,
} from "@/headless/certified-area-relaxation";

const TEST_CASE = {
  name: "identical-rectangles",
  devices: [
    { id: "a", width: 2, height: 2 },
    { id: "b", width: 2, height: 2 },
  ],
  limitWidth: 8,
  limitHeight: 8,
  allowRotate: true,
  strictRoutedUpperBound: 12,
} as const;

describe("certified area benchmark", () => {
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
      strictRoutedUpperBound: 12,
      samples: [
        { maxSeconds: 0.5, cpSatArea: 8, lowerBound: 8, upperBound: 12 },
        { maxSeconds: 2, cpSatArea: 10, lowerBound: 10, absoluteGap: 2 },
        { maxSeconds: 10, cpSatArea: 10, lowerBound: 10, absoluteGap: 2 },
      ],
    });
    expect(report.cases[0]!.samples[1]!.relativeGap).toBeCloseTo(1 / 6);
    expect(formatCertifiedAreaBenchmarkMarkdown(report)).toContain(
      "| identical-rectangles | 2 | 12 | 8 | 8 | 10 | 10 | 2 (16.67%) |",
    );
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
