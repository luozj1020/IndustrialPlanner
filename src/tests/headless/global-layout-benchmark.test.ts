import { describe, expect, it } from "vitest";

import type { CertifiedAreaBestKnownArtifact } from "@/headless/certified-area-benchmark";
import { createGlobalLayoutBenchmarkRecord, formatGlobalLayoutBenchmark } from "@/headless/global-layout-benchmark";
import type { HeadlessOptimizationResult } from "@/headless/types";

const result = {
  optimality: { boundingArea: {
    strictRoutedUpperBoundVerified: true, upperBound: 345,
    proof: { masterIncumbentArea: 118 },
  } },
  search: { boundedBox: {
    warmStartUpperBound: 345, boxesAttempted: 4, boxesSat: 0, boxesUnknown: 4,
    masterPlacementsEvaluated: 12, routedWitnesses: 0,
  } },
} as HeadlessOptimizationResult;

describe("global-layout benchmark M1", () => {
  it("separates current and validated best-known UB without treating master witnesses as routes", () => {
    const record = createGlobalLayoutBenchmarkRecord({
      name: "medium", instanceHash: "instance", result, elapsedMs: 100,
      validatedBestKnown: { instanceHash: "instance", strictRoutedUpperBound: 330 } as CertifiedAreaBestKnownArtifact,
    });
    expect(record).toMatchObject({
      warmStartUpperBound: 345, currentRoutedUpperBound: 345,
      validatedBestKnownUpperBound: 330, benchmarkUpperBound: 330, regressionFromBestKnown: 15,
      boxesAttempted: 4, boxesSat: 0, boxesUnknown: 4, boxesCertifiedUnsat: 0,
      placementsEvaluated: 12, fullRouteSuccesses: 0,
    });
    expect(formatGlobalLayoutBenchmark([record])).toContain("| medium | 345 | 345 | 330 | 0 / 4 | 12 | — |");
  });

  it("rejects an unverified incumbent and a different-instance historical result", () => {
    expect(() => createGlobalLayoutBenchmarkRecord({
      name: "invalid", instanceHash: "instance", elapsedMs: 0,
      result: { ...result, optimality: { boundingArea: {
        ...result.optimality.boundingArea, strictRoutedUpperBoundVerified: false,
      } } },
    })).toThrow(/strict routed incumbent/);
    expect(() => createGlobalLayoutBenchmarkRecord({
      name: "mismatch", instanceHash: "different", elapsedMs: 0, result,
      validatedBestKnown: { instanceHash: "instance", strictRoutedUpperBound: 330 } as CertifiedAreaBestKnownArtifact,
    })).toThrow(/instance hash mismatch/);
  });

  it("reports a sequential-only baseline without inventing box attempts", () => {
    const record = createGlobalLayoutBenchmarkRecord({
      name: "baseline", instanceHash: "instance", elapsedMs: 10,
      result: { ...result, search: { ...result.search, boundedBox: undefined } },
    });
    expect(record.benchmarkUpperBound).toBe(345);
    expect(record.boxesAttempted).toBe(0);
    expect(record.boxesCertifiedUnsat).toBe(0);
    expect(record.validatedBestKnownUpperBound).toBeUndefined();
  });
});
