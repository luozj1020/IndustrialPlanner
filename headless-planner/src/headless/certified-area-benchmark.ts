import type { RegistryContract } from "../domain/registry/registry-contract";

import {
  createBoundingAreaOptimalityReport,
  measureMandatoryDeviceAreaLowerBound,
} from "./bounding-area-optimality";
import {
  CERTIFIED_AREA_RELAXATION_OBJECTIVE,
  CERTIFIED_AREA_RELAXATION_PROFILE,
  solveCpSatAreaLowerBound,
  type CertifiedAreaRelaxationDevice,
  type CertifiedAreaRelaxationOptions,
  type CertifiedAreaRelaxationResult,
} from "./certified-area-relaxation";
import type { BoundingAreaOptimalityStatus, HeadlessOptimizationResult } from "./types";

export const DEFAULT_CERTIFIED_AREA_BENCHMARK_BUDGETS = [0.5, 2, 10] as const;

export interface CertifiedAreaBenchmarkCase {
  readonly name: string;
  readonly devices: readonly CertifiedAreaRelaxationDevice[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
  /** Present only for a routed incumbent that passed the strict UB validator. */
  readonly strictRoutedUpperBound?: number;
  /** Diagnostic only; absence of an incumbent never weakens or promotes the LB. */
  readonly routedIncumbentFailure?: string;
  /** End-to-end incumbent search and strict-validation wall time. */
  readonly routedIncumbentElapsedMs?: number;
}

export interface CertifiedAreaBenchmarkSample {
  readonly maxSeconds: number;
  readonly status: BoundingAreaOptimalityStatus;
  readonly mandatoryDeviceArea: number;
  readonly cpSatArea?: number;
  readonly lowerBound: number;
  readonly upperBound?: number;
  readonly absoluteGap?: number;
  readonly relativeGap?: number;
  readonly proof: CertifiedAreaRelaxationResult;
}

export interface CertifiedAreaBenchmarkCaseResult {
  readonly name: string;
  readonly deviceCount: number;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
  readonly strictRoutedUpperBound?: number;
  readonly routedIncumbentFailure?: string;
  readonly routedIncumbentElapsedMs?: number;
  readonly mandatoryDeviceArea: number;
  readonly samples: readonly CertifiedAreaBenchmarkSample[];
}

export interface CertifiedAreaBenchmarkReport {
  readonly constraintProfile: typeof CERTIFIED_AREA_RELAXATION_PROFILE;
  readonly objective: typeof CERTIFIED_AREA_RELAXATION_OBJECTIVE;
  readonly budgetsSeconds: readonly number[];
  readonly gapBudgetSeconds: number;
  readonly cases: readonly CertifiedAreaBenchmarkCaseResult[];
}

export interface CertifiedAreaBenchmarkOptions {
  readonly cases: readonly CertifiedAreaBenchmarkCase[];
  readonly budgetsSeconds?: readonly number[];
  /** Budget whose combined bound is shown in the compact gap column. */
  readonly gapBudgetSeconds?: number;
}

export type CertifiedAreaBenchmarkSolver = (
  options: CertifiedAreaRelaxationOptions,
) => CertifiedAreaRelaxationResult;

/**
 * Measure proof progress independently at each wall-clock budget.
 *
 * Every row combines bounds only through max(). A placement-only master
 * incumbent remains nested under `proof` and is never promoted to an UB.
 */
export function benchmarkCertifiedAreaBounds(
  options: CertifiedAreaBenchmarkOptions,
  solver: CertifiedAreaBenchmarkSolver = solveCpSatAreaLowerBound,
): CertifiedAreaBenchmarkReport {
  if (options.cases.length === 0) throw new Error("Area benchmark requires at least one case");
  const budgetsSeconds = normalizeBudgets(
    options.budgetsSeconds ?? DEFAULT_CERTIFIED_AREA_BENCHMARK_BUDGETS,
  );
  const gapBudgetSeconds = options.gapBudgetSeconds ?? selectGapBudget(budgetsSeconds);
  if (!budgetsSeconds.includes(gapBudgetSeconds)) {
    throw new Error(`gapBudgetSeconds ${gapBudgetSeconds} is not one of the benchmark budgets`);
  }

  const names = new Set<string>();
  const cases = options.cases.map((benchmarkCase): CertifiedAreaBenchmarkCaseResult => {
    if (benchmarkCase.name.length === 0 || names.has(benchmarkCase.name)) {
      throw new Error(`Area benchmark case names must be unique and non-empty: ${benchmarkCase.name}`);
    }
    names.add(benchmarkCase.name);
    const mandatoryDeviceArea = measureMandatoryDeviceAreaLowerBound(benchmarkCase.devices);
    const samples = budgetsSeconds.map((maxSeconds): CertifiedAreaBenchmarkSample => {
      const proof = solver({
        devices: benchmarkCase.devices,
        limitWidth: benchmarkCase.limitWidth,
        limitHeight: benchmarkCase.limitHeight,
        allowRotate: benchmarkCase.allowRotate,
        maxSeconds,
      });
      const optimality = createBoundingAreaOptimalityReport({
        mandatoryDeviceAreaLowerBound: mandatoryDeviceArea,
        proof,
        strictRoutedUpperBoundVerified: benchmarkCase.strictRoutedUpperBound !== undefined,
        routedBoundingArea: benchmarkCase.strictRoutedUpperBound ?? 0,
      });
      if (optimality.lowerBound === undefined) {
        throw new Error("Mandatory device-area benchmark bound unexpectedly unavailable");
      }
      return {
        maxSeconds,
        status: optimality.status,
        mandatoryDeviceArea,
        ...(optimality.lowerBoundSources.cpSatArea === undefined
          ? {} : { cpSatArea: optimality.lowerBoundSources.cpSatArea }),
        lowerBound: optimality.lowerBound,
        ...(optimality.upperBound === undefined ? {} : { upperBound: optimality.upperBound }),
        ...(optimality.absoluteGap === undefined ? {} : { absoluteGap: optimality.absoluteGap }),
        ...(optimality.relativeGap === undefined ? {} : { relativeGap: optimality.relativeGap }),
        proof,
      };
    });
    return {
      name: benchmarkCase.name,
      deviceCount: benchmarkCase.devices.length,
      limitWidth: benchmarkCase.limitWidth,
      limitHeight: benchmarkCase.limitHeight,
      allowRotate: benchmarkCase.allowRotate,
      ...(benchmarkCase.strictRoutedUpperBound === undefined
        ? {} : { strictRoutedUpperBound: benchmarkCase.strictRoutedUpperBound }),
      ...(benchmarkCase.routedIncumbentFailure === undefined
        ? {} : { routedIncumbentFailure: benchmarkCase.routedIncumbentFailure }),
      ...(benchmarkCase.routedIncumbentElapsedMs === undefined
        ? {} : { routedIncumbentElapsedMs: benchmarkCase.routedIncumbentElapsedMs }),
      mandatoryDeviceArea,
      samples,
    };
  });

  return {
    constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
    objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
    budgetsSeconds,
    gapBudgetSeconds,
    cases,
  };
}

/** Build a proof benchmark case only from an already strict routed result. */
export function createCertifiedAreaBenchmarkCaseFromResult(options: {
  readonly name: string;
  readonly result: HeadlessOptimizationResult;
  readonly registry: Pick<RegistryContract, "entityDefinitions">;
  readonly allowRotate: boolean;
  readonly routedIncumbentElapsedMs?: number;
}): CertifiedAreaBenchmarkCase {
  const optimality = options.result.optimality.boundingArea;
  if (!optimality.strictRoutedUpperBoundVerified || optimality.upperBound === undefined) {
    throw new Error(`Benchmark case ${options.name} has no strict routed bounding-area UB`);
  }
  const definitions = new Map(options.registry.entityDefinitions.map((definition) =>
    [definition.id, definition] as const));
  const devices = options.result.layout.devices
    .filter((device) => device.kind === "production" || device.kind === "storage")
    .map((device): CertifiedAreaRelaxationDevice => {
      const definition = definitions.get(device.definitionId);
      if (definition === undefined) {
        throw new Error(`Benchmark case ${options.name} is missing definition ${device.definitionId}`);
      }
      return {
        id: device.id,
        width: definition.footprint.width,
        height: definition.footprint.height,
      };
    });
  return {
    name: options.name,
    devices,
    limitWidth: options.result.layout.limitWidth,
    limitHeight: options.result.layout.limitHeight,
    allowRotate: options.allowRotate,
    strictRoutedUpperBound: optimality.upperBound,
    ...(options.routedIncumbentElapsedMs === undefined
      ? {} : { routedIncumbentElapsedMs: options.routedIncumbentElapsedMs }),
  };
}

export function formatCertifiedAreaBenchmarkMarkdown(
  report: CertifiedAreaBenchmarkReport,
): string {
  const budgetHeaders = report.budgetsSeconds.map((budget) =>
    `CP-SAT LB @ ${formatBudget(budget)}s`);
  const header = [
    "case",
    "devices",
    "UB",
    "device LB",
    ...budgetHeaders,
    `gap @ ${formatBudget(report.gapBudgetSeconds)}s`,
  ];
  const separator = header.map(() => "---:");
  separator[0] = "---";
  const rows = report.cases.map((benchmarkCase) => {
    const gapSample = benchmarkCase.samples.find((sample) =>
      sample.maxSeconds === report.gapBudgetSeconds);
    return [
      escapeMarkdownCell(benchmarkCase.name),
      String(benchmarkCase.deviceCount),
      formatOptionalInteger(benchmarkCase.strictRoutedUpperBound),
      String(benchmarkCase.mandatoryDeviceArea),
      ...benchmarkCase.samples.map((sample) => formatOptionalInteger(sample.cpSatArea)),
      gapSample?.relativeGap === undefined
        ? "—"
        : `${formatOptionalInteger(gapSample.absoluteGap)} (${(gapSample.relativeGap * 100).toFixed(2)}%)`,
    ];
  });
  return [header, separator, ...rows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

function normalizeBudgets(budgets: readonly number[]): number[] {
  if (budgets.length === 0) throw new Error("Area benchmark requires at least one budget");
  const result: number[] = [];
  for (const budget of budgets) {
    if (!Number.isFinite(budget) || budget <= 0 || budget > 30) {
      throw new Error(`Area benchmark budgets must be in (0, 30], received ${budget}`);
    }
    if (!result.includes(budget)) result.push(budget);
  }
  return result.sort((left, right) => left - right);
}

function selectGapBudget(budgets: readonly number[]): number {
  return budgets.includes(2) ? 2 : budgets[0]!;
}

function formatBudget(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "");
}

function formatOptionalInteger(value: number | undefined): string {
  return value === undefined ? "—" : String(value);
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
