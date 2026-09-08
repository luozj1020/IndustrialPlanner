import type { CertifiedAreaBestKnownArtifact } from "./certified-area-benchmark";
import type { HeadlessOptimizationResult } from "./types";

export interface GlobalLayoutBenchmarkRecord {
  readonly name: string;
  readonly instanceHash: string;
  readonly warmStartUpperBound?: number;
  readonly currentRoutedUpperBound: number;
  readonly validatedBestKnownUpperBound?: number;
  readonly benchmarkUpperBound: number;
  readonly regressionFromBestKnown?: number;
  readonly boxesAttempted: number;
  readonly boxesSat: number;
  readonly boxesUnknown: number;
  /** M1 does not certify infeasibility. */
  readonly boxesCertifiedUnsat: 0;
  readonly placementsEvaluated: number;
  readonly fullRouteSuccesses: number;
  readonly timeToFirstImprovementMs?: number;
  readonly elapsedMs: number;
  readonly search: HeadlessOptimizationResult["search"]["boundedBox"];
}

export function createGlobalLayoutBenchmarkRecord(options: {
  readonly name: string;
  readonly instanceHash: string;
  readonly result: HeadlessOptimizationResult;
  readonly elapsedMs: number;
  readonly validatedBestKnown?: CertifiedAreaBestKnownArtifact;
}): GlobalLayoutBenchmarkRecord {
  const proof = options.result.optimality.boundingArea;
  if (!proof.strictRoutedUpperBoundVerified || proof.upperBound === undefined) {
    throw new Error(`Global benchmark ${options.name} has no strict routed incumbent`);
  }
  if (options.validatedBestKnown !== undefined
    && options.validatedBestKnown.instanceHash !== options.instanceHash) {
    throw new Error("Global benchmark best-known instance hash mismatch");
  }
  const search = options.result.search.boundedBox;
  const bestKnown = options.validatedBestKnown?.strictRoutedUpperBound;
  return {
    name: options.name,
    instanceHash: options.instanceHash,
    warmStartUpperBound: search?.warmStartUpperBound,
    currentRoutedUpperBound: proof.upperBound,
    validatedBestKnownUpperBound: bestKnown,
    benchmarkUpperBound: Math.min(proof.upperBound, bestKnown ?? Infinity),
    regressionFromBestKnown: bestKnown === undefined ? undefined : Math.max(0, proof.upperBound - bestKnown),
    boxesAttempted: search?.boxesAttempted ?? 0,
    boxesSat: search?.boxesSat ?? 0,
    boxesUnknown: search?.boxesUnknown ?? 0,
    boxesCertifiedUnsat: 0,
    placementsEvaluated: search?.masterPlacementsEvaluated ?? 0,
    fullRouteSuccesses: search?.routedWitnesses ?? 0,
    timeToFirstImprovementMs: search?.timeToFirstImprovementMs,
    elapsedMs: options.elapsedMs,
    search,
  };
}

export function formatGlobalLayoutBenchmark(records: readonly GlobalLayoutBenchmarkRecord[]): string {
  return [
    "| case | warm UB | current UB | best UB | boxes SAT / UNKNOWN | placements | first improvement ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...records.map((record) => `| ${record.name.replaceAll("|", "\\|").replaceAll("\n", " ")} `
      + `| ${record.warmStartUpperBound ?? "—"} | ${record.currentRoutedUpperBound} `
      + `| ${record.benchmarkUpperBound} | ${record.boxesSat} / ${record.boxesUnknown} `
      + `| ${record.placementsEvaluated} | ${record.timeToFirstImprovementMs ?? "—"} |`),
  ].join("\n");
}
