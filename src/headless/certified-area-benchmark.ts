import type { RegistryContract } from "@/domain/registry/registry-contract";
import { hashStable } from "@/simulation/deterministic";

import {
  createBoundingAreaOptimalityReport,
  isStrictRoutedBoundingAreaUpperBound,
  measureMandatoryDeviceAreaLowerBound,
} from "./bounding-area-optimality";
import {
  createCertifiedAreaMandatoryDevices,
  measureCertifiedAreaByCategory,
} from "./certified-area-mandatory-devices";
import {
  CERTIFIED_AREA_RELAXATION_OBJECTIVE,
  CERTIFIED_AREA_RELAXATION_PROFILE,
  solveCpSatAreaLowerBound,
  type CertifiedAreaRelaxationDevice,
  type CertifiedAreaRelaxationOptions,
  type CertifiedAreaRelaxationResult,
} from "./certified-area-relaxation";
import type {
  BoundingAreaOptimalityStatus,
  HeadlessMaterialGraph,
  HeadlessOptimizationRequest,
  HeadlessOptimizationResult,
  HeadlessPlacedDevice,
} from "./types";

export const DEFAULT_CERTIFIED_AREA_BENCHMARK_BUDGETS = [0.5, 2, 10] as const;
export const CERTIFIED_AREA_BENCHMARK_INSTANCE_PROFILE =
  "certified-area-benchmark-instance-v1" as const;
export const CERTIFIED_AREA_BEST_KNOWN_ARTIFACT_PROFILE =
  "strict-routed-bounding-area-v1" as const;

export interface CertifiedAreaGameRuleAttribution {
  /** Raw occupied rectangle area before the game's area-exclusion rules. */
  readonly rawFootprintAreaByKind: Readonly<Partial<Record<HeadlessPlacedDevice["kind"], number>>>;
  /** Occupied area that contributes to the charged bounding-area objective. */
  readonly chargedFootprintAreaByKind: Readonly<Partial<Record<HeadlessPlacedDevice["kind"], number>>>;
  readonly chargedFootprintArea: number;
  /** Bounding area not explained by charged entity rectangles; not a certified lower bound. */
  readonly chargedBoundingRemainderArea: number;
  readonly areaExcludedBeltArea: number;
  readonly warehouseBusArea: number;
  readonly materialLaneCountByKind: Readonly<Partial<Record<"belt" | "pipe", number>>>;
  readonly connectedPortEndpointCount: number;
  readonly minimumPowerDeviceCount: number;
}

export interface CertifiedAreaBestKnownArtifact {
  readonly schemaVersion: 1;
  readonly validationProfile: typeof CERTIFIED_AREA_BEST_KNOWN_ARTIFACT_PROFILE;
  readonly instanceHash: string;
  readonly strictRoutedUpperBound: number;
  readonly blueprintId: string;
  readonly topologyId: string;
  readonly sourceArtifact: string;
  readonly areaAttribution: CertifiedAreaGameRuleAttribution;
}

export interface CertifiedAreaBenchmarkCase {
  readonly name: string;
  readonly instanceHash: string;
  readonly devices: readonly CertifiedAreaRelaxationDevice[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
  /** Present only for this run's routed incumbent that passed the strict UB validator. */
  readonly currentRoutedUpperBound?: number;
  readonly currentAreaAttribution?: CertifiedAreaGameRuleAttribution;
  /** Versioned, instance-hash-matched historical strict UB attestation. */
  readonly validatedBestKnown?: CertifiedAreaBestKnownArtifact;
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
  readonly solverStatus: CertifiedAreaRelaxationResult["status"];
  readonly masterIncumbentArea?: number;
  readonly masterAbsoluteGap?: number;
  readonly masterRelativeGap?: number;
  readonly masterProofClosed: boolean;
  readonly proof: CertifiedAreaRelaxationResult;
}

export interface CertifiedAreaBenchmarkCaseResult {
  readonly name: string;
  readonly instanceHash: string;
  readonly deviceCount: number;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
  readonly currentRoutedUpperBound?: number;
  readonly bestKnownStrictUpperBound?: number;
  readonly benchmarkUpperBound?: number;
  readonly bestKnownArtifact?: string;
  readonly currentRoutedUpperBoundRegression?: number;
  readonly currentAreaAttribution?: CertifiedAreaGameRuleAttribution;
  readonly benchmarkAreaAttribution?: CertifiedAreaGameRuleAttribution;
  readonly routedIncumbentFailure?: string;
  readonly routedIncumbentElapsedMs?: number;
  readonly mandatoryDeviceArea: number;
  readonly mandatoryRectangleAreaByCategory: ReturnType<typeof measureCertifiedAreaByCategory>;
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
    if (benchmarkCase.instanceHash.length === 0) {
      throw new Error(`Area benchmark case ${benchmarkCase.name} has an empty instance hash`);
    }
    if (benchmarkCase.validatedBestKnown !== undefined
      && benchmarkCase.validatedBestKnown.instanceHash !== benchmarkCase.instanceHash) {
      throw new Error(
        `Best-known artifact instance hash mismatch for ${benchmarkCase.name}: `
          + `${benchmarkCase.validatedBestKnown.instanceHash} != ${benchmarkCase.instanceHash}`,
      );
    }
    const currentRoutedUpperBound = benchmarkCase.currentRoutedUpperBound;
    const bestKnownStrictUpperBound = benchmarkCase.validatedBestKnown?.strictRoutedUpperBound;
    const benchmarkUpperBound = minimumDefined(
      currentRoutedUpperBound,
      bestKnownStrictUpperBound,
    );
    const currentRoutedUpperBoundRegression = currentRoutedUpperBound === undefined
      || bestKnownStrictUpperBound === undefined
      || currentRoutedUpperBound <= bestKnownStrictUpperBound
      ? undefined
      : currentRoutedUpperBound - bestKnownStrictUpperBound;
    const benchmarkAreaAttribution = bestKnownStrictUpperBound !== undefined
      && (currentRoutedUpperBound === undefined
        || bestKnownStrictUpperBound < currentRoutedUpperBound)
      ? benchmarkCase.validatedBestKnown?.areaAttribution
      : benchmarkCase.currentAreaAttribution;
    const mandatoryDeviceArea = measureMandatoryDeviceAreaLowerBound(benchmarkCase.devices);
    const mandatoryRectangleAreaByCategory = measureCertifiedAreaByCategory(benchmarkCase.devices);
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
        strictRoutedUpperBoundVerified: benchmarkUpperBound !== undefined,
        routedBoundingArea: benchmarkUpperBound ?? 0,
      });
      if (optimality.lowerBound === undefined) {
        throw new Error("Mandatory device-area benchmark bound unexpectedly unavailable");
      }
      const masterIncumbentArea = proof.masterIncumbentArea;
      const cpSatArea = optimality.lowerBoundSources.cpSatArea;
      const masterAbsoluteGap = masterIncumbentArea === undefined || cpSatArea === undefined
        ? undefined
        : masterIncumbentArea - cpSatArea;
      const masterRelativeGap = masterAbsoluteGap === undefined || masterIncumbentArea === undefined
        ? undefined
        : masterIncumbentArea === 0 ? 0 : masterAbsoluteGap / masterIncumbentArea;
      return {
        maxSeconds,
        status: optimality.status,
        mandatoryDeviceArea,
        ...(cpSatArea === undefined ? {} : { cpSatArea }),
        lowerBound: optimality.lowerBound,
        ...(optimality.upperBound === undefined ? {} : { upperBound: optimality.upperBound }),
        ...(optimality.absoluteGap === undefined ? {} : { absoluteGap: optimality.absoluteGap }),
        ...(optimality.relativeGap === undefined ? {} : { relativeGap: optimality.relativeGap }),
        solverStatus: proof.status,
        ...(masterIncumbentArea === undefined ? {} : { masterIncumbentArea }),
        ...(masterAbsoluteGap === undefined ? {} : { masterAbsoluteGap }),
        ...(masterRelativeGap === undefined ? {} : { masterRelativeGap }),
        masterProofClosed: masterAbsoluteGap === 0,
        proof,
      };
    });
    return {
      name: benchmarkCase.name,
      instanceHash: benchmarkCase.instanceHash,
      deviceCount: benchmarkCase.devices.length,
      limitWidth: benchmarkCase.limitWidth,
      limitHeight: benchmarkCase.limitHeight,
      allowRotate: benchmarkCase.allowRotate,
      ...(currentRoutedUpperBound === undefined
        ? {} : { currentRoutedUpperBound }),
      ...(bestKnownStrictUpperBound === undefined
        ? {} : { bestKnownStrictUpperBound }),
      ...(benchmarkUpperBound === undefined ? {} : { benchmarkUpperBound }),
      ...(benchmarkCase.validatedBestKnown === undefined
        ? {} : { bestKnownArtifact: benchmarkCase.validatedBestKnown.sourceArtifact }),
      ...(currentRoutedUpperBoundRegression === undefined
        ? {} : { currentRoutedUpperBoundRegression }),
      ...(benchmarkCase.currentAreaAttribution === undefined
        ? {} : { currentAreaAttribution: benchmarkCase.currentAreaAttribution }),
      ...(benchmarkAreaAttribution === undefined
        ? {} : { benchmarkAreaAttribution }),
      ...(benchmarkCase.routedIncumbentFailure === undefined
        ? {} : { routedIncumbentFailure: benchmarkCase.routedIncumbentFailure }),
      ...(benchmarkCase.routedIncumbentElapsedMs === undefined
        ? {} : { routedIncumbentElapsedMs: benchmarkCase.routedIncumbentElapsedMs }),
      mandatoryDeviceArea,
      mandatoryRectangleAreaByCategory,
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
  readonly instanceHash: string;
  readonly result: HeadlessOptimizationResult;
  readonly registry: Pick<RegistryContract, "entityDefinitions">;
  readonly allowRotate: boolean;
  readonly validatedBestKnown?: CertifiedAreaBestKnownArtifact;
  readonly routedIncumbentElapsedMs?: number;
}): CertifiedAreaBenchmarkCase {
  const optimality = options.result.optimality.boundingArea;
  if (!optimality.strictRoutedUpperBoundVerified || optimality.upperBound === undefined) {
    throw new Error(`Benchmark case ${options.name} has no strict routed bounding-area UB`);
  }
  const devices = createCertifiedAreaMandatoryDevices({
    entities: options.result.layout.devices.flatMap((device) =>
      device.kind === "production"
        || device.kind === "storage"
        || device.kind === "warehouse-port"
        ? [{ id: device.id, kind: device.kind, definitionId: device.definitionId }]
        : []),
    entityDefinitions: options.registry.entityDefinitions,
  });
  return {
    name: options.name,
    instanceHash: options.instanceHash,
    devices,
    limitWidth: options.result.layout.limitWidth,
    limitHeight: options.result.layout.limitHeight,
    allowRotate: options.allowRotate,
    currentRoutedUpperBound: optimality.upperBound,
    currentAreaAttribution: createCertifiedAreaGameRuleAttribution(options.result),
    ...(options.validatedBestKnown === undefined
      ? {} : { validatedBestKnown: options.validatedBestKnown }),
    ...(options.routedIncumbentElapsedMs === undefined
      ? {} : { routedIncumbentElapsedMs: options.routedIncumbentElapsedMs }),
  };
}

export function formatCertifiedAreaBenchmarkMarkdown(
  report: CertifiedAreaBenchmarkReport,
): string {
  const budgetHeaders = report.budgetsSeconds.map((budget) =>
    `proof @ ${formatBudget(budget)}s`);
  const header = [
    "case",
    "devices",
    "current UB",
    "best UB",
    "benchmark UB",
    "mandatory LB",
    "mandatory mix",
    ...budgetHeaders,
    `full gap @ ${formatBudget(report.gapBudgetSeconds)}s`,
    "UB regression",
    "charged mix",
    "box remainder",
  ];
  const separator = header.map(() => "---:");
  separator[0] = "---";
  const rows = report.cases.map((benchmarkCase) => {
    const gapSample = benchmarkCase.samples.find((sample) =>
      sample.maxSeconds === report.gapBudgetSeconds);
    return [
      escapeMarkdownCell(benchmarkCase.name),
      String(benchmarkCase.deviceCount),
      formatOptionalInteger(benchmarkCase.currentRoutedUpperBound),
      formatOptionalInteger(benchmarkCase.bestKnownStrictUpperBound),
      formatOptionalInteger(benchmarkCase.benchmarkUpperBound),
      String(benchmarkCase.mandatoryDeviceArea),
      formatMandatoryMix(benchmarkCase.mandatoryRectangleAreaByCategory),
      ...benchmarkCase.samples.map(formatProofSample),
      gapSample?.relativeGap === undefined
        ? "—"
        : `${formatOptionalInteger(gapSample.absoluteGap)} (${(gapSample.relativeGap * 100).toFixed(2)}%)`,
      formatOptionalInteger(benchmarkCase.currentRoutedUpperBoundRegression),
      formatChargedMix(benchmarkCase.benchmarkAreaAttribution),
      formatOptionalInteger(
        benchmarkCase.benchmarkAreaAttribution?.chargedBoundingRemainderArea,
      ),
    ];
  });
  return [header, separator, ...rows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

export function createCertifiedAreaBenchmarkInstanceHash(options: {
  readonly request: HeadlessOptimizationRequest;
  readonly graph: HeadlessMaterialGraph;
  readonly devices: readonly CertifiedAreaRelaxationDevice[];
  readonly registry: Pick<RegistryContract,
    "baseDefinitions" | "entityDefinitions" | "itemDefinitions" | "recipeDefinitions">;
}): string {
  const search = options.request.search;
  const problemRequest: Record<string, unknown> = { ...options.request };
  delete problemRequest["name"];
  delete problemRequest["search"];
  delete problemRequest["certification"];
  delete problemRequest["routingClearance"];
  const effectiveFrontageConstraint = options.request.frontageConstraint === "hard"
    || (search?.initialLayout === "topology-sequential"
      && options.request.frontageConstraint !== "soft")
    ? "hard"
    : "soft";
  const byId = <T extends { readonly id: string }>(values: readonly T[]): T[] =>
    [...values].sort((left, right) => left.id.localeCompare(right.id));
  return hashStable({
    profile: CERTIFIED_AREA_BENCHMARK_INSTANCE_PROFILE,
    problemRequest,
    effectiveFrontageConstraint,
    graph: {
      nodes: byId(options.graph.nodes),
      edges: [...options.graph.edges].sort(compareMaterialEdge),
      components: byId(options.graph.components),
    },
    mandatoryRectangles: [...options.devices]
      .map(({ id, width, height, category }) => ({ id, width, height, category }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    registry: {
      bases: byId(options.registry.baseDefinitions),
      entities: byId(options.registry.entityDefinitions),
      items: byId(options.registry.itemDefinitions),
      recipes: byId(options.registry.recipeDefinitions),
    },
  });
}

export function createCertifiedAreaBestKnownArtifact(options: {
  readonly instanceHash: string;
  readonly result: HeadlessOptimizationResult;
  readonly sourceArtifact: string;
}): CertifiedAreaBestKnownArtifact {
  const optimality = options.result.optimality.boundingArea;
  if (!optimality.strictRoutedUpperBoundVerified || optimality.upperBound === undefined) {
    throw new Error("Cannot attest a best-known artifact without a strict routed UB");
  }
  return createBestKnownArtifactEnvelope({
    instanceHash: options.instanceHash,
    strictRoutedUpperBound: optimality.upperBound,
    blueprintId: options.result.blueprint.blueprintId,
    topologyId: options.result.validation.topologyId,
    sourceArtifact: options.sourceArtifact,
    areaAttribution: createCertifiedAreaGameRuleAttribution(options.result),
  });
}

/**
 * Re-run the strict geometric/area validator over a stored headless report.
 * The expected graph check prevents a valid layout for a different production
 * request from being promoted through a matching file path.
 */
export function certifyArchivedAreaBestKnownArtifact(options: {
  readonly instanceHash: string;
  readonly result: HeadlessOptimizationResult;
  readonly expectedGraph: HeadlessMaterialGraph;
  readonly request: HeadlessOptimizationRequest;
  readonly registry: Pick<RegistryContract, "entityDefinitions">;
  readonly sourceArtifact: string;
}): CertifiedAreaBestKnownArtifact {
  assertArchivedResultMatchesGraph(options.result, options.expectedGraph);
  if (options.result.layout.limitWidth !== options.request.width
    || options.result.layout.limitHeight !== options.request.height) {
    throw new Error("Best-known report map dimensions do not match the benchmark request");
  }
  const routedConnections = identifyArchivedMaterialConnections(
    options.result.validation.materialConnections,
  );
  if (routedConnections.length !== options.result.validation.routedConnectionCount) {
    throw new Error("Best-known report routed connection count is inconsistent");
  }
  const deviceById = new Map(options.result.layout.devices.map((device) =>
    [device.id, device] as const));
  const eligibleExcludedConnections = new Set(routedConnections.flatMap((connection) => {
    const source = connection.sourceDeviceId === null
      ? undefined : deviceById.get(connection.sourceDeviceId);
    const target = connection.targetDeviceId === null
      ? undefined : deviceById.get(connection.targetDeviceId);
    return source?.definitionId === "item_port_unloader_1" && target?.kind === "production"
      ? [connection.id]
      : [];
  }));
  const areaExcludedDeviceIds = new Set(options.result.layout.devices.flatMap((device) => {
    if (device.kind !== "belt") return [];
    const connectionIds = options.result.blueprint.entities[device.id]?.tags.flatMap((tag) =>
      tag.startsWith("connection:") ? [tag.slice("connection:".length)] : []) ?? [];
    return connectionIds.length > 0
      && connectionIds.every((connectionId) => eligibleExcludedConnections.has(connectionId))
      ? [device.id]
      : [];
  }));
  if (areaExcludedDeviceIds.size !== options.result.layout.areaExcludedBeltCellCount) {
    throw new Error("Best-known report area-excluded belt count is inconsistent");
  }
  const effectiveFrontageConstraint = options.request.frontageConstraint === "hard"
    || (options.request.search?.initialLayout === "topology-sequential"
      && options.request.frontageConstraint !== "soft")
    ? "hard"
    : "soft";
  const strict = isStrictRoutedBoundingAreaUpperBound({
    blueprint: options.result.blueprint,
    registry: options.registry,
    devices: options.result.layout.devices,
    routedConnections,
    areaExcludedDeviceIds,
    limitWidth: options.request.width,
    limitHeight: options.request.height,
    boundingArea: options.result.layout.boundingArea,
    topologyErrorCount: options.result.validation.errorCount,
    productionConnectivityVerified: options.result.validation.productionConnectivityVerified,
    productionThroughputVerified: options.result.validation.productionThroughputVerified,
    powerCoverageVerified: options.result.validation.powerCoverageVerified,
    frontageConstraint: effectiveFrontageConstraint,
    frontageOverflowCellCount: options.result.layout.frontageOverflowCellCount,
  });
  if (!strict) throw new Error("Best-known report failed the strict routed bounding-area validator");
  return createBestKnownArtifactEnvelope({
    instanceHash: options.instanceHash,
    strictRoutedUpperBound: options.result.layout.boundingArea,
    blueprintId: options.result.blueprint.blueprintId,
    topologyId: options.result.validation.topologyId,
    sourceArtifact: options.sourceArtifact,
    areaAttribution: createCertifiedAreaGameRuleAttribution(options.result),
  });
}

export function parseCertifiedAreaBestKnownArtifact(
  value: unknown,
  expectedInstanceHash: string,
): CertifiedAreaBestKnownArtifact {
  if (!isRecord(value)) throw new Error("Best-known area artifact must be an object");
  const allowed = new Set([
    "schemaVersion",
    "validationProfile",
    "instanceHash",
    "strictRoutedUpperBound",
    "blueprintId",
    "topologyId",
    "sourceArtifact",
    "areaAttribution",
  ]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Unsupported best-known area artifact fields: ${unexpected.join(",")}`);
  }
  if (value["schemaVersion"] !== 1
    || value["validationProfile"] !== CERTIFIED_AREA_BEST_KNOWN_ARTIFACT_PROFILE
    || typeof value["instanceHash"] !== "string"
    || value["instanceHash"] !== expectedInstanceHash
    || typeof value["blueprintId"] !== "string" || value["blueprintId"].length === 0
    || typeof value["topologyId"] !== "string" || value["topologyId"].length === 0
    || typeof value["sourceArtifact"] !== "string" || value["sourceArtifact"].length === 0
    || !isPositiveSafeInteger(value["strictRoutedUpperBound"])) {
    throw new Error("Invalid or mismatched best-known area artifact");
  }
  const areaAttribution = parseAreaAttribution(value["areaAttribution"]);
  return {
    schemaVersion: 1,
    validationProfile: CERTIFIED_AREA_BEST_KNOWN_ARTIFACT_PROFILE,
    instanceHash: value["instanceHash"],
    strictRoutedUpperBound: value["strictRoutedUpperBound"],
    blueprintId: value["blueprintId"],
    topologyId: value["topologyId"],
    sourceArtifact: value["sourceArtifact"],
    areaAttribution,
  };
}

export function createCertifiedAreaGameRuleAttribution(
  result: Pick<HeadlessOptimizationResult, "layout" | "validation">,
): CertifiedAreaGameRuleAttribution {
  const rawFootprintAreaByKind: Partial<Record<HeadlessPlacedDevice["kind"], number>> = {};
  for (const device of result.layout.devices) {
    const area = device.width * device.height;
    rawFootprintAreaByKind[device.kind] = (rawFootprintAreaByKind[device.kind] ?? 0) + area;
  }
  const beltArea = rawFootprintAreaByKind.belt ?? 0;
  const areaExcludedBeltArea = result.layout.areaExcludedBeltCellCount;
  if (areaExcludedBeltArea > beltArea) {
    throw new Error("Area-excluded belt area exceeds the routed belt footprint");
  }
  const warehouseBusArea = rawFootprintAreaByKind["warehouse-bus"] ?? 0;
  const chargedFootprintAreaByKind = { ...rawFootprintAreaByKind };
  chargedFootprintAreaByKind.belt = beltArea - areaExcludedBeltArea;
  chargedFootprintAreaByKind["warehouse-bus"] = 0;
  const chargedFootprintArea = Object.values(chargedFootprintAreaByKind)
    .reduce((sum, area) => sum + (area ?? 0), 0);
  const chargedBoundingRemainderArea = result.layout.boundingArea - chargedFootprintArea;
  if (chargedBoundingRemainderArea < 0) {
    throw new Error("Charged entity footprints exceed the routed bounding area");
  }
  const materialLaneCountByKind: Partial<Record<"belt" | "pipe", number>> = {};
  for (const connection of result.validation.materialConnections) {
    materialLaneCountByKind[connection.kind] = (materialLaneCountByKind[connection.kind] ?? 0) + 1;
  }
  return {
    rawFootprintAreaByKind,
    chargedFootprintAreaByKind,
    chargedFootprintArea,
    chargedBoundingRemainderArea,
    areaExcludedBeltArea,
    warehouseBusArea,
    materialLaneCountByKind,
    connectedPortEndpointCount: result.validation.materialConnections.reduce(
      (count, connection) => count
        + Number(connection.sourceDeviceId !== null)
        + Number(connection.targetDeviceId !== null),
      0,
    ),
    minimumPowerDeviceCount: result.layout.minimumPowerDeviceCount,
  };
}

function createBestKnownArtifactEnvelope(options: Omit<
  CertifiedAreaBestKnownArtifact,
  "schemaVersion" | "validationProfile"
>): CertifiedAreaBestKnownArtifact {
  if (options.instanceHash.length === 0
    || !isPositiveSafeInteger(options.strictRoutedUpperBound)
    || options.blueprintId.length === 0
    || options.topologyId.length === 0
    || options.sourceArtifact.length === 0) {
    throw new Error("Invalid strict routed best-known artifact metadata");
  }
  if (options.areaAttribution.chargedFootprintArea
      + options.areaAttribution.chargedBoundingRemainderArea
    !== options.strictRoutedUpperBound) {
    throw new Error("Best-known area attribution does not sum to its strict UB");
  }
  return {
    schemaVersion: 1,
    validationProfile: CERTIFIED_AREA_BEST_KNOWN_ARTIFACT_PROFILE,
    ...options,
  };
}

function assertArchivedResultMatchesGraph(
  result: HeadlessOptimizationResult,
  expectedGraph: HeadlessMaterialGraph,
): void {
  const expectedNodes = expectedGraph.nodes.map(({ id, kind, definitionId }) =>
    ({ id, kind, definitionId })).sort(compareMaterialNode);
  const actualNodes = result.layout.devices.flatMap((device) =>
    device.kind === "production" || device.kind === "storage" || device.kind === "warehouse-port"
      ? [{ id: device.id, kind: device.kind, definitionId: device.definitionId }]
      : []).sort(compareMaterialNode);
  if (JSON.stringify(actualNodes) !== JSON.stringify(expectedNodes)) {
    throw new Error("Best-known report mandatory device graph does not match the benchmark instance");
  }

  const expectedEdges = expectedGraph.edges.map((edge) => ({ ...edge }))
    .sort(compareMaterialEdge);
  const actualLaneCount = new Map<string, number>();
  for (const connection of result.validation.materialConnections) {
    if (connection.sourceDeviceId === null || connection.targetDeviceId === null) continue;
    const key = materialEdgeKey(connection);
    actualLaneCount.set(key, (actualLaneCount.get(key) ?? 0) + 1);
  }
  const actualEdges = [...actualLaneCount].map(([key, laneCount]) => {
    const [sourceId, targetId, itemId] = key.split("\u0000");
    return { sourceId: sourceId!, targetId: targetId!, itemId: itemId!, laneCount };
  }).sort(compareMaterialEdge);
  if (JSON.stringify(actualEdges) !== JSON.stringify(expectedEdges)) {
    throw new Error("Best-known report material lane graph does not match the benchmark instance");
  }
}

function identifyArchivedMaterialConnections(
  connections: HeadlessOptimizationResult["validation"]["materialConnections"],
): Array<HeadlessOptimizationResult["validation"]["materialConnections"][number] & {
  readonly id: string;
}> {
  const occurrenceBySemanticKey = new Map<string, number>();
  return connections.map((connection) => {
    const key = materialEdgeKey(connection);
    const occurrence = (occurrenceBySemanticKey.get(key) ?? 0) + 1;
    occurrenceBySemanticKey.set(key, occurrence);
    return {
      ...connection,
      id: `${connection.itemId}:${connection.sourceDeviceId ?? "boundary"}`
        + `->${connection.targetDeviceId ?? "boundary"}:${occurrence}`,
    };
  });
}

function materialEdgeKey(edge: {
  readonly sourceId?: string;
  readonly targetId?: string;
  readonly sourceDeviceId?: string | null;
  readonly targetDeviceId?: string | null;
  readonly itemId: string;
}): string {
  return `${edge.sourceId ?? edge.sourceDeviceId ?? ""}\u0000`
    + `${edge.targetId ?? edge.targetDeviceId ?? ""}\u0000${edge.itemId}`;
}

function compareMaterialNode(
  left: { readonly id: string; readonly kind: string; readonly definitionId: string },
  right: { readonly id: string; readonly kind: string; readonly definitionId: string },
): number {
  return left.id.localeCompare(right.id)
    || left.kind.localeCompare(right.kind)
    || left.definitionId.localeCompare(right.definitionId);
}

function compareMaterialEdge(
  left: { readonly sourceId: string; readonly targetId: string; readonly itemId: string },
  right: { readonly sourceId: string; readonly targetId: string; readonly itemId: string },
): number {
  return left.sourceId.localeCompare(right.sourceId)
    || left.targetId.localeCompare(right.targetId)
    || left.itemId.localeCompare(right.itemId);
}

function parseAreaAttribution(value: unknown): CertifiedAreaGameRuleAttribution {
  if (!isRecord(value)) throw new Error("Invalid best-known area attribution");
  const rawFootprintAreaByKind = parseKindAreaRecord(value["rawFootprintAreaByKind"]);
  const chargedFootprintAreaByKind = parseKindAreaRecord(value["chargedFootprintAreaByKind"]);
  const materialLaneCountByKind = parseKindAreaRecord(
    value["materialLaneCountByKind"],
    new Set(["belt", "pipe"]),
  ) as Partial<Record<"belt" | "pipe", number>>;
  const numericFields = [
    "chargedFootprintArea",
    "chargedBoundingRemainderArea",
    "areaExcludedBeltArea",
    "warehouseBusArea",
    "connectedPortEndpointCount",
    "minimumPowerDeviceCount",
  ] as const;
  if (numericFields.some((field) => !isNonnegativeSafeInteger(value[field]))) {
    throw new Error("Invalid best-known area attribution totals");
  }
  return {
    rawFootprintAreaByKind,
    chargedFootprintAreaByKind,
    chargedFootprintArea: value["chargedFootprintArea"] as number,
    chargedBoundingRemainderArea: value["chargedBoundingRemainderArea"] as number,
    areaExcludedBeltArea: value["areaExcludedBeltArea"] as number,
    warehouseBusArea: value["warehouseBusArea"] as number,
    materialLaneCountByKind,
    connectedPortEndpointCount: value["connectedPortEndpointCount"] as number,
    minimumPowerDeviceCount: value["minimumPowerDeviceCount"] as number,
  };
}

function parseKindAreaRecord(
  value: unknown,
  allowedKeys = new Set<HeadlessPlacedDevice["kind"]>([
    "production",
    "belt",
    "pipe",
    "storage",
    "warehouse-port",
    "warehouse-bus",
    "power",
  ]),
): Partial<Record<HeadlessPlacedDevice["kind"], number>> {
  if (!isRecord(value)
    || Object.entries(value).some(([key, area]) =>
      !allowedKeys.has(key as HeadlessPlacedDevice["kind"])
      || !isNonnegativeSafeInteger(area))) {
    throw new Error("Invalid area-attribution kind record");
  }
  return { ...value } as Partial<Record<HeadlessPlacedDevice["kind"], number>>;
}

function formatProofSample(sample: CertifiedAreaBenchmarkSample): string {
  const masterGap = sample.masterAbsoluteGap === undefined
    ? "—"
    : sample.masterRelativeGap === undefined
      ? String(sample.masterAbsoluteGap)
      : `${sample.masterAbsoluteGap}/${(sample.masterRelativeGap * 100).toFixed(1)}%`;
  return `${sample.solverStatus}; LB=${formatOptionalInteger(sample.cpSatArea)}; `
    + `M=${formatOptionalInteger(sample.masterIncumbentArea)}; ΔM=${masterGap}`;
}

function formatMandatoryMix(
  areas: ReturnType<typeof measureCertifiedAreaByCategory>,
): string {
  const entries: ReadonlyArray<readonly [string, number | undefined]> = [
    ["P", areas.production],
    ["S", areas.storage],
    ["W", areas["warehouse-port"]],
    ["E", areas["minimum-power"]],
  ];
  return entries.filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
    .map(([label, area]) => `${label}${area}`)
    .join("/") || "—";
}

function formatChargedMix(attribution: CertifiedAreaGameRuleAttribution | undefined): string {
  if (attribution === undefined) return "—";
  const areas = attribution.chargedFootprintAreaByKind;
  const entries: ReadonlyArray<readonly [string, number | undefined]> = [
    ["P", areas.production],
    ["S", areas.storage],
    ["W", areas["warehouse-port"]],
    ["B", areas.belt],
    ["F", areas.pipe],
    ["E", areas.power],
  ];
  return entries.filter((entry): entry is readonly [string, number] =>
    entry[1] !== undefined && entry[1] > 0)
    .map(([label, area]) => `${label}${area}`)
    .join("/") || "—";
}

function minimumDefined(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonnegativeSafeInteger(value) && value > 0;
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
