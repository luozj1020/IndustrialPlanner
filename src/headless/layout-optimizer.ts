import {
  buildProductionPlanningIndex,
  computeProductionPlan,
  type ProductionPlanningPort,
  type ProductionPlanningRecipeTotal,
  type ProductionPlanningSourceConfig,
} from "@/app/shell/production-planning/production-planning-model";
import { createBlueprintDocument, type BlueprintDocument } from "@/domain/document/blueprint-document";
import type { WorldDocument, WorldEntity } from "@/domain/document/world-document";
import type { SlotLinkDefinition } from "@/domain/document/world-document";
import type { EntityDefinition } from "@/domain/registry/types/entity-definition";
import type { RecipeDefinition } from "@/domain/registry/types/recipe-definition";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { GridEdge, GridPoint, GridRotation } from "@/domain/shared/grid";
import type { LogisticsDraftEndpoint, LogisticsKind, LogisticsPathCell } from "@/domain/shared/logistics";
import {
  BELT_TRANSPORT_DURATION_SECONDS,
  PIPE_TRANSPORT_DURATION_SECONDS,
} from "@/domain/registry";
import {
  createEntityDefinitionMap,
  resolveDevicePortEndpoints,
  resolveLogisticsDefinitionId,
  resolveLogisticsPathCells,
} from "@/editor/logistics/logistics-utils";
import { compileSimulationTopology } from "@/simulation/topology-compiler";
import { rotateGridEdge } from "@/shared/geometry/port";
import {
  areGridRectsIntersecting,
  resolveEntityGridRect,
  resolvePowerRangeGridRect,
} from "@/shared/geometry/power-range";

import type {
  AffectedConnectionDescriptor,
  AffectedConnectionSet,
  CpSatStatus,
  CpSatStopReason,
  FrontierBlocker,
  HeadlessOptimizationRequest,
  HeadlessOptimizationResult,
  HeadlessMaterialGraph,
  HeadlessPlacedDevice,
  LayoutObjective,
  ObjectiveVector,
  RouteCapacityCutEdge,
  RouteCapacityConflictCertificate,
  RouteFailureEvidence,
  RoutePlacementConflictCertificate,
  Slot,
  EjectionChainConfig,
  RipUpConfig,
  RipUpResult,
  CbsConstraint,
  CbsNode,
} from "./types";
import { DEFAULT_LAYOUT_OBJECTIVE } from "./types";
import {
  DEFAULT_CP_SAT_OBJECTIVE_WEIGHTS,
  solveCpSatLayouts,
  type CpSatLayoutCapacityCut,
  type CpSatLayoutCluster,
  type CpSatLayoutEdge,
  type CpSatLayoutPlacement,
  type CpSatLayoutPortRequirement,
} from "./cp-sat-layout";
import { solveCpSatAreaLowerBound } from "./certified-area-relaxation";
import { createCertifiedAreaMandatoryDevices } from "./certified-area-mandatory-devices";
import {
  createBoundingAreaOptimalityReport,
  DEFAULT_CERTIFIED_AREA_MAX_SECONDS,
  isStrictRoutedBoundingAreaUpperBound,
  measureMandatoryDeviceAreaLowerBound,
} from "./bounding-area-optimality";

/**
 * Fixed contract for recipe-agnostic local compaction.
 *
 * These bounds deliberately describe geometric neighborhoods, not particular
 * machines or recipes. Changing them alters the reproducible local baseline
 * and therefore requires updating the generic compaction tests and examples.
 * Global rebuild, layer reordering, and arbitrary device-bank permutation are
 * intentionally outside this policy.
 */
export const LOCAL_COMPACTION_POLICY = Object.freeze({
  maximumCutDistance: 3,
  speculativeCutBeam: 8,
  upstreamMovementBeam: 12,
  edgeStorageMovementBeam: 12,
  minimumCutRoutingVariants: 6,
  minimumMovementRoutingVariants: 8,
});

/**
 * Bounded global neighborhood for changing a device's topology-layer band.
 *
 * Unlike local compaction, a terminal/upstream interlock changes which
 * equipment layers share the same frontage band. Width feasibility is proved
 * before any placement or A* work, then every surviving candidate is fully
 * rerouted and locally legalized.
 */
export const GLOBAL_LAYER_INTERLOCK_POLICY = Object.freeze({
  terminalRowInterlockBeam: 16,
  maximumTerminalRowStagger: 2,
  maximumPasses: 4,
});

export type CompactionAxis = "horizontal" | "vertical";

interface DeviceRequest {
  readonly id: string;
  readonly recipeId: string | null;
  readonly kind: "production" | "storage" | "warehouse-port" | "warehouse-bus";
  readonly warehouseItemId?: string;
  readonly warehouseConsumerId?: string;
  readonly warehouseProducerIds?: readonly string[];
  readonly definition: EntityDefinition;
  readonly config: Record<string, unknown>;
  readonly inputs: ReadonlyMap<string, number>;
  readonly outputs: ReadonlyMap<string, number>;
  readonly allowOutputWaste?: boolean;
}

interface PackingResult {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly usedWidth: number;
  readonly usedHeight: number;
  readonly equipmentArea: number;
  readonly debugLabel?: string;
  /** Distinguish the same geometry evaluated from a different routing seed. */
  readonly evaluationKey?: string;
  /** Complete hard-frontage route constructed incrementally with this packing. */
  readonly routingSeed?: RoutingResult;
  /** Contracted old paths used only as a preservation source for local rerouting. */
  readonly preservationRoutingSeed?: RoutingResult;
  /** Exact contracted paths that must be rebuilt instead of preserved. */
  readonly preservationForcedRipUpConnectionIds?: ReadonlySet<string>;
}

interface PackingCandidateSet {
  readonly packings: readonly PackingResult[];
  readonly cpSatCandidateCount: number;
  readonly cpSatStatus: CpSatStatus;
  readonly cpSatPythonVersion?: string;
  readonly cpSatOrToolsVersion?: string;
  readonly cpSatBudgetSeconds?: number;
  readonly cpSatAttemptedCandidates?: number;
  readonly cpSatStoppedBy?: CpSatStopReason;
  readonly cpSatElapsedMs?: number;
}

interface PackingNeighborSet {
  readonly packings: readonly PackingResult[];
  readonly clusterGenerated: number;
  readonly clusterCheapRejected: number;
  readonly globalRebuildGenerated: number;
  readonly partialRebuildGenerated: number;
  readonly globalRebuildCpSatElapsedMs: number;
  readonly objectiveHotspotDeviceIds: readonly string[];
}

export interface FlowClusterNode {
  readonly id: string;
  readonly kind: DeviceRequest["kind"];
  readonly directProducerIds?: readonly string[];
  readonly inputItemIds: readonly string[];
  readonly outputItemIds: readonly string[];
}

export interface FlowCluster {
  readonly terminalId: string;
  readonly directProducerIds: readonly string[];
  readonly sharedUpstreamIds: readonly string[];
  readonly allDeviceIds: readonly string[];
}

const MAX_FLOW_CLUSTER_DEVICES = 8;
const MAX_FLOW_CLUSTER_UPSTREAM_HOPS = 2;

type DevicePortEndpoint = Extract<LogisticsDraftEndpoint, { readonly type: "device-port" }>;

interface MaterialEndpoint {
  readonly request: DeviceRequest;
  readonly itemId: string;
  remainingPerMinute: number;
}

export interface RoutedConnection {
  readonly id: string;
  readonly itemId: string;
  readonly kind: LogisticsKind;
  readonly perMinute: number;
  readonly sourceDeviceId: string | null;
  readonly targetDeviceId: string | null;
  readonly points: readonly GridPoint[];
}

export interface ProvenStraightBeltCutCollapse {
  readonly axis: CompactionAxis;
  readonly coordinate: number;
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly connections: readonly RoutedConnection[];
  readonly movedDeviceIds: ReadonlySet<string>;
  readonly invalidConnectionIds: ReadonlySet<string>;
}

interface RoutingResult {
  readonly entities: Record<string, WorldEntity>;
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly connections: readonly RoutedConnection[];
  readonly internalConnectionCount: number;
  readonly boundaryConnectionCount: number;
  /** Belt cells from a warehouse unloader to a production input are rendered but do not count toward area. */
  readonly areaExcludedDeviceIds: ReadonlySet<string>;
}

export interface RoutedCellOccupation {
  readonly entityId: string;
  readonly kind: LogisticsKind;
  readonly axis: "horizontal" | "vertical" | null;
  crossed: boolean;
}

interface ContourRoutingContext {
  readonly referencePoints: readonly GridPoint[];
  readonly distanceByCell: ReadonlyMap<string, number>;
  readonly bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  } | null;
}

interface RoutedLayoutCandidate {
  readonly packing: PackingResult;
  readonly productionEntities: Record<string, WorldEntity>;
  readonly routing: RoutingResult;
  readonly allDevices: readonly HeadlessPlacedDevice[];
  readonly bounds: { readonly width: number; readonly height: number };
  readonly contourArea: number;
  readonly contourVoidArea: number;
  readonly boundingVoidCellCount: number;
  readonly enclosedVoidCellCount: number;
  readonly frontageOverflowCellCount: number;
  readonly minimumPowerDeviceCount: number;
  readonly equipmentArea: number;
  readonly physicalBounds: { readonly width: number; readonly height: number };
}

export interface MinimumCoverageCandidate {
  readonly id: string;
  readonly coveredTargetIds: readonly string[];
}

export interface MinimumCoverageSolution {
  readonly minimumCount: number;
  readonly selectedCandidateIds: readonly string[];
}

/**
 * Exact minimum-cardinality set cover with optional pairwise compatibility.
 *
 * Candidates sharing a coverage mask remain separate when compatibility is
 * supplied: geometrically different power-pole positions can cover the same
 * machines while conflicting with different later positions. Iterative
 * deepening proves that the first returned witness uses the fewest candidates.
 */
export function solveMinimumCoverage<Candidate extends MinimumCoverageCandidate>(options: {
  readonly targetIds: readonly string[];
  readonly candidates: readonly Candidate[];
  readonly areCompatible?: (left: Candidate, right: Candidate) => boolean;
}): MinimumCoverageSolution | null {
  const targetIds = [...new Set(options.targetIds)].sort();
  if (targetIds.length === 0) return { minimumCount: 0, selectedCandidateIds: [] };
  const targetIndexById = new Map(targetIds.map((id, index) => [id, index]));
  const normalized = options.candidates.flatMap((candidate, inputIndex) => {
    let coverageMask = 0n;
    for (const targetId of candidate.coveredTargetIds) {
      const targetIndex = targetIndexById.get(targetId);
      if (targetIndex !== undefined) coverageMask |= 1n << BigInt(targetIndex);
    }
    return coverageMask === 0n ? [] : [{ candidate, coverageMask, inputIndex }];
  });
  const fullMask = (1n << BigInt(targetIds.length)) - 1n;
  const reachableMask = normalized.reduce((mask, candidate) => mask | candidate.coverageMask, 0n);
  if (reachableMask !== fullMask) return null;
  const countBits = (input: bigint): number => {
    let value = input;
    let count = 0;
    while (value !== 0n) {
      value &= value - 1n;
      count += 1;
    }
    return count;
  };
  const groups = [...normalized.reduce((byMask, candidate) => {
    byMask.set(candidate.coverageMask, [
      ...(byMask.get(candidate.coverageMask) ?? []),
      candidate,
    ]);
    return byMask;
  }, new Map<bigint, typeof normalized>()).entries()]
    .map(([coverageMask, candidates]) => ({
      coverageMask,
      candidates: [...candidates].sort((left, right) => left.inputIndex - right.inputIndex),
    }));
  const maximumSingleCoverage = Math.max(...groups.map((group) => countBits(group.coverageMask)));
  const lowerBound = Math.max(1, Math.ceil(targetIds.length / maximumSingleCoverage));
  const areCompatible = options.areCompatible ?? (() => true);
  const selected: typeof normalized = [];
  const selectedMasks = new Set<bigint>();

  const search = (coveredMask: bigint, remaining: number): MinimumCoverageSolution | null => {
    if (coveredMask === fullMask) {
      return {
        minimumCount: selected.length,
        selectedCandidateIds: selected.map(({ candidate }) => candidate.id),
      };
    }
    if (remaining <= 0) return null;
    const compatibleGroups = groups.flatMap((group) => {
      if (selectedMasks.has(group.coverageMask)) return [];
      const newCoverage = group.coverageMask & ~coveredMask;
      if (newCoverage === 0n) return [];
      const candidates = group.candidates.filter(({ candidate }) => selected.every((chosen) =>
        areCompatible(chosen.candidate, candidate)));
      return candidates.length === 0 ? [] : [{ ...group, candidates, newCoverage }];
    });
    const compatibleUnion = compatibleGroups.reduce(
      (mask, group) => mask | group.coverageMask,
      coveredMask,
    );
    if (compatibleUnion !== fullMask) return null;
    const maximumGain = Math.max(...compatibleGroups.map((group) => countBits(group.newCoverage)));
    if (Math.ceil(countBits(fullMask & ~coveredMask) / maximumGain) > remaining) return null;

    let selectedTargetBit = 0n;
    let targetGroups: typeof compatibleGroups = [];
    for (let targetIndex = 0; targetIndex < targetIds.length; targetIndex += 1) {
      const targetBit = 1n << BigInt(targetIndex);
      if ((coveredMask & targetBit) !== 0n) continue;
      const coveringGroups = compatibleGroups.filter((group) =>
        (group.coverageMask & targetBit) !== 0n);
      if (coveringGroups.length === 0) return null;
      if (targetGroups.length === 0 || coveringGroups.length < targetGroups.length) {
        selectedTargetBit = targetBit;
        targetGroups = coveringGroups;
      }
    }
    if (selectedTargetBit === 0n) return null;
    targetGroups.sort((left, right) =>
      countBits(right.newCoverage) - countBits(left.newCoverage)
      || left.candidates[0]!.inputIndex - right.candidates[0]!.inputIndex);
    for (const group of targetGroups) {
      selectedMasks.add(group.coverageMask);
      for (const candidate of group.candidates) {
        selected.push(candidate);
        const solution = search(coveredMask | group.coverageMask, remaining - 1);
        selected.pop();
        if (solution !== null) return solution;
      }
      selectedMasks.delete(group.coverageMask);
    }
    return null;
  };

  for (let limit = lowerBound; limit <= targetIds.length; limit += 1) {
    const solution = search(0n, limit);
    if (solution !== null) return solution;
  }
  return null;
}

interface RoutedLayoutSelection extends RoutedLayoutCandidate {
  readonly search: HeadlessOptimizationResult["search"];
  readonly routeFailureDiagnostics: readonly RouteFailureEvidence[];
}

const DEFAULT_SOURCE_CONFIG: ProductionPlanningSourceConfig = {
  waterPolicy: "use-byproduct",
  acidPolicy: "use-byproduct",
  sewagePolicy: "external-supply",
};

/** Error thrown when routing fails, carrying structured failure evidence. */
class RouteFailureError extends Error {
  public readonly evidence: RouteFailureEvidence;

  constructor(evidence: RouteFailureEvidence, message: string) {
    super(message);
    this.name = "RouteFailureError";
    this.evidence = evidence;
  }
}

/** Maximum reachable cells to collect for deterministic bounded evidence. */
const MAX_REACHABLE_CELLS = 500;

/** Maximum frontier blockers to collect for deterministic bounded evidence. */
const MAX_FRONTIER_BLOCKERS = 200;

const MAX_ATTEMPTED_PORT_PAIRS = 64;
const MAX_FEASIBLE_ELITE_STATES = 8;
const MAX_ELITE_REFINEMENT_BASES = 3;
const MAX_CERTIFIED_ROUTE_FAILURE_CUTS = 64;
const MAX_CERTIFIED_ROUTE_CAPACITY_CUTS = 8;

/**
 * Prove a placement-only routing conflict on the relaxed free-space grid.
 *
 * The search deliberately ignores committed logistics, reserved sibling ports,
 * bend rules, and route order. Consequently, a disconnection here is a valid
 * necessary-condition failure for every detailed routing strategy at the same
 * certified device poses. Unlike the diagnostic frontier collector below, this
 * traversal is complete; only aggregate counts and device IDs are serialized.
 */
export function proveRoutePlacementConflict(options: {
  readonly width: number;
  readonly height: number;
  readonly blocked: ReadonlySet<string>;
  readonly productionDevices: readonly HeadlessPlacedDevice[];
  readonly sourceDeviceId: string | null;
  readonly targetDeviceId: string | null;
  /** Null denotes the map boundary. */
  readonly sourceGridPoints: readonly GridPoint[] | null;
  /** Null denotes the map boundary. */
  readonly targetGridPoints: readonly GridPoint[] | null;
}): RoutePlacementConflictCertificate | null {
  const normalizePoints = (points: readonly GridPoint[] | null): GridPoint[] => {
    if (points === null) return [];
    const unique = new Map<string, GridPoint>();
    for (const point of points) {
      if (point.x < 0 || point.y < 0 || point.x >= options.width || point.y >= options.height) continue;
      unique.set(gridKey(point), { x: point.x, y: point.y });
    }
    return [...unique.values()].sort((left, right) =>
      left.y - right.y || left.x - right.x);
  };
  const sourceIsBoundary = options.sourceGridPoints === null;
  const targetIsBoundary = options.targetGridPoints === null;
  const sourcePoints = normalizePoints(options.sourceGridPoints);
  const targetPoints = normalizePoints(options.targetGridPoints);
  const movableIds = new Set(options.productionDevices
    .filter((device) => device.kind === "production" || device.kind === "storage")
    .map((device) => device.id));
  const certificate = (
    proof: RoutePlacementConflictCertificate["proof"],
    reachableCellCount: number,
    separatorCellCount: number,
    poseDeviceIds: Iterable<string>,
  ): RoutePlacementConflictCertificate => ({
    proof,
    sourceIsBoundary,
    targetIsBoundary,
    sourceEndpointCount: sourcePoints.length,
    targetEndpointCount: targetPoints.length,
    reachableCellCount,
    separatorCellCount,
    poseDeviceIds: [...new Set(poseDeviceIds)].sort(),
  });

  const missingEndpointDeviceIds: string[] = [];
  if (!sourceIsBoundary && sourcePoints.length === 0
    && options.sourceDeviceId !== null && movableIds.has(options.sourceDeviceId)) {
    missingEndpointDeviceIds.push(options.sourceDeviceId);
  }
  if (!targetIsBoundary && targetPoints.length === 0
    && options.targetDeviceId !== null && movableIds.has(options.targetDeviceId)) {
    missingEndpointDeviceIds.push(options.targetDeviceId);
  }
  if ((!sourceIsBoundary && sourcePoints.length === 0)
    || (!targetIsBoundary && targetPoints.length === 0)) {
    return certificate("no-legal-endpoint", 0, 0, missingEndpointDeviceIds);
  }
  // A boundary-to-boundary lane has no movable endpoint whose pose could form a
  // useful local cut. This case is not emitted by normal production planning.
  if (sourceIsBoundary && targetIsBoundary) return null;

  // Connectivity is undirected in this relaxed proof. When the source is the
  // boundary, search from the finite target-port set toward any boundary cell.
  const startPoints = sourceIsBoundary ? targetPoints : sourcePoints;
  const goalIsBoundary = targetIsBoundary || sourceIsBoundary;
  const goalKeys = new Set((sourceIsBoundary ? sourcePoints : targetPoints).map(gridKey));
  const separatorKeys = new Set<string>();
  const queue: GridPoint[] = [];
  const visited = new Set<string>();
  for (const point of startPoints) {
    const key = gridKey(point);
    if (options.blocked.has(key)) {
      separatorKeys.add(key);
      continue;
    }
    if (!visited.has(key)) {
      visited.add(key);
      queue.push(point);
    }
  }
  // A blocked finite goal can become reachable if its owning equipment moves,
  // so its owner must participate in the pose certificate even when it is not
  // adjacent to the current reachable component.
  if (!goalIsBoundary) {
    for (const point of targetPoints) {
      const key = gridKey(point);
      if (options.blocked.has(key)) separatorKeys.add(key);
    }
  }
  const isGoal = (point: GridPoint): boolean => goalIsBoundary
    ? point.x === 0 || point.y === 0
      || point.x === options.width - 1 || point.y === options.height - 1
    : goalKeys.has(gridKey(point));
  if (queue.some(isGoal)) return null;

  const directions = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ] as const;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const point = queue[cursor]!;
    for (const delta of directions) {
      const neighbor = { x: point.x + delta.x, y: point.y + delta.y };
      if (neighbor.x < 0 || neighbor.y < 0
        || neighbor.x >= options.width || neighbor.y >= options.height) continue;
      const key = gridKey(neighbor);
      if (options.blocked.has(key)) {
        separatorKeys.add(key);
        continue;
      }
      if (visited.has(key)) continue;
      if (isGoal(neighbor)) return null;
      visited.add(key);
      queue.push(neighbor);
    }
  }

  const ownerByCell = new Map<string, string>();
  for (const device of options.productionDevices) {
    for (let y = device.position.y; y < device.position.y + device.height; y += 1) {
      for (let x = device.position.x; x < device.position.x + device.width; x += 1) {
        ownerByCell.set(`${x},${y}`, device.id);
      }
    }
  }
  const poseDeviceIds = [options.sourceDeviceId, options.targetDeviceId]
    .filter((id): id is string => id !== null && movableIds.has(id));
  for (const key of separatorKeys) {
    const ownerId = ownerByCell.get(key);
    if (ownerId !== undefined && movableIds.has(ownerId)) poseDeviceIds.push(ownerId);
  }
  return certificate(
    "static-free-space-separator",
    visited.size,
    separatorKeys.size,
    poseDeviceIds,
  );
}

interface RouteCapacityProofLane {
  readonly id: string;
  readonly sourceDeviceId: string | null;
  readonly targetDeviceId: string | null;
  /** Null denotes the map boundary, whose entry side is not fixed. */
  readonly sourceGridPoints: readonly GridPoint[] | null;
  /** Null denotes the map boundary, whose exit side is not fixed. */
  readonly targetGridPoints: readonly GridPoint[] | null;
}

interface RouteCapacityProofOptions {
  readonly width: number;
  readonly height: number;
  readonly blocked: ReadonlySet<string>;
  readonly productionDevices: readonly HeadlessPlacedDevice[];
  readonly lanes: readonly RouteCapacityProofLane[];
}

interface NormalizedRouteCapacityProofLane extends RouteCapacityProofLane {
  readonly sourceGridPoints: readonly GridPoint[];
  readonly targetGridPoints: readonly GridPoint[];
}

interface RouteCapacityProofContext {
  readonly movableIds: ReadonlySet<string>;
  readonly ownerByCell: ReadonlyMap<string, string>;
  readonly lanes: readonly NormalizedRouteCapacityProofLane[];
}

function createRouteCapacityProofContext(
  options: RouteCapacityProofOptions,
): RouteCapacityProofContext {
  const movableIds = new Set(options.productionDevices
    .filter((device) => device.kind === "production" || device.kind === "storage")
    .map((device) => device.id));
  const ownerByCell = new Map<string, string>();
  for (const device of options.productionDevices) {
    for (let y = device.position.y; y < device.position.y + device.height; y += 1) {
      for (let x = device.position.x; x < device.position.x + device.width; x += 1) {
        ownerByCell.set(`${x},${y}`, device.id);
      }
    }
  }
  const normalizePoints = (points: readonly GridPoint[] | null): GridPoint[] => {
    if (points === null) return [];
    const unique = new Map<string, GridPoint>();
    for (const point of points) {
      if (point.x < 0 || point.y < 0 || point.x >= options.width || point.y >= options.height) continue;
      unique.set(gridKey(point), { x: point.x, y: point.y });
    }
    return [...unique.values()].sort((left, right) =>
      left.y - right.y || left.x - right.x);
  };
  const lanes = options.lanes.flatMap((lane): NormalizedRouteCapacityProofLane[] => {
    // A boundary route may enter/leave on either side of the cut, so it cannot
    // create mandatory cut demand without a separately fixed boundary terminal.
    if (lane.sourceGridPoints === null || lane.targetGridPoints === null) return [];
    const sourceGridPoints = normalizePoints(lane.sourceGridPoints);
    const targetGridPoints = normalizePoints(lane.targetGridPoints);
    if (sourceGridPoints.length === 0 || targetGridPoints.length === 0) return [];
    return [{ ...lane, sourceGridPoints, targetGridPoints }];
  }).sort((left, right) =>
    left.id.localeCompare(right.id)
    || left.sourceGridPoints.map(gridKey).join("|").localeCompare(right.sourceGridPoints.map(gridKey).join("|"))
    || left.targetGridPoints.map(gridKey).join("|").localeCompare(right.targetGridPoints.map(gridKey).join("|")));
  return { movableIds, ownerByCell, lanes };
}

function countBigIntBits(input: bigint): number {
  let value = input;
  let count = 0;
  while (value !== 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

/**
 * Return a minimum-cardinality blocker set for small conflicts and an
 * inclusion-minimal deterministic set for larger ones. Fixing the returned
 * poses, plus the fixed blockers, still leaves strictly fewer than demand edges.
 */
function minimizeCapacityBlockingPoseIds(options: {
  readonly cutEdgeCount: number;
  readonly demand: number;
  readonly fixedBlockedEdgeIndexes: ReadonlySet<number>;
  readonly coverageByOwner: ReadonlyMap<string, bigint>;
  readonly allMovableIds: ReadonlySet<string>;
}): string[] {
  const requiredGuaranteedBlocked = Math.max(0, options.cutEdgeCount - options.demand + 1);
  const requiredMovableCoverage = requiredGuaranteedBlocked - options.fixedBlockedEdgeIndexes.size;
  if (requiredMovableCoverage <= 0) return [];

  const candidates = [...options.coverageByOwner]
    .filter(([, mask]) => mask !== 0n)
    .map(([id, mask]) => ({ id, mask, coverage: countBigIntBits(mask) }))
    .sort((left, right) => right.coverage - left.coverage || left.id.localeCompare(right.id));
  const fullCoverage = candidates.reduce((mask, candidate) => mask | candidate.mask, 0n);
  if (countBigIntBits(fullCoverage) < requiredMovableCoverage) {
    // Defensive fallback: fixing every movable rectangle preserves the exact
    // obstacle grid even if an overlapping owner could not be attributed.
    return [...options.allMovableIds].sort();
  }

  const EXACT_BLOCKER_LIMIT = 16;
  if (candidates.length <= EXACT_BLOCKER_LIMIT) {
    const suffixUnion = Array<bigint>(candidates.length + 1).fill(0n);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      suffixUnion[index] = suffixUnion[index + 1]! | candidates[index]!.mask;
    }
    const selected: number[] = [];
    const search = (index: number, remaining: number, covered: bigint): string[] | null => {
      if (countBigIntBits(covered) >= requiredMovableCoverage) {
        return selected.map((selectedIndex) => candidates[selectedIndex]!.id).sort();
      }
      if (remaining <= 0 || candidates.length - index < remaining) return null;
      if (countBigIntBits(covered | suffixUnion[index]!) < requiredMovableCoverage) return null;

      selected.push(index);
      const withCandidate = search(index + 1, remaining - 1, covered | candidates[index]!.mask);
      selected.pop();
      if (withCandidate !== null) return withCandidate;
      return search(index + 1, remaining, covered);
    };
    const maximumSingleCoverage = Math.max(...candidates.map((candidate) => candidate.coverage));
    const lowerBound = Math.max(1, Math.ceil(requiredMovableCoverage / maximumSingleCoverage));
    for (let limit = lowerBound; limit <= candidates.length; limit += 1) {
      const solution = search(0, limit, 0n);
      if (solution !== null) return solution;
    }
  }

  // Large conflicts use deletion filtering. The result is inclusion-minimal:
  // after a failed removal, deleting more candidates cannot make it removable.
  let selected = [...candidates];
  for (const candidate of [...candidates]
    .sort((left, right) => left.coverage - right.coverage || left.id.localeCompare(right.id))) {
    const without = selected.filter((entry) => entry.id !== candidate.id);
    const coverage = without.reduce((mask, entry) => mask | entry.mask, 0n);
    if (countBigIntBits(coverage) >= requiredMovableCoverage) selected = without;
  }
  return selected.map((candidate) => candidate.id).sort();
}

function analyzeRouteCapacityCut(options: {
  readonly cutEdges: readonly RouteCapacityCutEdge[];
  readonly demand: number;
  readonly blocked: ReadonlySet<string>;
  readonly context: RouteCapacityProofContext;
}): {
  readonly capacity: number;
  readonly fixedBlockedEdgeIndexes: readonly number[];
  readonly blockingPoseDeviceIds: readonly string[];
} {
  let capacity = 0;
  const fixedBlockedEdgeIndexes = new Set<number>();
  const coverageByOwner = new Map<string, bigint>();
  for (const [edgeIndex, edge] of options.cutEdges.entries()) {
    const blockedKeys = [gridKey(edge.from), gridKey(edge.to)]
      .filter((key) => options.blocked.has(key));
    if (blockedKeys.length === 0) {
      capacity += 1;
      continue;
    }
    let hasFixedBlocker = false;
    const movableOwners = new Set<string>();
    for (const key of blockedKeys) {
      const ownerId = options.context.ownerByCell.get(key);
      if (ownerId !== undefined && options.context.movableIds.has(ownerId)) {
        movableOwners.add(ownerId);
      } else {
        hasFixedBlocker = true;
      }
    }
    if (hasFixedBlocker) {
      fixedBlockedEdgeIndexes.add(edgeIndex);
      continue;
    }
    for (const ownerId of movableOwners) {
      coverageByOwner.set(
        ownerId,
        (coverageByOwner.get(ownerId) ?? 0n) | (1n << BigInt(edgeIndex)),
      );
    }
  }
  return {
    capacity,
    fixedBlockedEdgeIndexes: [...fixedBlockedEdgeIndexes].sort((left, right) => left - right),
    blockingPoseDeviceIds: minimizeCapacityBlockingPoseIds({
      cutEdgeCount: options.cutEdges.length,
      demand: options.demand,
      fixedBlockedEdgeIndexes,
      coverageByOwner,
      allMovableIds: options.context.movableIds,
    }),
  };
}

function collectCapacityEndpointPoseIds(
  lanes: readonly NormalizedRouteCapacityProofLane[],
  movableIds: ReadonlySet<string>,
): string[] {
  const endpointPoseIds = new Set<string>();
  for (const lane of lanes) {
    for (const deviceId of [lane.sourceDeviceId, lane.targetDeviceId]) {
      if (deviceId !== null && movableIds.has(deviceId)) endpointPoseIds.add(deviceId);
    }
  }
  return [...endpointPoseIds].sort();
}

/**
 * Prove a multi-lane capacity conflict on a complete axis-aligned grid cut.
 *
 * A lane contributes to demand only when every legal source endpoint is on one
 * side and every legal target endpoint is on the other. Capacity is the number
 * of cut edges whose two incident cells are free of immutable equipment/frontage
 * obstacles. Every demanded route must use at least one such edge, while two
 * routes cannot share it. Therefore demand > capacity is a placement-only proof.
 */
export function proveRouteCutCapacityConflict(
  options: RouteCapacityProofOptions,
): RouteCapacityConflictCertificate | null {
  type Axis = "vertical" | "horizontal";
  const context = createRouteCapacityProofContext(options);
  const sideOf = (
    points: readonly GridPoint[],
    axis: Axis,
    coordinate: number,
  ): -1 | 1 | null => {
    const coordinateOf = (point: GridPoint): number =>
      axis === "vertical" ? point.x : point.y;
    const side = coordinateOf(points[0]!) < coordinate ? -1 : 1;
    return points.every((point) =>
      (coordinateOf(point) < coordinate ? -1 : 1) === side) ? side : null;
  };
  const certificates: RouteCapacityConflictCertificate[] = [];
  const inspectCut = (axis: Axis, coordinate: number): void => {
    const crossingLanes = context.lanes.filter((lane) => {
      const sourceSide = sideOf(lane.sourceGridPoints, axis, coordinate);
      const targetSide = sideOf(lane.targetGridPoints, axis, coordinate);
      return sourceSide !== null && targetSide !== null && sourceSide !== targetSide;
    });
    if (crossingLanes.length === 0) return;

    const orthogonalSpan = axis === "vertical" ? options.height : options.width;
    const cutEdges = Array.from({ length: orthogonalSpan }, (_, offset): RouteCapacityCutEdge => ({
      from: axis === "vertical"
        ? { x: coordinate - 1, y: offset }
        : { x: offset, y: coordinate - 1 },
      to: axis === "vertical"
        ? { x: coordinate, y: offset }
        : { x: offset, y: coordinate },
    }));
    const analysis = analyzeRouteCapacityCut({
      cutEdges,
      demand: crossingLanes.length,
      blocked: options.blocked,
      context,
    });
    if (crossingLanes.length <= analysis.capacity) return;

    const endpointPoseDeviceIds = collectCapacityEndpointPoseIds(crossingLanes, context.movableIds);
    const poseDeviceIds = new Set([
      ...endpointPoseDeviceIds,
      ...analysis.blockingPoseDeviceIds,
    ]);
    const crossingLaneIds = crossingLanes.map((lane) => lane.id).sort();
    certificates.push({
      proof: "static-cut-capacity",
      axis,
      coordinate,
      gridWidth: options.width,
      gridHeight: options.height,
      demand: crossingLanes.length,
      capacity: analysis.capacity,
      deficit: crossingLanes.length - analysis.capacity,
      crossingLaneIds,
      endpointPoseDeviceIds,
      blockingPoseDeviceIds: analysis.blockingPoseDeviceIds,
      fixedBlockedOffsets: analysis.fixedBlockedEdgeIndexes,
      poseDeviceIds: [...poseDeviceIds].sort(),
    });
  };
  for (let x = 1; x < options.width; x += 1) inspectCut("vertical", x);
  for (let y = 1; y < options.height; y += 1) inspectCut("horizontal", y);

  return certificates.sort((left, right) =>
    // Prefer a proof that can drive a master pose cut, then the largest deficit
    // and the smallest exact pose conjunction.
    Number(left.poseDeviceIds.length === 0) - Number(right.poseDeviceIds.length === 0)
    || right.deficit - left.deficit
    || left.poseDeviceIds.length - right.poseDeviceIds.length
    || left.capacity - right.capacity
    || Number(left.axis === "horizontal") - Number(right.axis === "horizontal")
    || left.coordinate! - right.coordinate!
    || left.crossingLaneIds.join("\u0000").localeCompare(right.crossingLaneIds.join("\u0000"))
  )[0] ?? null;
}

interface ResidualFlowEdge {
  to: number;
  reverse: number;
  capacity: number;
}

/** Return the cell nodes reachable from a super-source after a unit-edge max-flow. */
function solveStaticGridMinCut(options: {
  readonly width: number;
  readonly height: number;
  readonly blocked: ReadonlySet<string>;
  readonly sourceGridPoints: readonly GridPoint[];
  readonly targetGridPoints: readonly GridPoint[];
}): readonly boolean[] | null {
  const cellCount = options.width * options.height;
  // Keep certificate generation bounded; this is a fallback after cheap axis cuts.
  if (cellCount <= 0 || cellCount > 4_096) return null;
  const sourceNode = cellCount;
  const targetNode = cellCount + 1;
  const graph = Array.from({ length: cellCount + 2 }, (): ResidualFlowEdge[] => []);
  const addDirectedEdge = (from: number, to: number, capacity: number): void => {
    const forward: ResidualFlowEdge = { to, reverse: graph[to]!.length, capacity };
    const reverse: ResidualFlowEdge = { to: from, reverse: graph[from]!.length, capacity: 0 };
    graph[from]!.push(forward);
    graph[to]!.push(reverse);
  };
  const nodeOf = (point: GridPoint): number => point.y * options.width + point.x;
  const finiteEdgeCount = Math.max(
    0,
    (options.width - 1) * options.height + (options.height - 1) * options.width,
  );
  const infiniteCapacity = finiteEdgeCount + 1;
  for (let y = 0; y < options.height; y += 1) {
    for (let x = 0; x < options.width; x += 1) {
      const from = { x, y };
      for (const to of [{ x: x + 1, y }, { x, y: y + 1 }]) {
        if (to.x >= options.width || to.y >= options.height) continue;
        if (options.blocked.has(gridKey(from)) || options.blocked.has(gridKey(to))) continue;
        addDirectedEdge(nodeOf(from), nodeOf(to), 1);
        addDirectedEdge(nodeOf(to), nodeOf(from), 1);
      }
    }
  }
  for (const point of options.sourceGridPoints) {
    addDirectedEdge(sourceNode, nodeOf(point), infiniteCapacity);
  }
  for (const point of options.targetGridPoints) {
    addDirectedEdge(nodeOf(point), targetNode, infiniteCapacity);
  }

  const level = Array<number>(graph.length).fill(-1);
  const nextEdge = Array<number>(graph.length).fill(0);
  const buildLevelGraph = (): boolean => {
    level.fill(-1);
    level[sourceNode] = 0;
    const queue = [sourceNode];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const node = queue[cursor]!;
      for (const edge of graph[node]!) {
        if (edge.capacity <= 0 || level[edge.to]! >= 0) continue;
        level[edge.to] = level[node]! + 1;
        queue.push(edge.to);
      }
    }
    return level[targetNode]! >= 0;
  };
  const sendFlow = (node: number, available: number): number => {
    if (node === targetNode) return available;
    for (; nextEdge[node]! < graph[node]!.length; nextEdge[node]! += 1) {
      const edge = graph[node]![nextEdge[node]!]!;
      if (edge.capacity <= 0 || level[edge.to] !== level[node]! + 1) continue;
      const sent = sendFlow(edge.to, Math.min(available, edge.capacity));
      if (sent <= 0) continue;
      edge.capacity -= sent;
      graph[edge.to]![edge.reverse]!.capacity += sent;
      return sent;
    }
    return 0;
  };
  let maximumFlow = 0;
  while (buildLevelGraph()) {
    nextEdge.fill(0);
    for (;;) {
      const sent = sendFlow(sourceNode, infiniteCapacity);
      if (sent <= 0) break;
      maximumFlow += sent;
      if (maximumFlow >= infiniteCapacity) return null;
    }
  }

  const reachable = Array<boolean>(graph.length).fill(false);
  reachable[sourceNode] = true;
  const queue = [sourceNode];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor]!;
    for (const edge of graph[node]!) {
      if (edge.capacity <= 0 || reachable[edge.to]) continue;
      reachable[edge.to] = true;
      queue.push(edge.to);
    }
  }
  return reachable.slice(0, cellCount);
}

/**
 * Prove a frozen-lane capacity conflict on an arbitrary static grid min-cut.
 * Seed s-t min-cuts are bounded and deterministic; each accepted certificate
 * is nevertheless complete because its explicit edge boundary partitions every
 * grid cell and every counted lane has all legal endpoints on opposite sides.
 */
export function proveRouteGeneralCutCapacityConflict(options: RouteCapacityProofOptions & {
  readonly preferredLaneId?: string;
  readonly maxSeedLanes?: number;
}): RouteCapacityConflictCertificate | null {
  const context = createRouteCapacityProofContext(options);
  const maximumSeeds = Math.max(1, Math.min(16, Math.floor(options.maxSeedLanes ?? 8)));
  const seenEndpointPartitions = new Set<string>();
  const seedLanes = [...context.lanes]
    .sort((left, right) =>
      Number(right.id === options.preferredLaneId) - Number(left.id === options.preferredLaneId)
      || left.sourceGridPoints.length + left.targetGridPoints.length
        - right.sourceGridPoints.length - right.targetGridPoints.length
      || left.id.localeCompare(right.id))
    .filter((lane) => {
      const key = `${lane.sourceGridPoints.map(gridKey).join("|")}=>${lane.targetGridPoints.map(gridKey).join("|")}`;
      if (seenEndpointPartitions.has(key)) return false;
      seenEndpointPartitions.add(key);
      return true;
    })
    .slice(0, maximumSeeds);
  const certificates: RouteCapacityConflictCertificate[] = [];
  const seenCuts = new Set<string>();
  const sideOf = (points: readonly GridPoint[], sourceSide: readonly boolean[]): boolean | null => {
    const first = sourceSide[points[0]!.y * options.width + points[0]!.x]!;
    return points.every((point) =>
      sourceSide[point.y * options.width + point.x] === first) ? first : null;
  };

  for (const seedLane of seedLanes) {
    const sourceSide = solveStaticGridMinCut({
      width: options.width,
      height: options.height,
      blocked: options.blocked,
      sourceGridPoints: seedLane.sourceGridPoints,
      targetGridPoints: seedLane.targetGridPoints,
    });
    if (sourceSide === null) continue;
    const cutEdges: RouteCapacityCutEdge[] = [];
    for (let y = 0; y < options.height; y += 1) {
      for (let x = 0; x < options.width; x += 1) {
        const from = { x, y };
        const fromSide = sourceSide[y * options.width + x]!;
        for (const to of [{ x: x + 1, y }, { x, y: y + 1 }]) {
          if (to.x >= options.width || to.y >= options.height) continue;
          if (sourceSide[to.y * options.width + to.x] === fromSide) continue;
          cutEdges.push({ from, to });
        }
      }
    }
    if (cutEdges.length === 0) continue;
    const cutKey = cutEdges
      .map((edge) => `${gridKey(edge.from)}>${gridKey(edge.to)}`)
      .join("|");
    if (seenCuts.has(cutKey)) continue;
    seenCuts.add(cutKey);

    const crossingLanes = context.lanes.filter((lane) => {
      const source = sideOf(lane.sourceGridPoints, sourceSide);
      const target = sideOf(lane.targetGridPoints, sourceSide);
      return source !== null && target !== null && source !== target;
    });
    if (crossingLanes.length === 0) continue;
    const analysis = analyzeRouteCapacityCut({
      cutEdges,
      demand: crossingLanes.length,
      blocked: options.blocked,
      context,
    });
    if (crossingLanes.length <= analysis.capacity) continue;

    const endpointPoseDeviceIds = collectCapacityEndpointPoseIds(crossingLanes, context.movableIds);
    const poseDeviceIds = new Set([
      ...endpointPoseDeviceIds,
      ...analysis.blockingPoseDeviceIds,
    ]);
    certificates.push({
      proof: "static-general-cut-capacity",
      axis: "general",
      coordinate: null,
      gridWidth: options.width,
      gridHeight: options.height,
      demand: crossingLanes.length,
      capacity: analysis.capacity,
      deficit: crossingLanes.length - analysis.capacity,
      crossingLaneIds: crossingLanes.map((lane) => lane.id).sort(),
      endpointPoseDeviceIds,
      blockingPoseDeviceIds: analysis.blockingPoseDeviceIds,
      cutEdges,
      fixedBlockedEdgeIndexes: analysis.fixedBlockedEdgeIndexes,
      poseDeviceIds: [...poseDeviceIds].sort(),
    });
  }

  return certificates.sort((left, right) =>
    Number(left.poseDeviceIds.length === 0) - Number(right.poseDeviceIds.length === 0)
    || right.deficit - left.deficit
    || left.poseDeviceIds.length - right.poseDeviceIds.length
    || left.capacity - right.capacity
    || (left.proof === "static-general-cut-capacity" ? left.cutEdges.length : 0)
      - (right.proof === "static-general-cut-capacity" ? right.cutEdges.length : 0)
    || left.crossingLaneIds.join("\u0000").localeCompare(right.crossingLaneIds.join("\u0000"))
  )[0] ?? null;
}

/**
 * Collects bounded structured routing failure evidence using a deterministic BFS
 * from the source position. Does not change route selection or A* costs.
 */
export function collectRouteFailureEvidence(options: {
  readonly start: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly blocked: ReadonlySet<string>;
  readonly routedCellOccupations: ReadonlyMap<string, RoutedCellOccupation>;
  readonly productionDevices: readonly HeadlessPlacedDevice[];
  readonly kind: LogisticsKind;
}): {
  readonly reachableCells: readonly { readonly x: number; readonly y: number }[];
  readonly frontierBlockers: readonly FrontierBlocker[];
} {
  const { start, width, height, blocked, routedCellOccupations, productionDevices } = options;
  const directions = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }] as const;

  // Build a map from grid cell to the device that owns it (for blocker annotation)
  const cellOwner = new Map<string, { readonly deviceId: string; readonly ownerKind: "production" | "logistics" | null }>();
  for (const device of productionDevices) {
    for (let y = device.position.y; y < device.position.y + device.height; y += 1) {
      for (let x = device.position.x; x < device.position.x + device.width; x += 1) {
        const key = `${x},${y}`;
        if (!cellOwner.has(key)) {
          cellOwner.set(key, {
            deviceId: device.id,
            ownerKind: device.kind === "production" ? "production" : "logistics",
          });
        }
      }
    }
  }

  // BFS from start cell
  const visited = new Set<string>();
  const frontier = new Map<string, FrontierBlocker>();
  const queue: Array<{ x: number; y: number }> = [{ x: start.x, y: start.y }];
  let queueCursor = 0;
  const startKey = `${start.x},${start.y}`;

  if (!blocked.has(startKey) && !routedCellOccupations.has(startKey)) {
    visited.add(startKey);
  }

  while (queueCursor < queue.length && visited.size < MAX_REACHABLE_CELLS) {
    const current = queue[queueCursor]!;
    queueCursor += 1;
    for (const delta of directions) {
      const x = current.x + delta.x;
      const y = current.y + delta.y;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const key = `${x},${y}`;
      if (visited.has(key)) continue;
      if (blocked.has(key) || routedCellOccupations.has(key)) {
        // Frontier blocker
        if (frontier.size < MAX_FRONTIER_BLOCKERS && !frontier.has(key)) {
          const routedOwner = routedCellOccupations.get(key);
          const owner = cellOwner.get(key) ?? null;
          frontier.set(key, {
            x,
            y,
            ownerDeviceId: routedOwner?.entityId ?? owner?.deviceId ?? null,
            ownerKind: routedOwner === undefined ? owner?.ownerKind ?? null : "logistics",
          });
        }
        continue;
      }
      visited.add(key);
      queue.push({ x, y });
    }
  }

  // Sort reachable cells: y then x
  const reachableCells: { readonly x: number; readonly y: number }[] = [];
  for (const key of visited) {
    const [xs, ys] = key.split(",");
    reachableCells.push({ x: Number(xs), y: Number(ys) });
  }
  reachableCells.sort((a, b) => a.y - b.y || a.x - b.x);

  // Sort frontier blockers: y then x then owner device ID
  const frontierBlockers = [...frontier.values()];
  frontierBlockers.sort((a, b) =>
    a.y - b.y || a.x - b.x || (a.ownerDeviceId ?? "").localeCompare(b.ownerDeviceId ?? ""));

  return { reachableCells, frontierBlockers };
}

export function optimizeHeadlessLayout(
  request: HeadlessOptimizationRequest,
  registry: RegistryContract,
): HeadlessOptimizationResult {
  validateRequest(request);
  const index = buildProductionPlanningIndex(registry);
  const supplies = (request.supplies ?? []).map((supply, index): ProductionPlanningPort => ({
    id: `supply-${index}`,
    itemId: supply.itemId,
    perMinute: supply.perMinute,
    isInfinite: supply.infinite,
  }));
  const plan = computeProductionPlan({
    targets: request.targets.map((target, targetIndex) => ({
      id: `target-${targetIndex}`,
      itemId: target.itemId,
      perMinute: target.perMinute,
    })),
    supplies,
    infiniteItemIds: new Set(request.infiniteItemIds ?? []),
    recipeChoices: new Map(Object.entries(request.recipeChoices ?? {})),
    sourceConfig: {
      ...DEFAULT_SOURCE_CONFIG,
      ...request.sourceConfig,
    },
  }, index);

  if (plan.unresolvedPerMinute > 0) {
    const unresolved = plan.itemTotals
      .filter((item) => item.unresolvedPerMinute > 0)
      .map((item) => `${item.itemId}=${item.unresolvedPerMinute}/min`)
      .join(", ");
    throw new Error(`Production plan has unresolved inputs: ${unresolved}`);
  }

  const productionRequests = balanceCyclicProductionRequests(
    createDeviceRequests(
      plan.recipeTotals,
      index.entityById,
      index.recipeById,
      request.minimumRecipeDeviceCounts,
      request.allowRecipeOutputWaste,
    ),
    request.targets,
    index.entityById,
    index.recipeById,
  );
  const deviceRequests = createWarehouseLogisticsRequests(
    productionRequests,
    request.targets,
    index.entityById,
    registry,
  );
  const routedLayout = selectRoutedLayout({
    request,
    registry,
    requests: deviceRequests,
    allowRotate: request.allowRotate ?? true,
    routingClearance: request.routingClearance ?? 1,
  });
  const {
    productionEntities,
    routing,
    allDevices,
    bounds,
    physicalBounds,
    contourArea,
    contourVoidArea,
    boundingVoidCellCount,
    enclosedVoidCellCount,
    frontageOverflowCellCount,
    minimumPowerDeviceCount,
    equipmentArea,
    search,
    routeFailureDiagnostics,
  } = routedLayout;
  const entities = { ...productionEntities, ...routing.entities };
  const blueprint = createBlueprintDocument({
    blueprintId: createStableBlueprintId(request, allDevices),
    name: request.name ?? "Headless optimized layout",
    description: "Generated by the IndustrialPlanner headless area optimizer with port-aware belt and pipe routing.",
    baseId: request.baseId ?? "wuling_protocol_core",
    initialGridPoint: { x: 0, y: 0 },
    entities,
    entityOrder: allDevices.map((device) => device.id),
    slotLinks: createWarehouseSlotLinks(deviceRequests),
  });
  const poweredEntityIds = computePoweredEntityIds(blueprint, registry);
  const topology = compileSimulationTopology({
    document: blueprintToWorldDocument(blueprint),
    registry,
    poweredEntityIds,
  });
  const boundingArea = bounds.width * bounds.height;
  const errors = topology.diagnostics.filter((item) => item.severity === "error");
  const logisticsDevices = routing.devices;
  const expectedPhysicalConnections = routing.connections.reduce(
    (sum, connection) => sum
      + Math.max(0, connection.points.length - 1)
      + Number(connection.sourceDeviceId !== null)
      + Number(connection.targetDeviceId !== null),
    0,
  );
  const incomingConnectionCountByEntityId = new Map<string, number>();
  for (const connection of Object.values(topology.physicalConnections)) {
    const targetPort = topology.ports[connection.targetPortId];
    const targetEntityId = targetPort === undefined
      ? null
      : topology.devices[targetPort.deviceId]?.sourceEntityId ?? null;
    if (targetEntityId !== null) {
      incomingConnectionCountByEntityId.set(
        targetEntityId,
        (incomingConnectionCountByEntityId.get(targetEntityId) ?? 0) + 1,
      );
    }
  }
  const requiredInputsPhysicallyConnected = deviceRequests.every((device) =>
    (incomingConnectionCountByEntityId.get(device.id) ?? 0) >= device.inputs.size);
  const connectivityVerified = errors.length === 0
    && Object.keys(topology.physicalConnections).length >= expectedPhysicalConnections
    && requiredInputsPhysicallyConnected;
  const throughputVerified = deviceRequests.every((device) =>
    [...device.inputs].every(([itemId, requiredPerMinute]) =>
      sumConnectionRate(routing.connections, itemId, "targetDeviceId", device.id) + 0.000001 >= requiredPerMinute)
    && [...device.outputs]
      .filter(([itemId]) => request.targets.some((target) => target.itemId === itemId)
        || deviceRequests.some((consumer) => consumer.inputs.has(itemId)))
      .every(([itemId, requiredPerMinute]) =>
      device.allowOutputWaste === true
      || sumConnectionRate(routing.connections, itemId, "sourceDeviceId", device.id) + 0.000001 >= requiredPerMinute));
  const powerCoverageVerified = deviceRequests
    .filter((device) => device.definition.requiresPower)
    .every((device) => poweredEntityIds.has(device.id));
  const validation: HeadlessOptimizationResult["validation"] = {
    topologyId: topology.topologyId,
    deviceCount: topology.ordering.deviceOrder.length - 1,
    errorCount: errors.length,
    warningCount: topology.diagnostics.filter((item) => item.severity === "warning").length,
    diagnostics: topology.diagnostics,
    routedConnectionCount: routing.connections.length,
    internalConnectionCount: routing.internalConnectionCount,
    boundaryConnectionCount: routing.boundaryConnectionCount,
    materialConnections: routing.connections.map((connection) => ({
      itemId: connection.itemId,
      kind: connection.kind,
      perMinute: connection.perMinute,
      sourceDeviceId: connection.sourceDeviceId,
      targetDeviceId: connection.targetDeviceId,
    })),
    productionConnectivityVerified: connectivityVerified,
    productionThroughputVerified: throughputVerified,
    powerCoverageVerified,
    routeFailureDiagnostics,
  };
  const mandatoryAreaDevices = createCertifiedAreaMandatoryDevices({
    entities: deviceRequests.flatMap((device) => device.kind === "warehouse-bus"
      ? []
      : [{
          id: device.id,
          kind: device.kind,
          definitionId: device.definition.id,
        }]),
    entityDefinitions: registry.entityDefinitions,
  });
  const areaProof = solveCpSatAreaLowerBound({
    devices: mandatoryAreaDevices,
    limitWidth: request.width,
    limitHeight: request.height,
    allowRotate: request.allowRotate ?? true,
    maxSeconds: request.certification?.boundingArea?.maxSeconds
      ?? DEFAULT_CERTIFIED_AREA_MAX_SECONDS,
  });
  const effectiveFrontageConstraint = request.frontageConstraint === "hard"
    || (request.search?.initialLayout === "topology-sequential"
      && request.frontageConstraint !== "soft")
    ? "hard"
    : "soft";
  const strictRoutedUpperBoundVerified = isStrictRoutedBoundingAreaUpperBound({
    blueprint,
    registry,
    devices: allDevices,
    routedConnections: routing.connections,
    areaExcludedDeviceIds: routing.areaExcludedDeviceIds,
    limitWidth: request.width,
    limitHeight: request.height,
    boundingArea,
    topologyErrorCount: validation.errorCount,
    productionConnectivityVerified: validation.productionConnectivityVerified,
    productionThroughputVerified: validation.productionThroughputVerified,
    powerCoverageVerified: validation.powerCoverageVerified,
    frontageConstraint: effectiveFrontageConstraint,
    frontageOverflowCellCount,
  });
  const boundingAreaOptimality = createBoundingAreaOptimalityReport({
    mandatoryDeviceAreaLowerBound: measureMandatoryDeviceAreaLowerBound(mandatoryAreaDevices),
    proof: areaProof,
    strictRoutedUpperBoundVerified,
    routedBoundingArea: boundingArea,
  });

  return {
    blueprint,
    layout: {
      limitWidth: request.width,
      limitHeight: request.height,
      usedWidth: bounds.width,
      usedHeight: bounds.height,
      boundingArea,
      physicalUsedWidth: physicalBounds.width,
      physicalUsedHeight: physicalBounds.height,
      physicalBoundingArea: physicalBounds.width * physicalBounds.height,
      contourArea,
      contourVoidArea,
      boundingVoidCellCount,
      enclosedVoidCellCount,
      frontageOverflowCellCount,
      equipmentArea,
      utilization: boundingArea === 0 ? 1 : round(equipmentArea / boundingArea),
      contourUtilization: contourArea === 0
        ? 1
        : round((contourArea - contourVoidArea) / contourArea),
      devices: allDevices,
      productionDeviceCount: allDevices.filter((device) => device.kind === "production").length,
      logisticsDeviceCount: logisticsDevices.length,
      beltCellCount: logisticsDevices.filter((device) => device.kind === "belt").length,
      areaExcludedBeltCellCount: logisticsDevices.filter((device) =>
        device.kind === "belt" && routing.areaExcludedDeviceIds.has(device.id)).length,
      pipeCellCount: logisticsDevices.filter((device) => device.kind === "pipe").length,
      storageDeviceCount: allDevices.filter((device) => device.kind === "storage").length,
      warehousePortCount: allDevices.filter((device) => device.kind === "warehouse-port").length,
      warehouseBusCount: allDevices.filter((device) => device.kind === "warehouse-bus").length,
      powerDeviceCount: allDevices.filter((device) => device.kind === "power").length,
      minimumPowerDeviceCount,
    },
    production: {
      targetCount: request.targets.length,
      recipeCount: plan.recipeTotals.length,
      deviceCount: allDevices.filter((device) => device.kind === "production").length,
      unresolvedPerMinute: plan.unresolvedPerMinute,
    },
    validation,
    optimality: {
      boundingArea: boundingAreaOptimality,
    },
    search,
  };
}

/**
 * Build the exact instance-level material graph before coordinates, rotations,
 * route paths, or layout optimization are introduced.
 */
export function buildHeadlessMaterialGraph(
  request: HeadlessOptimizationRequest,
  registry: RegistryContract,
): HeadlessMaterialGraph {
  validateRequest(request);
  const index = buildProductionPlanningIndex(registry);
  const supplies = (request.supplies ?? []).map((supply, supplyIndex): ProductionPlanningPort => ({
    id: `supply-${supplyIndex}`,
    itemId: supply.itemId,
    perMinute: supply.perMinute,
    isInfinite: supply.infinite,
  }));
  const plan = computeProductionPlan({
    targets: request.targets.map((target, targetIndex) => ({
      id: `target-${targetIndex}`,
      itemId: target.itemId,
      perMinute: target.perMinute,
    })),
    supplies,
    infiniteItemIds: new Set(request.infiniteItemIds ?? []),
    recipeChoices: new Map(Object.entries(request.recipeChoices ?? {})),
    sourceConfig: {
      ...DEFAULT_SOURCE_CONFIG,
      ...request.sourceConfig,
    },
  }, index);
  if (plan.unresolvedPerMinute > 0) {
    const unresolved = plan.itemTotals
      .filter((item) => item.unresolvedPerMinute > 0)
      .map((item) => `${item.itemId}=${item.unresolvedPerMinute}/min`)
      .join(", ");
    throw new Error(`Production plan has unresolved inputs: ${unresolved}`);
  }
  const productionRequests = balanceCyclicProductionRequests(
    createDeviceRequests(
      plan.recipeTotals,
      index.entityById,
      index.recipeById,
      request.minimumRecipeDeviceCounts,
      request.allowRecipeOutputWaste,
    ),
    request.targets,
    index.entityById,
    index.recipeById,
  );
  const materialRequests = createWarehouseLogisticsRequests(
    productionRequests,
    request.targets,
    index.entityById,
    registry,
  ).filter((deviceRequest) => deviceRequest.kind !== "warehouse-bus");
  const edges = createCpSatFlowEdges(materialRequests, registry)
    .map((edge) => ({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      itemId: edge.itemId,
      laneCount: edge.laneCount,
    }))
    .sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId)
      || left.targetId.localeCompare(right.targetId)
      || left.itemId.localeCompare(right.itemId));
  const topologyComponents = buildTopologyComponents(
    materialRequests.map((deviceRequest) => deviceRequest.id),
    edges,
  );
  const componentByDeviceId = new Map<string, {
    readonly id: string;
    readonly layer: number;
  }>();
  const components = topologyComponents.map((component, componentIndex) => {
    const id = `C${componentIndex + 1}`;
    component.deviceIds.forEach((deviceId) =>
      componentByDeviceId.set(deviceId, { id, layer: component.layer }));
    return {
      id,
      layer: component.layer,
      deviceIds: component.deviceIds,
      cyclic: component.deviceIds.length > 1
        || edges.some((edge) =>
          edge.sourceId === component.deviceIds[0]
          && edge.targetId === component.deviceIds[0]),
    };
  });
  const nodes = materialRequests.map((deviceRequest) => {
    const component = componentByDeviceId.get(deviceRequest.id);
    if (component === undefined) {
      throw new Error(`Material graph component missing device ${deviceRequest.id}`);
    }
    return {
      id: deviceRequest.id,
      kind: deviceRequest.kind as "production" | "storage" | "warehouse-port",
      definitionId: deviceRequest.definition.id,
      definitionNameKey: deviceRequest.definition.nameKey,
      recipeId: deviceRequest.recipeId,
      componentId: component.id,
      layer: component.layer,
      inputItemIds: [...deviceRequest.inputs.keys()].sort(),
      outputItemIds: [...deviceRequest.outputs.keys()].sort(),
    };
  }).sort((left, right) =>
    left.layer - right.layer || left.id.localeCompare(right.id));
  return {
    name: request.name ?? "Headless material graph",
    nodes,
    edges,
    components,
  };
}

function createDeviceRequests(
  recipeTotals: readonly ProductionPlanningRecipeTotal[],
  entityById: ReadonlyMap<string, EntityDefinition>,
  recipeById: ReadonlyMap<string, RecipeDefinition>,
  minimumRecipeDeviceCounts: HeadlessOptimizationRequest["minimumRecipeDeviceCounts"],
  allowRecipeOutputWaste: HeadlessOptimizationRequest["allowRecipeOutputWaste"],
): DeviceRequest[] {
  const result: DeviceRequest[] = [];
  for (const [recipeIndex, total] of recipeTotals.entries()) {
    const recipe = recipeById.get(total.recipeId);
    if (recipe === undefined) {
      throw new Error(`Recipe is not available to the headless planner: ${total.recipeId}`);
    }
    const definition = entityById.get(recipe.machineId);
    if (definition === undefined) {
      throw new Error(`Recipe ${recipe.id} references missing machine ${recipe.machineId}`);
    }
    // Natural-resource planner nodes use non-placeable, port-less pseudo machines.
    // Their products become boundary supplies for the routed factory.
    if (definition.portGroups.length === 0) {
      continue;
    }
    const channel = definition.recipeChannels[0];
    const exactDeviceLoad = total.cyclesPerMinute / (60 / total.durationSeconds);
    const allowOutputWaste = allowRecipeOutputWaste?.includes(recipe.id) === true;
    const loadFractions = resolveRecipeDeviceLoadFractions(
      exactDeviceLoad,
      minimumRecipeDeviceCounts?.[recipe.id],
      allowOutputWaste,
    );
    const count = loadFractions.length;
    const allocatedLoad = loadFractions.reduce((sum, load) => sum + load, 0);
    for (let unitIndex = 0; unitIndex < count; unitIndex += 1) {
      const loadFraction = loadFractions[unitIndex] ?? 0;
      const flowScale = allocatedLoad <= 0
        ? 0
        : loadFraction / allocatedLoad;
      result.push({
        id: `opt-${recipeIndex + 1}-${unitIndex + 1}`,
        recipeId: recipe.id,
        kind: "production",
        definition,
        inputs: allowOutputWaste
          ? new Map(recipe.inputs.map((input) => [
              input.itemId,
              input.amount * 60 / recipe.durationSeconds,
            ]))
          : new Map(total.inputs.map((input) => [input.itemId, input.perMinute * flowScale])),
        outputs: allowOutputWaste
          ? new Map(recipe.outputs.map((output) => [
              output.itemId,
              output.amount * 60 / recipe.durationSeconds,
            ]))
          : new Map(total.outputs.map((output) => [output.itemId, output.perMinute * flowScale])),
        allowOutputWaste,
        config: channel === undefined
          ? { ...(cloneRecord(definition.placementDefaults?.config) ?? {}) }
          : {
              ...(cloneRecord(definition.placementDefaults?.config) ?? {}),
              channelRecipes: { [channel.id]: recipe.id },
            },
      });
    }
  }
  return result;
}

/**
 * Assign full recipe load to every whole machine and only the unavoidable
 * remainder to the final machine. Equal division turns a fractional machine
 * count such as 1.67 into two partial producers, which can split one consumer
 * across both devices and consume an otherwise unnecessary pair of ports.
 */
export function resolveRecipeDeviceLoadFractions(
  deviceCount: number,
  minimumDeviceCount = 0,
  forceFullSpeed = false,
): readonly number[] {
  if (!Number.isFinite(deviceCount) || deviceCount <= 0) return [];
  const naturalCount = Math.ceil(deviceCount - 0.000001);
  const count = Math.max(naturalCount, minimumDeviceCount);
  if (forceFullSpeed) return Array.from({ length: count }, () => 1);
  if (count > naturalCount) {
    return Array.from({ length: count }, () => deviceCount / count);
  }
  return Array.from({ length: count }, (_, index) =>
    Math.min(1, Math.max(0, deviceCount - index)));
}

function balanceCyclicProductionRequests(
  requests: readonly DeviceRequest[],
  targets: HeadlessOptimizationRequest["targets"],
  entityById: ReadonlyMap<string, EntityDefinition>,
  recipeById: ReadonlyMap<string, RecipeDefinition>,
): DeviceRequest[] {
  const productionRecipeIds = [...new Set(requests.flatMap((request) =>
    request.kind === "production" && request.recipeId !== null ? [request.recipeId] : []))]
    .sort();
  const recipes = productionRecipeIds.flatMap((recipeId) => {
    const recipe = recipeById.get(recipeId);
    return recipe === undefined ? [] : [recipe];
  });
  const recipeEdges = recipes.flatMap((producer) =>
    recipes.flatMap((consumer) =>
      producer.outputs.some((output) =>
        consumer.inputs.some((input) => input.itemId === output.itemId))
        ? [{ sourceId: producer.id, targetId: consumer.id }]
        : []));
  const cyclicComponents = buildTopologyComponents(productionRecipeIds, recipeEdges)
    .filter((component) =>
      component.deviceIds.length > 1
      || recipeEdges.some((edge) =>
        edge.sourceId === component.deviceIds[0] && edge.targetId === component.deviceIds[0]));
  if (cyclicComponents.length === 0) return [...requests];

  let result = [...requests];
  for (const [componentIndex, component] of cyclicComponents.entries()) {
    const componentRecipeIds = new Set(component.deviceIds);
    const componentRecipes = component.deviceIds.map((recipeId) => {
      const recipe = recipeById.get(recipeId);
      if (recipe === undefined) {
        throw new Error(`Cyclic production recipe is unavailable: ${recipeId}`);
      }
      return recipe;
    });
    const producedItemIds = new Set(componentRecipes.flatMap((recipe) =>
      recipe.outputs.map((output) => output.itemId)));
    const externalDemandByItem = new Map<string, number>();
    for (const request of result) {
      if (request.recipeId !== null && componentRecipeIds.has(request.recipeId)) continue;
      for (const [itemId, perMinute] of request.inputs) {
        if (!producedItemIds.has(itemId)) continue;
        externalDemandByItem.set(
          itemId,
          (externalDemandByItem.get(itemId) ?? 0) + perMinute,
        );
      }
    }
    for (const target of targets) {
      if (!producedItemIds.has(target.itemId)) continue;
      externalDemandByItem.set(
        target.itemId,
        (externalDemandByItem.get(target.itemId) ?? 0) + target.perMinute,
      );
    }

    const balanceItemIds = [...producedItemIds].sort();
    const netRates = componentRecipes.map((recipe) =>
      balanceItemIds.map((itemId) =>
        recipeRatePerMinute(recipe, "output", itemId)
          - recipeRatePerMinute(recipe, "input", itemId)));
    const selectedCounts = solveCyclicRecipeCounts(
      netRates,
      balanceItemIds.map((itemId) => externalDemandByItem.get(itemId) ?? 0),
    );
    if (selectedCounts === null) {
      throw new Error(
        `Unable to balance cyclic production component: ${component.deviceIds.join(", ")}`,
      );
    }

    result = result.filter((request) =>
      request.recipeId === null || !componentRecipeIds.has(request.recipeId));
    componentRecipes.forEach((recipe, recipeIndex) => {
      const definition = entityById.get(recipe.machineId);
      if (definition === undefined) {
        throw new Error(`Recipe ${recipe.id} references missing machine ${recipe.machineId}`);
      }
      for (let unitIndex = 0; unitIndex < selectedCounts![recipeIndex]!; unitIndex += 1) {
        result.push(createFullSpeedRecipeRequest(
          `cycle-${componentIndex + 1}-${recipeIndex + 1}-${unitIndex + 1}`,
          recipe,
          definition,
        ));
      }
    });
  }
  return result;
}

/**
 * Find the smallest positive integer recipe-count vector that satisfies every
 * material balance row of a cyclic recipe component. Rows are arbitrary
 * materials and columns are arbitrary recipes; no item or recipe identity is
 * available to this solver.
 */
export function solveCyclicRecipeCounts(
  netRatesByRecipe: readonly (readonly number[])[],
  externalDemandByItem: readonly number[],
  maximumTotalCount = 128,
): readonly number[] | null {
  if (netRatesByRecipe.length === 0 || externalDemandByItem.length === 0) return null;
  if (netRatesByRecipe.some((rates) => rates.length !== externalDemandByItem.length)) {
    throw new Error("Cyclic recipe balance matrix has inconsistent dimensions");
  }
  const minimumCounts = netRatesByRecipe.map(() => 1);
  const minimumTotalCount = minimumCounts.length;
  for (let totalCount = minimumTotalCount; totalCount <= maximumTotalCount; totalCount += 1) {
    const counts = [...minimumCounts];
    let selectedCounts: number[] | null = null;
    let selectedSurplus = Number.POSITIVE_INFINITY;
    const assign = (recipeIndex: number, remaining: number): void => {
      if (recipeIndex === netRatesByRecipe.length - 1) {
        counts[recipeIndex] = minimumCounts[recipeIndex]! + remaining;
        let surplus = 0;
        for (const [itemIndex, demand] of externalDemandByItem.entries()) {
          const balance = counts.reduce((sum, count, index) =>
            sum + count * netRatesByRecipe[index]![itemIndex]!, 0);
          if (balance + 0.000001 < demand) return;
          surplus += balance - demand;
        }
        const signature = counts.join(",");
        const selectedSignature = selectedCounts?.join(",") ?? "";
        if (
          surplus < selectedSurplus - 0.000001
          || (
            Math.abs(surplus - selectedSurplus) <= 0.000001
            && (selectedCounts === null || signature.localeCompare(selectedSignature) < 0)
          )
        ) {
          selectedCounts = [...counts];
          selectedSurplus = surplus;
        }
        return;
      }
      for (let extra = 0; extra <= remaining; extra += 1) {
        counts[recipeIndex] = minimumCounts[recipeIndex]! + extra;
        const nextRemaining = remaining - extra;
        const canStillMeetDemand = externalDemandByItem.every((demand, itemIndex) => {
          const fixedBalance = counts.slice(0, recipeIndex + 1).reduce((sum, count, index) =>
            sum + count * netRatesByRecipe[index]![itemIndex]!, 0);
          const minimumRemainingBalance = minimumCounts
            .slice(recipeIndex + 1)
            .reduce((sum, count, offset) =>
              sum + count * netRatesByRecipe[recipeIndex + 1 + offset]![itemIndex]!, 0);
          const maximumRemainingRate = Math.max(
            0,
            ...netRatesByRecipe.slice(recipeIndex + 1)
              .map((rates) => rates[itemIndex]!),
          );
          return fixedBalance
            + minimumRemainingBalance
            + nextRemaining * maximumRemainingRate
            + 0.000001
            >= demand;
        });
        if (canStillMeetDemand) assign(recipeIndex + 1, nextRemaining);
      }
    };
    assign(0, totalCount - minimumTotalCount);
    if (selectedCounts !== null) return selectedCounts;
  }
  return null;
}

function createFullSpeedRecipeRequest(
  id: string,
  recipe: RecipeDefinition,
  definition: EntityDefinition,
): DeviceRequest {
  const channel = definition.recipeChannels[0];
  return {
    id,
    recipeId: recipe.id,
    kind: "production",
    definition,
    inputs: new Map(recipe.inputs.map((input) => [
      input.itemId,
      input.amount * 60 / recipe.durationSeconds,
    ])),
    outputs: new Map(recipe.outputs.map((output) => [
      output.itemId,
      output.amount * 60 / recipe.durationSeconds,
    ])),
    config: channel === undefined
      ? { ...(cloneRecord(definition.placementDefaults?.config) ?? {}) }
      : {
          ...(cloneRecord(definition.placementDefaults?.config) ?? {}),
          channelRecipes: { [channel.id]: recipe.id },
        },
  };
}

function recipeRatePerMinute(
  recipe: RecipeDefinition,
  direction: "input" | "output",
  itemId: string,
): number {
  const items = direction === "input" ? recipe.inputs : recipe.outputs;
  return (items.find((item) => item.itemId === itemId)?.amount ?? 0) * 60 / recipe.durationSeconds;
}

function createWarehouseLogisticsRequests(
  productionRequests: readonly DeviceRequest[],
  targets: HeadlessOptimizationRequest["targets"],
  entityById: ReadonlyMap<string, EntityDefinition>,
  registry: RegistryContract,
): DeviceRequest[] {
  const result = [...productionRequests];
  const remainingByItem = new Map<string, Array<{ request: DeviceRequest; remaining: number }>>();
  for (const producer of productionRequests) {
    for (const [itemId, perMinute] of producer.outputs) {
      const entries = remainingByItem.get(itemId) ?? [];
      entries.push({ request: producer, remaining: perMinute });
      remainingByItem.set(itemId, entries);
    }
  }
  const unloaderDefinition = requireEntityDefinition(entityById, "item_port_unloader_1");
  let unloaderIndex = 0;
  for (const consumer of productionRequests) {
    for (const [itemId, requiredPerMinute] of consumer.inputs) {
      let deficit = requiredPerMinute;
      for (const producer of remainingByItem.get(itemId) ?? []) {
        const transferred = Math.min(deficit, producer.remaining);
        deficit -= transferred;
        producer.remaining -= transferred;
        if (deficit <= 0.000001) break;
      }
      if (deficit <= 0.000001) continue;
      if (registry.queries.resolveItemDomain(itemId) !== "solid") continue;
      const laneCapacity = resolveLogisticsLaneCapacityPerMinute(itemId, registry);
      while (deficit > 0.000001) {
        const laneRate = Math.min(deficit, laneCapacity);
        unloaderIndex += 1;
        result.push({
          id: `warehouse-unloader-${unloaderIndex}`,
          recipeId: null,
          kind: "warehouse-port",
          warehouseItemId: itemId,
          warehouseConsumerId: consumer.id,
          definition: unloaderDefinition,
          config: {
            "storageSlotGroups[0].slots[0].ignoreStock": true,
            "storageSlotGroups[0].slots[0].initialItemType": itemId,
          },
          inputs: new Map(),
          outputs: new Map([[itemId, laneRate]]),
        });
        deficit -= laneRate;
      }
    }
  }
  const storageDefinition = requireEntityDefinition(entityById, "item_port_storager_1");
  const targetStorageRequests: DeviceRequest[] = [];
  let targetStorageIndex = 0;
  targets.forEach((target) => {
    if (registry.queries.resolveItemDomain(target.itemId) !== "solid") return;
    const producers = productionRequests.filter((request) =>
      (request.outputs.get(target.itemId) ?? 0) > 0.000001);
    const availablePerMinute = producers.reduce(
      (sum, producer) => sum + (producer.outputs.get(target.itemId) ?? 0),
      0,
    );
    const perMinute = Math.min(target.perMinute, availablePerMinute);
    if (perMinute <= 0.000001) return;
    targetStorageIndex += 1;
    targetStorageRequests.push({
      id: `warehouse-storage-${targetStorageIndex}`,
      recipeId: null,
      kind: "storage",
      warehouseItemId: target.itemId,
      warehouseProducerIds: producers.map((producer) => producer.id),
      definition: storageDefinition,
      config: { "storageSlotGroups[0].slots[0].lock": target.itemId },
      inputs: new Map([[target.itemId, perMinute]]),
      outputs: new Map(),
    });
  });
  result.push(...targetStorageRequests);
  const portCount = result.filter((request) => request.kind === "warehouse-port").length;
  const busSegmentCount = Math.ceil(portCount / 2);
  const busSource = requireEntityDefinition(entityById, "item_port_log_hongs_bus_source");
  const busSegment = requireEntityDefinition(entityById, "item_port_log_hongs_bus");
  result.push({
    id: "warehouse-bus-source",
    recipeId: null,
    kind: "warehouse-bus",
    definition: busSource,
    config: { warehouseBusSeed: true },
    inputs: new Map(),
    outputs: new Map(),
  });
  for (let index = 0; index < busSegmentCount; index += 1) {
    result.push({
      id: `warehouse-bus-${index + 1}`,
      recipeId: null,
      kind: "warehouse-bus",
      definition: busSegment,
      config: {},
      inputs: new Map(),
      outputs: new Map(),
    });
  }
  return result;
}

function requireEntityDefinition(
  entityById: ReadonlyMap<string, EntityDefinition>,
  definitionId: string,
): EntityDefinition {
  const definition = entityById.get(definitionId);
  if (definition === undefined) throw new Error(`Missing logistics definition ${definitionId}`);
  return definition;
}

function createWarehouseSlotLinks(requests: readonly DeviceRequest[]): SlotLinkDefinition[] {
  return requests
    .filter((request) => request.definition.id === "item_port_unloader_1" && request.warehouseItemId !== undefined)
    .map((request) => ({
      id: `warehouse-link:${request.id}:unloader_buffer:slot_1`,
      linkType: "share-all",
      source: { entityId: request.id, storageSlotGroupId: "unloader_buffer", slotId: "slot_1" },
      target: { entityId: "warehouse", storageSlotGroupId: "warehouse", slotId: request.warehouseItemId! },
    }));
}

function selectRoutedLayout(options: {
  readonly request: HeadlessOptimizationRequest;
  readonly registry: RegistryContract;
  readonly requests: readonly DeviceRequest[];
  readonly allowRotate: boolean;
  readonly routingClearance: number;
}): RoutedLayoutSelection {
  const requestedIterations = options.request.search?.iterations ?? 16;
  const routingVariants = options.request.search?.routingVariants ?? 3;
  const refinementCandidateLimit = options.request.search?.refinementCandidates ?? 12;
  const initialLayout = options.request.search?.initialLayout ?? "auto";
  const optimizationScope = options.request.search?.scope ?? "global";
  const globalNeighborhoods = options.request.search?.globalNeighborhoods ?? "all";
  const topologySequentialOnly = initialLayout === "topology-sequential";
  const localOnly = optimizationScope === "local";
  const localNeighborhoodOnly = localOnly || globalNeighborhoods === "layer-interlock";
  const hardFrontageRequired = options.request.frontageConstraint === "hard"
    || (topologySequentialOnly && options.request.frontageConstraint !== "soft");
  const seed = normalizeSearchSeed(
    options.request.search?.seed ?? hashString(JSON.stringify({
      ...options.request,
      certification: undefined,
    })),
  );
  // Build the graph-derived warehouse neighborhood before the broad heuristic
  // pool. This candidate is deterministic and cheap, and should not inherit the
  // latency of unrelated global packing enumeration.
  const legacyWarehouseSupplyCluster = createWarehouseSupplyClusterPacking({
    requests: options.requests,
    registry: options.registry,
    limitWidth: options.request.width,
    limitHeight: options.request.height,
    allowRotate: options.allowRotate,
  });
  const topologySequentialCandidates = topologySequentialOnly
    ? createTopologySequentialWarehousePackings({
        request: options.request,
        requests: options.requests,
        registry: options.registry,
        limitWidth: options.request.width,
        limitHeight: options.request.height,
        allowRotate: options.allowRotate,
        routingClearance: options.routingClearance,
      })
    : [];
  const warehouseSupplyCluster = topologySequentialOnly
    ? topologySequentialCandidates[0] ?? null
    : legacyWarehouseSupplyCluster;
  const warehouseSupplyCandidateFamilies = topologySequentialOnly
    ? [topologySequentialCandidates.slice(1)]
    : warehouseSupplyCluster === null
      ? []
    : [
        createIndependentFanoutInsertionNeighbors({
          packing: warehouseSupplyCluster,
          requests: options.requests,
          registry: options.registry,
          limitWidth: options.request.width,
          limitHeight: options.request.height,
          allowRotate: options.allowRotate,
        }),
        createFrontageFanoutSwapNeighbors({
          packing: warehouseSupplyCluster,
          requests: options.requests,
          registry: options.registry,
          limitWidth: options.request.width,
          limitHeight: options.request.height,
          allowRotate: options.allowRotate,
        }),
        createFrontageConstrainedWarehouseNeighbors({
          packing: warehouseSupplyCluster,
          requests: options.requests,
          registry: options.registry,
          limitWidth: options.request.width,
          limitHeight: options.request.height,
          allowRotate: options.allowRotate,
        }),
      ];
  const warehouseCandidatesGenerated = warehouseSupplyCluster === null
    ? 0
    : 1 + warehouseSupplyCandidateFamilies.reduce((sum, family) => sum + family.length, 0);
  const cpSat = options.request.search?.cpSat;
  const clusterOnlySearch = warehouseSupplyCluster !== null
    && (
      topologySequentialOnly
      || (requestedIterations <= 0 && cpSat?.enabled !== true)
    );
  // Storage belongs to the local equipment packing from the first heuristic
  // candidate onward. Attaching it after packing made the unloader anchor too
  // shallow and left no vertical frontage slot for a compact terminal.
  const locallyPlaceableRequests = options.requests.filter((request) =>
    request.kind === "production" || request.kind === "storage");
  const heuristicPackingCandidateSet = clusterOnlySearch
    ? { packings: [], cpSatCandidateCount: 0, cpSatStatus: "disabled" as CpSatStatus }
    : createPackingCandidates(
        locallyPlaceableRequests,
        options.registry,
        options.request.width,
        options.request.height,
        options.allowRotate,
        options.routingClearance,
        requestedIterations,
        seed,
        undefined,
      );
  const packingCandidates = new Map(
    heuristicPackingCandidateSet.packings.map((packing) => [packingSignature(packing), packing]),
  );
  let cpSatCandidateCount = 0;
  let cpSatStatus: CpSatStatus = "disabled";
  let cpSatPythonVersion: string | undefined;
  let cpSatOrToolsVersion: string | undefined;
  let cpSatBudgetSeconds: number | undefined;
  let cpSatAttemptedCandidates: number | undefined;
  let cpSatStoppedBy: CpSatStopReason | undefined;
  let cpSatElapsedMs: number | undefined;
  if (cpSat?.enabled === true && !localNeighborhoodOnly && !topologySequentialOnly) {
    // Target protocol storage participates in the same global placement model as
    // its producers. Previously it was attached after CP-SAT and therefore could
    // never move together with a high-fanout producer.
    const jointlyPlacedRequests = options.requests.filter((request) =>
      request.kind === "production" || request.kind === "storage");
    const cpSatResult = createCpSatPackingCandidates({
      requests: jointlyPlacedRequests,
      registry: options.registry,
      limitWidth: options.request.width,
      limitHeight: options.request.height,
      allowRotate: options.allowRotate,
      routingClearance: options.routingClearance,
      maxSeconds: cpSat.maxSeconds ?? 2,
      candidateCount: cpSat.candidates ?? 4,
      seed,
    });
    cpSatStatus = cpSatResult.status;
    cpSatPythonVersion = cpSatResult.pythonVersion;
    cpSatOrToolsVersion = cpSatResult.orToolsVersion;
    cpSatBudgetSeconds = cpSatResult.budgetSeconds;
    cpSatAttemptedCandidates = cpSatResult.attemptedCandidates;
    cpSatStoppedBy = cpSatResult.stoppedBy;
    cpSatElapsedMs = cpSatResult.elapsedMs;
    for (const packing of cpSatResult.packings) {
      const signature = packingSignature(packing);
      if (packingCandidates.has(signature)) continue;
      packingCandidates.set(signature, packing);
      cpSatCandidateCount += 1;
    }
  }
  const packingCandidateSet: PackingCandidateSet = {
    packings: [...packingCandidates.values()].sort(comparePacking),
    cpSatCandidateCount,
    cpSatStatus: cpSatStatus !== "disabled"
      ? cpSatStatus
      : heuristicPackingCandidateSet.cpSatStatus,
    cpSatPythonVersion,
    cpSatOrToolsVersion,
    cpSatBudgetSeconds: cpSatBudgetSeconds ?? heuristicPackingCandidateSet.cpSatBudgetSeconds,
    cpSatAttemptedCandidates: cpSatAttemptedCandidates
      ?? heuristicPackingCandidateSet.cpSatAttemptedCandidates,
    cpSatStoppedBy: cpSatStoppedBy ?? heuristicPackingCandidateSet.cpSatStoppedBy,
    cpSatElapsedMs: cpSatElapsedMs ?? heuristicPackingCandidateSet.cpSatElapsedMs,
  };
  const generalCandidates = packingCandidateSet.packings.map((packing) => attachWarehouseLogistics(
    packing,
    options.requests,
    options.registry,
    options.request.width,
    options.request.height,
    options.routingClearance,
  ))
    .filter((packing): packing is PackingResult => packing !== null)
    .sort(comparePacking);
  const cpSatInitialCandidates = generalCandidates.filter((packing) =>
    packing.debugLabel?.startsWith("cp-sat:") === true);
  const heuristicInitialCandidates = generalCandidates.filter((packing) =>
    packing.debugLabel?.startsWith("cp-sat:") !== true);
  const initialBaseline = warehouseSupplyCluster ?? generalCandidates[0] ?? null;
  // Full multi-connection routing dominates layout latency. Keep the
  // deterministic baseline first, then sample every cheap candidate family in
  // round-robin order so no warehouse, CP-SAT, or heuristic family can consume
  // the entire expensive A* budget.
  const candidates = initialBaseline === null
    ? []
    : selectInitialPackingCandidateBeam(
        initialBaseline,
        [
          ...warehouseSupplyCandidateFamilies,
          cpSatInitialCandidates,
          heuristicInitialCandidates,
        ],
        refinementCandidateLimit,
      );
  const initialCandidatesGenerated = warehouseCandidatesGenerated + generalCandidates.length;
  const initialCandidatesSelected = candidates.length;
  const warehouseCandidatesSelected = candidates.filter((packing) =>
    packing.debugLabel?.startsWith("warehouse-supply-cluster:") === true).length;
  let best: RoutedLayoutCandidate | null = null;
  // Keep a bounded set of fully routed feasible states instead of discarding
  // every non-winning basin. The first refinement round still starts from the
  // current winner; later rounds can spend the same routing budget across
  // geometrically different elite states.
  const feasibleEliteArchive = new Map<string, RoutedLayoutCandidate>();
  // A hard frontage bound can reject every initial packing. Keep a diverse
  // pool of routed misses so LNS can preserve temporary enabler moves instead
  // of requiring every intermediate state to improve the final objective.
  const frontageRepairPool = new Map<string, RoutedLayoutCandidate>();
  let routingError: Error | null = null;
  let routingErrorProgress = -1;
  let bestRouteFailure: { readonly progress: number; readonly evidence: RouteFailureEvidence } | null = null;
  const certifiedRouteFailureCuts = new Map<string, readonly CpSatLayoutPlacement[]>();
  const certifiedRouteCapacityCuts = new Map<string, CpSatLayoutCapacityCut>();
  const frontagePackingFailures = new Map<string, {
    readonly packing: PackingResult;
    readonly progress: number;
    readonly evidence: RouteFailureEvidence;
  }>();
  let routedCandidates = 0;
  let powerInfeasibleCandidates = 0;
  let evaluatedPackings = 0;
  let clusterCandidatesGenerated = 0;
  let clusterCandidatesCheapRejected = 0;
  let clusterCandidatesRouted = 0;
  let clusterCandidatesAStarRejected = 0;
  let clusterCandidatesImproved = 0;
  let localAreaLowerBoundRejected = 0;
  let localRepairAttempts = 0;
  let localFullRerouteAttempts = 0;
  let localFullRipFailureStatesReused = 0;
  let localRoutingVariantsSkippedAfterSuccess = 0;
  let routingVariantAttempts = 0;
  let relaxedConnectivityRejectedPortPairs = 0;
  let seededInitialCandidatesRanked = 0;
  let seededInitialCandidatesPolished = 0;
  let seededInitialColdVariantsSkipped = 0;
  let adaptiveCandidatesEvaluated = 0;
  let adaptiveRoutingAttempts = 0;
  let effectiveRoutingVariants = routingVariants;
  let alternativeRefinementBasesUsed = 0;
  let globalRebuildCandidatesGenerated = 0;
  let globalRebuildCandidatesRouted = 0;
  let globalRebuildCandidatesImproved = 0;
  let partialRebuildCandidatesGenerated = 0;
  let partialRebuildCandidatesRouted = 0;
  let partialRebuildCandidatesImproved = 0;
  let globalRebuildCpSatElapsedMs = 0;
  let globalLayerInterlockCandidatesGenerated = 0;
  let globalLayerInterlockWidthRejected = 0;
  let globalLayerInterlockCandidatesRouted = 0;
  let globalLayerInterlockCandidatesImproved = 0;
  let globalLayerInterlockPasses = 0;
  let globalLayerInterlockTransitions = 0;
  let globalLayerInterlockStoppedBy: "disabled" | "fixed-point" | "width-infeasible" | "safety-bound"
    = "disabled";
  let localConvergencePasses = 0;
  let localConvergenceTransitions = 0;
  let localConvergenceStoppedBy: "disabled" | "fixed-point" | "safety-bound"
    = "disabled";
  const objectiveHotspotDeviceIds = new Set<string>();
  const seenPackings = new Set(candidates.map(packingSignature));
  const evaluatedPackingSignatures = new Set<string>();
  const attemptedRoutingVariants = new Map<string, Set<number>>();
  // Once preservation has ripped every old connection, its routing state is
  // identical to a cold reroute for the same equipment geometry, route-order
  // variant, and promoted-priority order. Retain those deterministic failures
  // across path-fold/cold evaluations so a convergence pass never proves the
  // same impossible state twice.
  const localFullRipFailuresByGeometryVariant = new Map<
    string,
    Map<string, unknown>
  >();
  const packingRoutingFailures = new Map<string, {
    readonly packing: PackingResult;
    readonly progress: number;
  }>();
  const evaluatePacking = (
    packing: PackingResult,
    localRoutingBase?: RoutedLayoutCandidate,
    routingVariantLimit = routingVariants,
    adaptiveRouting = false,
    deferRoutingSeedPolish = false,
  ): void => {
    // Warehouse ports are not free-standing anchors. A layout that separates
    // them from the connected warehouse bus is invalid in the editor even when
    // every production belt can be routed, so reject it before spending A* work.
    if (!hasValidWarehouseHubAdjacency(packing.devices, options.requests)) return;
    const signature = packing.evaluationKey ?? packingSignature(packing);
    const isGlobalRebuildCandidate = packing.debugLabel?.startsWith("global-rebuild:") === true;
    const isPartialRebuildCandidate = packing.debugLabel?.startsWith(
      "global-rebuild:partial:",
    ) === true;
    const isLocalTerminalCluster = packing.debugLabel?.startsWith(
      "local-terminal-cluster:",
    ) === true;
    const isGlobalLayerInterlock = packing.debugLabel?.startsWith(
      "global-layer-interlock:",
    ) === true;
    const isTerminalClusterMovement = isLocalTerminalCluster || isGlobalLayerInterlock;
    const isStraightLineCollapse = packing.debugLabel?.startsWith(
      "local-terminal-cluster:straight-row-collapse:",
    ) === true
      || packing.debugLabel?.startsWith(
        "local-terminal-cluster:straight-column-collapse:",
      ) === true;
    const isLocalSccInternal = packing.debugLabel?.startsWith(
      "local-scc-internal:",
    ) === true;
    const isLocalRoutedSccCore = packing.debugLabel?.startsWith(
      "local-scc-routed-core:",
    ) === true;
    const isLocalSccInternalBranch = isLocalSccInternal
      && packing.debugLabel?.split(":")[4] === "branch";
    const isLocalSccCluster = packing.debugLabel?.startsWith(
      "local-scc-cluster:",
    ) === true
      || isLocalSccInternal
      || isLocalRoutedSccCore;
    const isLocalAreaCompaction = isStraightLineCollapse
      || packing.debugLabel?.startsWith(
        "local-terminal-cluster:speculative-cut:",
      ) === true
      || packing.debugLabel?.startsWith(
        "local-terminal-cluster:path-fold-cut:",
      ) === true
      || packing.debugLabel?.startsWith(
        "local-terminal-cluster:upstream-row:",
      ) === true;
    const isClusterCandidate = packing.debugLabel?.startsWith("cluster-repair:") === true
      || packing.debugLabel?.startsWith("cluster-translate:") === true
      || isTerminalClusterMovement
      || isLocalSccCluster
      || packing.debugLabel?.startsWith("boundary-backtrack:") === true
      || packing.debugLabel?.startsWith("joint-storage-fanout:") === true
      || packing.debugLabel?.startsWith("slot-ejection:") === true
      || isGlobalRebuildCandidate
      || packing.debugLabel?.startsWith("warehouse-supply-cluster:") === true;
    const isWarehouseSupplyCluster = packing.debugLabel?.startsWith("warehouse-supply-cluster:") === true;
    const isLocalRefinementCandidate = localRoutingBase !== undefined;
    const incumbent = best as RoutedLayoutCandidate | null;
    if (isLocalAreaCompaction
      && incumbent !== null
      && measureDeviceBoundingAreaLowerBound(packing.devices)
        > incumbent.bounds.width * incumbent.bounds.height) {
      // Logistics and power can only enlarge the production-device rectangle.
      // Therefore this fixed compaction geometry cannot beat the incumbent
      // bounding area, regardless of port allocation or A* route order.
      localAreaLowerBoundRejected += 1;
      clusterCandidatesCheapRejected += 1;
      return;
    }
    const translationOffsets = packing.debugLabel?.match(/^cluster-translate:[^:]+:down:(\d+):(\d+)$/);
    const isSmallTranslation = translationOffsets !== null
      && Number(translationOffsets?.[1]) <= 4
      && Number(translationOffsets?.[2]) <= 4;
    let packingRouted = false;
    let packingImproved = false;
    let packingRoutingProgress = -1;
    let packingRoutingMessage = "";
    const productionEntities = createEntities(options.requests, packing.devices);
    const movedDeviceIds = localRoutingBase === undefined
      ? new Set<string>()
      : findMovedDeviceIds(localRoutingBase.packing.devices, packing.devices);
    if (isWarehouseSupplyCluster && process.env["INDUSTRIAL_PLANNER_TRACE_WAREHOUSE_CLUSTER"] === "1") {
      console.error(`[warehouse-supply-packing] ${packing.debugLabel ?? "unnamed"}`);
    }
    // Cluster repair already passed a graph-distance and exact-port funnel.
    // Re-run the fan-out/fan-in group with three deterministic port orders; each
    // run starts from empty logistics, acting as bounded rip-up/reroute.
    const isFrontageCandidate = packing.debugLabel?.startsWith(
      "warehouse-supply-cluster:frontage:",
    ) === true
      || packing.debugLabel?.startsWith("warehouse-supply-cluster:topology-sequential:") === true
      || packing.debugLabel?.startsWith("route-failure-") === true;
    const candidateRoutingVariantIndexes = isGlobalRebuildCandidate
      ? Array.from({ length: routingVariantLimit }, (_, index) => index)
      : isLocalSccCluster
      // SCC-local repair needs the fan-out-first and direct-connection-first
      // families before ordinary spatial orders. This depends only on routed
      // graph structure; it is not tied to a recipe or device identifier.
      ? [32, 31, 30, 29, 28, 13, 12].slice(0, Math.max(1, routingVariantLimit))
      : isTerminalClusterMovement
      ? [12, 9, 13, 32, 33, 34, 0, 3].slice(0, Math.max(1, routingVariantLimit))
      : isLocalRefinementCandidate
      ? [12, 9, 13, 0, 3, 4].slice(0, Math.max(1, routingVariantLimit))
      : isClusterCandidate
      ? isWarehouseSupplyCluster
        ? (packing.debugLabel?.startsWith(
            "warehouse-supply-cluster:topology-sequential:",
          ) === true
            // Variant 32 still evaluates the incremental seed. Put two
            // direct-connection-first cold reroutes immediately after it so a
            // small routing budget can protect shared endpoint cells before
            // long belts consume them.
            ? [32, 33, 34, 35, 31, 30, 29, 28, 13, 12, 11, 9]
            : isFrontageCandidate
            ? [30, 29, 28, 27, 26, 19, 14, 9]
            : [13, 12, 9, 10, 11, 6])
          .slice(0, routingVariantLimit)
        : routingVariantLimit >= 4
          ? (isSmallTranslation ? [0, 3, 4, 5, 6, 7, 8] : [3, 4, 5, 6, 7, 8])
            .slice(0, routingVariantLimit)
          : [0]
      : Array.from({ length: routingVariantLimit }, (_, index) => index);
    const previouslyAttempted = attemptedRoutingVariants.get(signature) ?? new Set<number>();
    attemptedRoutingVariants.set(signature, previouslyAttempted);
    const packingRoutingVariantIndexes = selectUnattemptedRoutingVariants(
      candidateRoutingVariantIndexes,
      previouslyAttempted,
      adaptiveRouting ? routingVariantLimit - routingVariants : undefined,
    );
    if (packingRoutingVariantIndexes.length === 0) return;
    if (!evaluatedPackingSignatures.has(signature)) {
      evaluatedPackingSignatures.add(signature);
      evaluatedPackings += 1;
    }
    const traceTerminalInterlock =
      process.env["INDUSTRIAL_PLANNER_TRACE_TERMINAL_INTERLOCK"] === "1"
      && isGlobalLayerInterlock;
    if (
      process.env["INDUSTRIAL_PLANNER_TRACE_SEARCH_PROGRESS"] === "1"
      || traceTerminalInterlock
    ) {
      console.error(
        `[packing-evaluate:${evaluatedPackings}] ${packing.debugLabel ?? "initial"} `
        + `local=${String(localRoutingBase !== undefined)} adaptive=${String(adaptiveRouting)} `
        + `variants=${packingRoutingVariantIndexes.join(",")}`,
      );
    } else if (isLocalRoutedSccCore
      && process.env["INDUSTRIAL_PLANNER_TRACE_UPSTREAM"] === "1") {
      console.error(
        `[upstream-evaluate] ${packing.debugLabel ?? "unnamed"} `
        + `variants=${packingRoutingVariantIndexes.join(",")}`,
      );
    }
    // The seed always belongs to the first variant in the complete strategy
    // list. On a second evaluation the first *unattempted* variant must remain
    // a cold reroute instead of accidentally replaying the incremental seed.
    const seedRoutingVariant = candidateRoutingVariantIndexes[0];
    const compareCompleteReroutes = packing.routingSeed !== undefined
      && packingRoutingVariantIndexes.length > 1;
    for (const [routingVariantOffset, routingVariant] of packingRoutingVariantIndexes.entries()) {
      previouslyAttempted.add(routingVariant);
      routingVariantAttempts += 1;
      if (adaptiveRouting) adaptiveRoutingAttempts += 1;
      try {
        const terminalRoutingHeight = isTerminalClusterMovement
          ? Math.min(
              options.request.height,
              Math.max(...packing.devices.map(
                (device) => device.position.y + device.height,
              )) + 1,
            )
          : options.request.height;
        const routingOptions = {
          request: terminalRoutingHeight < options.request.height
            ? { ...options.request, height: terminalRoutingHeight }
            : options.request,
          registry: options.registry,
          requests: options.requests,
          productionDevices: packing.devices,
          productionEntities,
          routingVariant,
          prioritizeFanoutGroups: isClusterCandidate,
          // Frontage-constrained layouts have very little spare corridor space.
          // Scoring every port pair is slower, but avoids committing an early
          // belt that makes the final one or two fan-out routes impossible.
          preferFirstFeasibleRoute: isClusterCandidate
            && !isTerminalClusterMovement
            && !isLocalSccCluster
            && !isSmallTranslation
            && !isFrontageCandidate,
          // Build a complete route allocation first. Under a hard frontage the
          // overflowing connections are then ripped up together with a bounded
          // conflict neighborhood and rerouted against the blocked boundary.
          // This preserves the already legal majority instead of repeatedly
          // destroying all 22 routes to repair the final one or two.
          enforceFrontageConstraint: false,
          freezeFlowAllocation: topologySequentialOnly,
          // A cropped terminal search is a heuristic routing region, not proof
          // that the same placement is infeasible on the full request grid.
          enablePlacementConflictCertificates:
            terminalRoutingHeight === options.request.height,
          onRelaxedConnectivityRejected: (count: number) => {
            relaxedConnectivityRejectedPortPairs += count;
          },
        } as const;
        let routing: RoutingResult;
        // The incrementally routed seed is a feasibility witness, not the
        // final port assignment. Retain it as one candidate, then cold-route
        // the remaining variants from the complete device graph so future
        // endpoints can jointly change ports, track order, and crossings.
        if (packing.routingSeed !== undefined && routingVariant === seedRoutingVariant) {
          routing = packing.routingSeed;
        } else if (localRoutingBase !== undefined && movedDeviceIds.size > 0
          && !routingOptions.enforceFrontageConstraint) {
          const preservationRouting =
            packing.preservationRoutingSeed ?? localRoutingBase.routing;
          const previousConnections = preservationRouting.connections;
          // A translated SCC is intended to open a corridor, so begin with the
          // routes incident to that component plus every route already outside
          // the unloader frontage. The preservation pass independently rejects
          // any unchanged path now covered by a moved footprint; eagerly
          // expanding through the whole old/new SCC rectangle destroys too
          // many otherwise useful legal routes.
          const initialConnectionIds = packing.preservationForcedRipUpConnectionIds !== undefined
            ? [...packing.preservationForcedRipUpConnectionIds].sort()
            : isLocalSccInternalBranch
            ? [...new Set([
                ...computeAffectedConnections(previousConnections, movedDeviceIds).connectionIds,
                ...previousConnections
                  .filter((connection) => connection.points.some((point) =>
                    packing.devices.some((device) =>
                      movedDeviceIds.has(device.id)
                      && point.x >= device.position.x
                      && point.x < device.position.x + device.width
                      && point.y >= device.position.y
                      && point.y < device.position.y + device.height)))
                  .map((connection) => connection.id),
                ...listFrontageOverflowConnectionIds(
                  localRoutingBase.packing.devices,
                  previousConnections,
                ),
              ])].sort().slice(0, 16)
            : isTerminalClusterMovement
            ? [...new Set([
                ...computeAffectedConnections(previousConnections, movedDeviceIds).connectionIds,
                ...listFrontageOverflowConnectionIds(
                  localRoutingBase.packing.devices,
                  previousConnections,
                ),
              ])].sort()
            : isLocalSccCluster
            ? [...new Set([
                ...computeAffectedConnections(previousConnections, movedDeviceIds).connectionIds,
                ...listFrontageOverflowConnectionIds(
                  localRoutingBase.packing.devices,
                  previousConnections,
                ),
              ])].sort()
            : resolveConflictingConnections({
                connections: previousConnections,
                movedDeviceIds,
                previousDevices: localRoutingBase.packing.devices,
                nextDevices: packing.devices,
                buffer: 1,
                maxConnections: 16,
              });
          let locallyRouted: RoutingResult | null = null;
          const localFailurePriorities: string[] = [];
          // When preservation has expanded to every old connection, the call
          // is a cold reroute in all but name. Retain its deterministic failure
          // by priority order so the explicit cold fallback does not repeat it.
          const fullRipFailureStateKey = `${packingSignature(packing)}\u0002${routingVariant}`;
          const fullRipFailuresByPriorityOrder =
            localFullRipFailuresByGeometryVariant.get(fullRipFailureStateKey)
            ?? new Map<string, unknown>();
          localFullRipFailuresByGeometryVariant.set(
            fullRipFailureStateKey,
            fullRipFailuresByPriorityOrder,
          );
          const localRepair = ripUpAndReroute({
            connections: previousConnections,
            initialConnectionIds,
            config: {
              maxConnections: isTerminalClusterMovement ? previousConnections.length : 16,
              maxAttempts: isTerminalClusterMovement ? 20 : 8,
              retryExhaustedSet: isTerminalClusterMovement,
              maxCbsDepth: 4,
              maxCbsStates: 64,
              timeBudgetMs: isTerminalClusterMovement ? 20_000 : 6_000,
            },
            retryStateSignature: () => localFailurePriorities.join("\u0001"),
            tryReroute: (connectionIds, attempt) => {
              const priorityOrder = localFailurePriorities.join("\u0001");
              const cachedFullRipFailure = connectionIds.length === previousConnections.length
                && fullRipFailuresByPriorityOrder.has(priorityOrder)
                ? fullRipFailuresByPriorityOrder.get(priorityOrder)
                : undefined;
              try {
                if (cachedFullRipFailure !== undefined) {
                  localFullRipFailureStatesReused += 1;
                  throw cachedFullRipFailure;
                }
                locallyRouted = routeMaterialFlow({
                  ...routingOptions,
                  previousRouting: preservationRouting,
                  previousProductionDevices: localRoutingBase.packing.devices,
                  movedDeviceIds,
                  forcedRipUpConnectionIds: new Set(connectionIds),
                  priorityConnectionKeys: localFailurePriorities,
                  preservationConnectionLimit: isTerminalClusterMovement
                    ? previousConnections.length
                    : undefined,
                });
                return true;
              } catch (error) {
                if (connectionIds.length === previousConnections.length) {
                  fullRipFailuresByPriorityOrder.set(priorityOrder, error);
                }
                // A terminal compression changes a fan-in bank and its nearby
                // branch at the same time. Retrying only with a larger rip-up
                // set repeats the same greedy order and can strand the same
                // scarce port. Promote the deepest failed connection on the
                // next attempt while preserving every still-valid old route.
                if (isTerminalClusterMovement && error instanceof RouteFailureError) {
                  const failureKey = routeFailureConnectionKey(error.evidence);
                  const existingIndex = localFailurePriorities.indexOf(failureKey);
                  if (existingIndex >= 0) localFailurePriorities.splice(existingIndex, 1);
                  localFailurePriorities.unshift(failureKey);
                  if (localFailurePriorities.length > 8) localFailurePriorities.pop();
                }
                if (isTerminalClusterMovement
                  && process.env["INDUSTRIAL_PLANNER_TRACE_SEARCH_PROGRESS"] === "1") {
                  console.error(
                    `[terminal-cluster-attempt-failure:v${routingVariant}] `
                    + `attempt=${attempt} ripped=${connectionIds.length} `
                    + `${error instanceof Error ? error.message : String(error)}`,
                  );
                }
                return false;
              }
            },
          });
          localRepairAttempts += localRepair.attempts;
          if ((isLocalSccCluster || isTerminalClusterMovement)
            && process.env["INDUSTRIAL_PLANNER_TRACE_SEARCH_PROGRESS"] === "1") {
            console.error(
              `[${isTerminalClusterMovement ? "terminal-cluster" : "local-scc"}-rip-up:v${routingVariant}] `
              + `status=${localRepair.status} `
              + `ripped=${localRepair.rippedConnectionIds.length} `
              + `attempts=${localRepair.attempts}`,
            );
          }
          // Local preservation is an optimization only. If bounded repair
          // fails, fall back to a full reroute. A rigid terminal-cluster move
          // changes several fan-in and upstream connections at once, so retain
          // the deepest failed connection as a bounded ordering constraint
          // instead of retrying the same greedy ordering.
          if (locallyRouted !== null) {
            routing = locallyRouted;
          } else if (isTerminalClusterMovement || isLocalSccCluster) {
            routing = routeWithFailureDirectedPriorities({
              maximumPriorities: 8,
              cachedFailuresByPriorityOrder: fullRipFailuresByPriorityOrder,
              tryRoute: (failurePriorities) =>
                routeMaterialFlow({
                  ...routingOptions,
                  priorityConnectionKeys: failurePriorities,
                }),
              failureKey: (error) => error instanceof RouteFailureError
                ? routeFailureConnectionKey(error.evidence)
                : null,
              onRoutingAttempt: () => {
                localFullRerouteAttempts += 1;
              },
              onCachedFailureReuse: () => {
                localFullRipFailureStatesReused += 1;
              },
            });
          } else {
            routing = routeMaterialFlow(routingOptions);
          }
        } else {
          const failurePriorities: string[] = [];
          const attemptedFailurePriorityOrders = new Set<string>();
          const maximumFailurePriorities = topologySequentialOnly ? 12 : 4;
          const maximumFailureAttempts = maximumFailurePriorities * 2;
          let strongestFailureProgress = -1;
          let strongestFailurePriorities: string[] = [];
          let strongestFailureNeighborhood: string[] = [];
          let strongestFailureKey = "";
          let prioritizedRouting: RoutingResult | null = null;
          let prioritizedRoutingError: unknown = null;
          for (let failureAttempt = 0; failureAttempt <= maximumFailureAttempts; failureAttempt += 1) {
            attemptedFailurePriorityOrders.add(failurePriorities.join("\u0001"));
            try {
              prioritizedRouting = routeMaterialFlow({
                ...routingOptions,
                priorityConnectionKeys: failurePriorities,
              });
              break;
            } catch (error) {
              prioritizedRoutingError = error;
              if (!isFrontageCandidate || !(error instanceof RouteFailureError)) throw error;
              const failureKey = routeFailureConnectionKey(error.evidence);
              const failureNeighborhood = createFailureDirectedPriorityNeighborhood({
                evidence: error.evidence,
                requests: options.requests,
                registry: options.registry,
                devices: packing.devices,
              });
              const progress = Number.parseInt(
                error.message.match(/Completed connections: (\d+)\//)?.[1] ?? "-1",
                10,
              );
              const newFailurePriorities = failureNeighborhood.filter((key) =>
                !failurePriorities.includes(key));
              if (progress > strongestFailureProgress) {
                strongestFailureProgress = progress;
                strongestFailurePriorities = [...failurePriorities];
                strongestFailureNeighborhood = [...newFailurePriorities];
                strongestFailureKey = failureKey;
              }
              if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
                console.error(
                  `[direct-frontage-order:v${routingVariant}] progress=${progress} `
                  + `failure=${failureKey} priorities=${failurePriorities.join(";")}`,
                );
              }
              // The unrestricted route is only a complete allocation used to
              // seed bounded hard-frontage repair. Once the same connection
              // fails twice, rotating the entire priority list produces many
              // low-progress permutations without improving that seed.
              if (newFailurePriorities.length === 0) throw error;
              const greedyNextFailurePriorities = [
                ...newFailurePriorities,
                ...failurePriorities.filter((key) =>
                  !failureNeighborhood.includes(key)),
              ].slice(0, maximumFailurePriorities);
              const strongestAppend = [
                ...strongestFailurePriorities,
                ...strongestFailureNeighborhood.filter((key) =>
                  !strongestFailurePriorities.includes(key)),
              ].slice(0, maximumFailurePriorities);
              const strongestSingleAppend = [
                ...strongestFailurePriorities,
                ...([strongestFailureKey].filter((key) =>
                  key.length > 0 && !strongestFailurePriorities.includes(key))),
              ].slice(0, maximumFailurePriorities);
              const nextFailurePriorities = (progress < strongestFailureProgress
                ? [strongestAppend, strongestSingleAppend, greedyNextFailurePriorities]
                : [greedyNextFailurePriorities])
                .find((candidate) =>
                  !attemptedFailurePriorityOrders.has(candidate.join("\u0001")));
              if (nextFailurePriorities === undefined) throw error;
              // Failure-directed global reroute: destroy all belts, reserve the
              // newly stranded connection, and retain earlier constraints. A
              // short chain gives compact layouts real backtracking without an
              // unbounded permutation search. If a new front-loaded constraint
              // sharply regresses progress, retry by appending it to the best
              // known order so already-proven corridors retain precedence.
              failurePriorities.splice(
                0,
                failurePriorities.length,
                ...nextFailurePriorities,
              );
            }
          }
          if (prioritizedRouting === null) {
            throw prioritizedRoutingError
              ?? new Error("Unable to route prioritized material connections");
          }
          routing = prioritizedRouting;
        }
        if (hardFrontageRequired
          && !routingOptions.enforceFrontageConstraint
          && measureFrontageOverflowCells(packing.devices) === 0) {
          let hardRouting: RoutingResult | null = null;
          let strongestHardFailure: { readonly progress: number; readonly evidence: RouteFailureEvidence } | null = null;
          const softOverflowConnectionIds = listFrontageOverflowConnectionIds(
            packing.devices,
            routing.connections,
          );
          if (softOverflowConnectionIds.length === 0) {
            hardRouting = routing;
          } else {
            const preservationAnchor = packing.devices.find((device) =>
              device.kind === "production" || device.kind === "storage");
            if (preservationAnchor !== undefined) {
              ripUpAndReroute({
                connections: routing.connections,
                initialConnectionIds: softOverflowConnectionIds,
                config: {
                  maxConnections: 8,
                  maxAttempts: 8,
                  maxCbsDepth: 4,
                  maxCbsStates: 64,
                  timeBudgetMs: 6_000,
                },
                tryReroute: (connectionIds, attempt) => {
                  try {
                    const ripped = new Set(connectionIds);
                    const priorityConnectionKeys = routing.connections
                      .filter((connection) => ripped.has(connection.id))
                      .map(routeConnectionKey);
                    const repaired = routeMaterialFlow({
                      ...routingOptions,
                      routingVariant: routingVariant + attempt - 1,
                      enforceFrontageConstraint: true,
                      previousRouting: routing,
                      previousProductionDevices: packing.devices,
                      // Preservation is activated by a non-empty motion set;
                      // forcedRipUpConnectionIds supplies the exact route set,
                      // so the anchor itself remains fixed.
                      movedDeviceIds: new Set([preservationAnchor.id]),
                      forcedRipUpConnectionIds: ripped,
                      priorityConnectionKeys,
                    });
                    if (listFrontageOverflowConnectionIds(
                      packing.devices,
                      repaired.connections,
                    ).length > 0) return false;
                    hardRouting = repaired;
                    return true;
                  } catch (error) {
                    if (error instanceof RouteFailureError) {
                      const progress = Number.parseInt(
                        error.message.match(/Completed connections: (\d+)\//)?.[1] ?? "-1",
                        10,
                      );
                      if (strongestHardFailure === null
                        || progress > strongestHardFailure.progress) {
                        strongestHardFailure = { progress, evidence: error.evidence };
                      }
                      if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
                        console.error(
                          `[hard-frontage-rip-up:v${routingVariant}] progress=${progress} `
                          + `attempt=${attempt} ripped=${connectionIds.join(";")}`,
                        );
                      }
                    }
                    return false;
                  }
                },
              });
            }
          }
          const hardPriorities: string[] = [];
          const maximumHardPriorities = topologySequentialOnly ? 16 : 6;
          const attemptedHardPriorityOrders = new Set<string>();
          const maximumHardAttempts = maximumHardPriorities * 2;
          for (let hardAttempt = 0;
            hardRouting === null && hardAttempt <= maximumHardAttempts;
            hardAttempt += 1) {
            attemptedHardPriorityOrders.add(hardPriorities.join("\u0001"));
            try {
              hardRouting = routeMaterialFlow({
                ...routingOptions,
                enforceFrontageConstraint: true,
                priorityConnectionKeys: hardPriorities,
              });
              break;
            } catch (error) {
              if (!(error instanceof RouteFailureError)) throw error;
              const hardProgress = Number.parseInt(
                error.message.match(/Completed connections: (\d+)\//)?.[1] ?? "-1",
                10,
              );
              if (strongestHardFailure === null || hardProgress > strongestHardFailure.progress) {
                strongestHardFailure = { progress: hardProgress, evidence: error.evidence };
              }
              const failureKey = routeFailureConnectionKey(error.evidence);
              if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
                console.error(
                  `[hard-frontage-order:v${routingVariant}] progress=${hardProgress} `
                  + `failure=${failureKey} priorities=${hardPriorities.join(";")}`,
                );
              }
              const nextHardPriorities = [
                failureKey,
                ...hardPriorities.filter((key) => key !== failureKey),
              ].slice(0, maximumHardPriorities);
              const nextOrder = nextHardPriorities.join("\u0001");
              if (attemptedHardPriorityOrders.has(nextOrder)) break;
              hardPriorities.splice(0, hardPriorities.length, ...nextHardPriorities);
            }
          }
          if (hardRouting !== null) routing = hardRouting;
          else if (strongestHardFailure !== null) {
            const signature = packingSignature(packing);
            const previous = frontagePackingFailures.get(signature);
            if (previous === undefined || strongestHardFailure.progress > previous.progress) {
              frontagePackingFailures.set(signature, {
                packing,
                progress: strongestHardFailure.progress,
                evidence: strongestHardFailure.evidence,
              });
            }
          }
        }
        const shouldRefineFixedRouting = topologySequentialOnly
          && !deferRoutingSeedPolish
          && (
            (
              packing.routingSeed !== undefined
              && (routingVariant !== seedRoutingVariant
                || packingRoutingVariantIndexes.length === 1)
            )
            || isStraightLineCollapse
          );
        const candidateRoutings = [
          routing,
          ...(shouldRefineFixedRouting
            ? createFixedDeviceRoutingRefinements({
                request: options.request,
                registry: options.registry,
                requests: options.requests,
                productionDevices: packing.devices,
                productionEntities,
                routing,
                enforceFrontageConstraint: hardFrontageRequired,
                maximumNeighborhoods: isStraightLineCollapse ? 4 : undefined,
                // Keep line-clearing transitions cheap; the converged fixed
                // equipment geometry receives a complete bank polish below.
                maximumConnectionsPerNeighborhood: isStraightLineCollapse ? 6 : undefined,
              })
            : []),
        ];
        for (const candidateRouting of candidateRoutings) {
          routedCandidates += 1;
          const powerPlacement = placePowerDiffusers({
            placeableDevices: packing.devices,
            occupiedDevices: [...packing.devices, ...candidateRouting.devices],
            requests: options.requests,
            registry: options.registry,
            limitWidth: options.request.width,
            limitHeight: options.request.height,
          });
          if (powerPlacement === null) {
            // Power is a post-routing feasibility phase. Reject this complete
            // material layout and let the ordinary packing search try another
            // geometry; a missing diffuser slot must not abort the whole search.
            powerInfeasibleCandidates += 1;
            continue;
          }
          const powerDevices = powerPlacement.devices;
          packingRouted = true;
          const candidateProductionEntities = {
            ...productionEntities,
            ...createEntities(options.requests, powerDevices),
          };
          const allDevices = [...packing.devices, ...candidateRouting.devices, ...powerDevices];
          // The fixed warehouse base/bus is excluded from the factory footprint.
          // Every placeable factory entity, including power diffusers, is part of
          // both the optimized area and the hard unloader-frontage constraint.
          const areaDevices = allDevices.filter((device) =>
            device.kind !== "warehouse-bus"
            && (
              device.kind !== "belt"
              || !candidateRouting.areaExcludedDeviceIds.has(device.id)
            ));
          const bounds = measureFactoryFootprintBounds(areaDevices);
          const physicalBounds = measureFactoryFootprintBounds(allDevices);
          const contourArea = measureConvexContourArea(areaDevices);
          const areaCompactness = measureLayoutCompactness(areaDevices);
          const contourCompactness = areaCompactness;
          const frontageOverflowCellCount = measureFrontageOverflowCells(areaDevices);
          const candidate: RoutedLayoutCandidate = {
            packing,
            productionEntities: candidateProductionEntities,
            routing: candidateRouting,
            allDevices,
            bounds,
            contourArea,
            contourVoidArea: Math.max(0, contourArea - contourCompactness.occupiedCellCount),
            boundingVoidCellCount: areaCompactness.boundingVoidCellCount,
            enclosedVoidCellCount: contourCompactness.enclosedVoidCellCount,
            frontageOverflowCellCount,
            minimumPowerDeviceCount: powerPlacement.minimumRequiredCount,
            equipmentArea: areaDevices.reduce((sum, device) => sum + device.width * device.height, 0),
            physicalBounds,
          };
          if ((packing.debugLabel?.startsWith("local-scc-internal:") === true
              || packing.debugLabel?.startsWith("local-scc-cluster:") === true
              || packing.debugLabel?.startsWith("local-scc-routed-core:") === true)
            && (
              process.env["INDUSTRIAL_PLANNER_TRACE_SEARCH_PROGRESS"] === "1"
              || (
                isLocalRoutedSccCore
                && process.env["INDUSTRIAL_PLANNER_TRACE_UPSTREAM"] === "1"
              )
            )) {
            console.error(
              `[local-scc-candidate] ${packing.debugLabel} `
              + `bounds=${bounds.width}x${bounds.height} contour=${contourArea} `
              + `belts=${candidateRouting.devices.length} `
              + `turns=${countTurnsAndCrossings(candidateRouting)} `
              + `power=${powerDevices.length} holes=${candidate.enclosedVoidCellCount}`,
            );
          }
          if (isTerminalClusterMovement
            && (
              process.env["INDUSTRIAL_PLANNER_TRACE_SEARCH_PROGRESS"] === "1"
              || traceTerminalInterlock
            )) {
            console.error(
              `[terminal-cluster-candidate] ${packing.debugLabel} `
              + `bounds=${bounds.width}x${bounds.height} contour=${contourArea} `
              + `belts=${candidateRouting.devices.length} `
              + `turns=${countTurnsAndCrossings(candidateRouting)} `
              + `power=${powerDevices.length} holes=${candidate.enclosedVoidCellCount}`,
            );
            if (process.env["INDUSTRIAL_PLANNER_TRACE_TERMINAL_ROUTES"] === "1") {
              console.error(
                `[local-terminal-routes] ${packing.debugLabel} `
                + JSON.stringify(candidateRouting.connections.map((connection) => ({
                  id: connection.id,
                  sourceDeviceId: connection.sourceDeviceId,
                  targetDeviceId: connection.targetDeviceId,
                  points: connection.points,
                }))),
              );
              console.error(
                `[local-terminal-devices] ${packing.debugLabel} `
                + JSON.stringify({
                  packing: packing.devices.map((device) => ({
                    id: device.id,
                    kind: device.kind,
                    position: device.position,
                    rotation: device.rotation,
                    width: device.width,
                    height: device.height,
                  })),
                  power: powerDevices.map((device) => ({
                    id: device.id,
                    position: device.position,
                    width: device.width,
                    height: device.height,
                  })),
                }),
              );
            }
          }
          if (isFrontageCandidate
            && process.env["INDUSTRIAL_PLANNER_TRACE_FRONTAGE_CANDIDATES"] === "1") {
            console.error(
              `[frontage-routed] ${packing.debugLabel ?? "unnamed"} `
              + `overflow=${candidate.frontageOverflowCellCount} `
              + `bounds=${bounds.width}x${bounds.height} `
              + `holes=${candidate.enclosedVoidCellCount} `
              + `void=${candidate.boundingVoidCellCount}`,
            );
          }
          if (hardFrontageRequired
            && frontageOverflowCellCount > 0) {
            const signature = packingSignature(candidate.packing);
            const previous = frontageRepairPool.get(signature);
            if (previous === undefined || compareFrontageRepairCandidates(candidate, previous) < 0) {
              frontageRepairPool.set(signature, candidate);
              packingImproved = true;
            }
            continue;
          }
          const previousBest = best;
          best = retainRoutedEliteCandidate(
            feasibleEliteArchive,
            candidate,
            MAX_FEASIBLE_ELITE_STATES,
          );
          if (previousBest === null || compareRoutedLayouts(best, previousBest) < 0) {
            packingImproved = true;
          }
        }
        // Most frontage candidates retain the fast first-feasible behavior.
        // A complete topology-sequential seed is different: its early routes
        // were committed before later endpoints existed, so all requested cold
        // reroutes must compete before the final route is selected.
        if (isFrontageCandidate && !compareCompleteReroutes) break;
        // Terminal moves are ranked first by their changed outer height. Once
        // one complete route exists for this fixed geometry, spend the local
        // budget on the next compression distance instead of alternative port
        // assignments for the same device positions.
        if (isTerminalClusterMovement && packingRouted) {
          localRoutingVariantsSkippedAfterSuccess +=
            packingRoutingVariantIndexes.length - routingVariantOffset - 1;
          break;
        }
      } catch (error) {
        const candidateError = error instanceof Error ? error : new Error(String(error));
        if (packing.debugLabel !== undefined && process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
          console.error(`[routing:${packing.debugLabel}:v${routingVariant}] ${candidateError.message}`);
        }
        const progress = Number.parseInt(candidateError.message.match(/Completed connections: (\d+)\//)?.[1] ?? "-1", 10);
        if (isLocalSccCluster
          && (
            process.env["INDUSTRIAL_PLANNER_TRACE_SEARCH_PROGRESS"] === "1"
            || (
              isLocalRoutedSccCore
              && process.env["INDUSTRIAL_PLANNER_TRACE_UPSTREAM"] === "1"
            )
          )) {
          console.error(
            `[local-scc-routing-failure:v${routingVariant}] progress=${progress} `
            + `${candidateError.message}`,
          );
        }
        if (isTerminalClusterMovement
          && (
            process.env["INDUSTRIAL_PLANNER_TRACE_SEARCH_PROGRESS"] === "1"
            || traceTerminalInterlock
          )) {
          console.error(
            `[terminal-cluster-routing-failure:v${routingVariant}] progress=${progress} `
            + `${candidateError.message}`,
          );
        }
        if (progress >= packingRoutingProgress) {
          packingRoutingProgress = progress;
          packingRoutingMessage = candidateError.message;
        }
        if (progress >= routingErrorProgress) {
          routingError = candidateError;
          routingErrorProgress = progress;
        }
        // Capture exactly one best/furthest RouteFailureEvidence (not first-20)
        if (error instanceof RouteFailureError
          && (bestRouteFailure === null
            || progress > bestRouteFailure.progress
            || (progress === bestRouteFailure.progress
              && routeFailureEvidenceKey(error.evidence) < routeFailureEvidenceKey(bestRouteFailure.evidence)))) {
          bestRouteFailure = { progress, evidence: error.evidence };
        }
        if (error instanceof RouteFailureError) {
          const cut = createRouteFailurePoseCut(packing, error.evidence);
          if (cut.length > 0) {
            const cutKey = cut.map((placement) =>
              `${placement.id}@${placement.x},${placement.y},${placement.rotation}`).join("|");
            if (certifiedRouteFailureCuts.has(cutKey)
              || certifiedRouteFailureCuts.size < MAX_CERTIFIED_ROUTE_FAILURE_CUTS) {
              certifiedRouteFailureCuts.set(cutKey, cut);
            }
          }
          const capacityCut = createRouteFailureCapacityCut(packing, error.evidence);
          if (capacityCut !== null) {
            const capacityCutKey = `${capacityCut.axis}@${capacityCut.coordinate ?? "general"}:`
              + `${capacityCut.gridWidth}x${capacityCut.gridHeight}:`
              + `${capacityCut.requiredCapacity}:`
              + capacityCut.activeWhenPlacements.map((placement) =>
                `${placement.id}@${placement.x},${placement.y},${placement.rotation}`).join("|")
              + `:${capacityCut.cutEdges.map((edge) =>
                `${gridKey(edge.from)}>${gridKey(edge.to)}`).join("|")}`
              + `:${capacityCut.fixedBlockedEdgeIndexes.join(",")}`;
            if (certifiedRouteCapacityCuts.has(capacityCutKey)
              || certifiedRouteCapacityCuts.size < MAX_CERTIFIED_ROUTE_CAPACITY_CUTS) {
              certifiedRouteCapacityCuts.set(capacityCutKey, capacityCut);
            }
          }
        }
        if (isFrontageCandidate && error instanceof RouteFailureError) {
          const signature = packingSignature(packing);
          const previous = frontagePackingFailures.get(signature);
          if (previous === undefined || progress > previous.progress) {
            frontagePackingFailures.set(signature, { packing, progress, evidence: error.evidence });
          }
        }
      }
    }
    if (isFrontageCandidate && !packingRouted
      && process.env["INDUSTRIAL_PLANNER_TRACE_FRONTAGE_CANDIDATES"] === "1") {
      console.error(
        `[frontage-rejected] ${packing.debugLabel ?? "unnamed"} `
        + `progress=${packingRoutingProgress} ${packingRoutingMessage}`,
      );
    }
    if (packingRouted) {
      packingRoutingFailures.delete(signature);
    } else if (packingRoutingProgress >= 0) {
      const previous = packingRoutingFailures.get(signature);
      if (previous === undefined || packingRoutingProgress >= previous.progress) {
        packingRoutingFailures.set(signature, { packing, progress: packingRoutingProgress });
      }
    }
    if (isClusterCandidate) {
      if (packingRouted) clusterCandidatesRouted += 1;
      else clusterCandidatesAStarRejected += 1;
      if (packingImproved) clusterCandidatesImproved += 1;
    }
    if (isGlobalRebuildCandidate) {
      if (packingRouted) globalRebuildCandidatesRouted += 1;
      if (packingImproved) globalRebuildCandidatesImproved += 1;
    }
    if (isGlobalLayerInterlock) {
      if (packingRouted) globalLayerInterlockCandidatesRouted += 1;
      if (packingImproved) globalLayerInterlockCandidatesImproved += 1;
    }
    if (isPartialRebuildCandidate) {
      if (packingRouted) partialRebuildCandidatesRouted += 1;
      if (packingImproved) partialRebuildCandidatesImproved += 1;
    }
  };
  for (const packing of candidates) {
    const deferSeed = topologySequentialOnly
      && routingVariants > 1
      && packing.routingSeed !== undefined;
    if (deferSeed) seededInitialCandidatesRanked += 1;
    evaluatePacking(
      packing,
      undefined,
      deferSeed ? 1 : routingVariants,
      false,
      deferSeed,
    );
  }
  // Incremental topology seeds are complete feasibility witnesses. Rank them
  // cheaply first, then cold-route every seeded geometry so staging changes
  // evaluation order without reducing the quality search space.
  if (topologySequentialOnly && routingVariants > 1) {
    const seededPolishCandidates = candidates
      .filter((packing) => packing.routingSeed !== undefined);
    seededInitialCandidatesPolished = seededPolishCandidates.length;
    seededInitialColdVariantsSkipped = 0;
    for (const packing of seededPolishCandidates) {
      evaluatePacking(packing, undefined, routingVariants);
    }
  }
  // A narrow user beam is the normal fast path. If every selected packing
  // fails, expand deterministically by at most eight candidates (and never
  // beyond the public maximum) before declaring the layout infeasible.
  const adaptiveCandidateLimit = Math.min(48, refinementCandidateLimit + 8);
  if (best === null && candidates.length < adaptiveCandidateLimit && initialBaseline !== null) {
    const expandedCandidates = selectInitialPackingCandidateBeam(
      initialBaseline,
      [
        ...warehouseSupplyCandidateFamilies,
        cpSatInitialCandidates,
        heuristicInitialCandidates,
      ],
      adaptiveCandidateLimit,
    );
    for (const packing of expandedCandidates) {
      const signature = packingSignature(packing);
      if (seenPackings.has(signature)) continue;
      seenPackings.add(signature);
      adaptiveCandidatesEvaluated += 1;
      evaluatePacking(packing);
      if (best !== null) break;
    }
  }
  // Candidate diversity cannot fix a bad connection ordering. Retry only the
  // four deepest failures with additional deterministic route variants. The
  // attempted-variant map prevents repeating work from the fast path.
  if (best === null && routingVariants < 9) {
    effectiveRoutingVariants = Math.min(9, Math.max(3, routingVariants + 2));
    const deepestFailures = [...packingRoutingFailures.entries()]
      .sort((left, right) =>
        right[1].progress - left[1].progress || left[0].localeCompare(right[0]))
      .slice(0, 4);
    for (const [, failure] of deepestFailures) {
      evaluatePacking(failure.packing, undefined, effectiveRoutingVariants, true);
      if (best !== null) break;
    }
  }
  // Placement and routing are separate phases. If an independently moved
  // equipment layout fails only when belts are added, retry by moving the
  // failed source/target or a frontier blocker one device at a time. Existing
  // logistics are intentionally discarded by evaluatePacking.
  // Failure repair is a feasibility fallback when no initial candidate routes.
  // With a valid incumbent it is part of iterative improvement only, so an
  // iterations=0 request must not silently expand into another large A* phase.
  if (best === null || requestedIterations > 0) {
    const independentFailures = [...frontagePackingFailures.values()]
      .filter((failure) =>
        failure.packing.debugLabel?.includes(":independent-insert:") === true)
      .sort((left, right) =>
        right.progress - left.progress
        || packingSignature(left.packing).localeCompare(packingSignature(right.packing)))
      .slice(0, 2);
    let selectedRepairCandidates = 0;
    for (const failure of independentFailures) {
      const repairNeighbors = createRouteFailureBacktrackingNeighbors({
        packing: failure.packing,
        evidence: failure.evidence,
        requests: options.requests,
        registry: options.registry,
        enableCpSat: false,
        targetedOnly: true,
        limitWidth: options.request.width,
        limitHeight: options.request.height,
        allowRotate: options.allowRotate,
      });
      clusterCandidatesGenerated += repairNeighbors.clusterGenerated;
      clusterCandidatesCheapRejected += repairNeighbors.clusterCheapRejected;
      for (const packing of repairNeighbors.packings) {
        if (selectedRepairCandidates >= refinementCandidateLimit) break;
        const signature = packingSignature(packing);
        if (seenPackings.has(signature)) continue;
        seenPackings.add(signature);
        selectedRepairCandidates += 1;
        evaluatePacking(packing);
      }
      if (selectedRepairCandidates >= refinementCandidateLimit) break;
    }
  }
  // A compact placement can be geometrically valid yet fail on the final one
  // or two belts. Use the structured route frontier to move actual blocking
  // equipment, discard all old logistics, and retry. Newly failed repairs feed
  // the next depth, providing bounded placement/routing backtracking.
  if (hardFrontageRequired
    && best === null && !localOnly) {
    const processedFailures = new Set<string>();
    for (let depth = 0; depth < 5 && best === null; depth += 1) {
      const failures = [...frontagePackingFailures.entries()]
        .filter(([signature]) => !processedFailures.has(signature))
        .sort((left, right) => {
          const leftOverflow = frontageRepairPool.get(left[0])?.frontageOverflowCellCount
            ?? Number.MAX_SAFE_INTEGER;
          const rightOverflow = frontageRepairPool.get(right[0])?.frontageOverflowCellCount
            ?? Number.MAX_SAFE_INTEGER;
          return leftOverflow - rightOverflow
            || right[1].progress - left[1].progress
            || left[0].localeCompare(right[0]);
        })
        .slice(0, 6);
      if (failures.length === 0) break;
      for (const [signature, failure] of failures) {
        processedFailures.add(signature);
        const repairNeighbors = createRouteFailureBacktrackingNeighbors({
          packing: failure.packing,
          evidence: failure.evidence,
          requests: options.requests,
          registry: options.registry,
          enableCpSat: cpSat?.enabled === true,
          limitWidth: options.request.width,
          limitHeight: options.request.height,
          allowRotate: options.allowRotate,
        });
        clusterCandidatesGenerated += repairNeighbors.clusterGenerated;
        clusterCandidatesCheapRejected += repairNeighbors.clusterCheapRejected;
        const phasePackings = repairNeighbors.packings.filter((packing) =>
          packing.debugLabel?.startsWith("route-failure-backtrack:") === true);
        const unseen = phasePackings.filter((packing) =>
          !seenPackings.has(packingSignature(packing)));
        for (const packing of unseen.slice(0, 32)) {
          seenPackings.add(packingSignature(packing));
          evaluatePacking(packing);
          if (best !== null) break;
        }
        if (best !== null) break;
      }
    }
    // Freeze the best single-device repair baseline before injecting global
    // jumps. Failed LNS candidates must not perturb the evidence queue that
    // produced the incumbent frontage reduction.
    if (best === null) {
      const globalFailures = [...frontagePackingFailures.entries()]
        .sort((left, right) => {
          const leftOverflow = frontageRepairPool.get(left[0])?.frontageOverflowCellCount
            ?? Number.MAX_SAFE_INTEGER;
          const rightOverflow = frontageRepairPool.get(right[0])?.frontageOverflowCellCount
            ?? Number.MAX_SAFE_INTEGER;
          return leftOverflow - rightOverflow
            || right[1].progress - left[1].progress
            || left[0].localeCompare(right[0]);
        })
        .slice(0, 4);
      for (const [, failure] of globalFailures) {
        const repairNeighbors = createRouteFailureBacktrackingNeighbors({
          packing: failure.packing,
          evidence: failure.evidence,
          requests: options.requests,
          registry: options.registry,
          enableCpSat: cpSat?.enabled === true,
          limitWidth: options.request.width,
          limitHeight: options.request.height,
          allowRotate: options.allowRotate,
        });
        clusterCandidatesGenerated += repairNeighbors.clusterGenerated;
        clusterCandidatesCheapRejected += repairNeighbors.clusterCheapRejected;
        const globalPackings = repairNeighbors.packings.filter((packing) =>
          packing.debugLabel?.startsWith("route-failure-lns:") === true
          || packing.debugLabel === "route-failure-cpsat");
        for (const packing of globalPackings.slice(0, 32)) {
          const signature = packingSignature(packing);
          if (seenPackings.has(signature)) continue;
          seenPackings.add(signature);
          evaluatePacking(packing);
          if (best !== null) break;
        }
        if (best !== null) break;
      }
    }
  }
  // A perpendicular straight cut is not a heuristic layout mutation: deleting
  // it contracts an existing feasible path without changing ports, connection
  // order, or material topology. Normalize these cuts before the ordinary
  // refinement beam, including iterations=0 local requests. This keeps a
  // topology baseline cheap while ensuring it does not retain mechanically
  // removable rows/columns.
  const evaluateProvenStraightCutRound = (): boolean => {
    const compactionBase = best as RoutedLayoutCandidate | null;
    if (compactionBase === null) return false;
    const neighbors = createStraightBeltRowCollapseNeighbors({
      packing: compactionBase.packing,
      routing: compactionBase.routing,
      limitWidth: options.request.width,
      limitHeight: options.request.height,
      routingClearance: options.routingClearance,
    }).packings.filter((packing) => packing.preservationRoutingSeed !== undefined);
    clusterCandidatesGenerated += neighbors.length;
    for (const packing of neighbors) {
      const signature = packing.evaluationKey ?? packingSignature(packing);
      if (seenPackings.has(signature)) continue;
      seenPackings.add(signature);
      // One preservation attempt is a complete witness for a proven cut. The
      // regular local stages may still revisit the geometry with cold routing
      // variants when iterations>0, preserving the existing quality envelope.
      evaluatePacking(packing, compactionBase, 1, false, true);
      const nextBest = best as RoutedLayoutCandidate | null;
      if (nextBest !== null
        && compareRoutedLayouts(nextBest, compactionBase) < 0) {
        return true;
      }
    }
    return false;
  };
  if (localOnly) {
    // Every successful round removes at least one integer coordinate from the
    // charged rectangle, so width+height is a finite, geometry-derived bound.
    const maximumProvenRounds = options.request.width + options.request.height;
    for (let round = 0; round < maximumProvenRounds; round += 1) {
      if (!evaluateProvenStraightCutRound()) break;
      localConvergenceTransitions += 1;
    }
  }
  // Packing order search cannot react to the actual routed footprint. Refine the
  // current winner first, then diverse feasible elites with small legal equipment
  // moves, rerouting after each move so another layout basin can win.
  const refinementRounds = requestedIterations <= 0
    ? 0
    : localNeighborhoodOnly
      ? Math.max(1, Math.min(5, Math.ceil(requestedIterations / 16)))
      : options.request.frontageConstraint === "hard"
      ? Math.max(3, Math.min(4, Math.ceil(requestedIterations / 16)))
      : Math.max(1, Math.min(3, Math.ceil(requestedIterations / 16)));
  for (let round = 0; round < refinementRounds; round += 1) {
    const currentBest = best as RoutedLayoutCandidate | null;
    const refinementBases = currentBest !== null
      ? round === 0 || localNeighborhoodOnly
        ? [currentBest]
        : selectDiverseRoutedEliteBases(
            [...feasibleEliteArchive.values()],
            MAX_ELITE_REFINEMENT_BASES,
          )
      : hardFrontageRequired
      ? selectFrontageRepairBeam([...frontageRepairPool.values()], 4)
      : [];
    if (refinementBases.length === 0) break;
    const roundCandidateLimit = localNeighborhoodOnly
      ? refinementCandidateLimit
      : options.request.frontageConstraint === "hard"
      ? Math.max(12, refinementCandidateLimit)
      : refinementCandidateLimit;
    const perBaseBudgets = currentBest === null
      ? refinementBases.map(() => roundCandidateLimit)
      : allocateRefinementCandidateBudgets(roundCandidateLimit, refinementBases.length);
    if (currentBest !== null && round > 0) {
      alternativeRefinementBasesUsed += Math.max(0, refinementBases.length - 1);
    }
    for (const [baseIndex, refinementBase] of refinementBases.entries()) {
      const perBaseLimit = perBaseBudgets[baseIndex] ?? 0;
      if (perBaseLimit <= 0) continue;
      const neighborSet = createPackingNeighbors(
        refinementBase.packing,
        options.request.width,
        options.request.height,
        options.routingClearance,
        options.requests,
        options.registry,
        options.allowRotate,
        refinementBase.routing,
        localNeighborhoodOnly,
        cpSat?.enabled === true ? {
          maxSeconds: cpSat.maxSeconds ?? 2,
          candidateCount: cpSat.candidates ?? 4,
          seed: seed + round * 65_537,
          enableGlobalRebuild: round > 0 && baseIndex === 0,
          forbiddenLayouts: [...certifiedRouteFailureCuts.values()],
          capacityCuts: [...certifiedRouteCapacityCuts.values()],
        } : null,
      );
      clusterCandidatesGenerated += neighborSet.clusterGenerated;
      clusterCandidatesCheapRejected += neighborSet.clusterCheapRejected;
      globalRebuildCandidatesGenerated += neighborSet.globalRebuildGenerated;
      partialRebuildCandidatesGenerated += neighborSet.partialRebuildGenerated;
      globalRebuildCpSatElapsedMs += neighborSet.globalRebuildCpSatElapsedMs;
      neighborSet.objectiveHotspotDeviceIds.forEach((id) => objectiveHotspotDeviceIds.add(id));
      const unseenNeighbors = neighborSet.packings.filter((packing) => {
        const signature = packingSignature(packing);
        // The same equipment geometry may already have failed a cold full
        // reroute. An SCC translation from a complete routed base is a
        // different search state because unaffected connections are preserved,
        // so allow this bounded local repair to replay the geometry once.
        return (currentBest === null
          && (packing.debugLabel?.startsWith("local-scc-cluster:") === true
            || packing.debugLabel?.startsWith("local-scc-internal:") === true))
          || !seenPackings.has(signature);
      });
      const selectedNeighbors = selectRefinementNeighborBeam(unseenNeighbors, perBaseLimit)
        .sort((left, right) => currentBest === null
          ? Number(right.debugLabel?.startsWith(
              "local-scc-cluster:frontage-corridor:",
            ) === true)
            - Number(left.debugLabel?.startsWith(
              "local-scc-cluster:frontage-corridor:",
            ) === true)
          : 0);
      for (const packing of selectedNeighbors) {
        seenPackings.add(packingSignature(packing));
        evaluatePacking(
          packing,
          packing.debugLabel?.startsWith("global-rebuild:") === true
            ? undefined
            : refinementBase,
          packing.debugLabel?.startsWith("local-terminal-cluster:") === true
            ? Math.max(6, routingVariants)
            : routingVariants,
        );
      }
    }
  }
  // Speculative line clearing must not compete with the normal local beam:
  // doing so can replace a proven compact trajectory with a cleaner but taller
  // intermediate layout. Keep one reusable strictly-area-improving transition
  // so it can run both before and after upstream equipment movement.
  const evaluateSpeculativeCompactionRound = (
    preserveContractedPaths = false,
    explicitBase?: RoutedLayoutCandidate,
  ): boolean => {
    const compactionBase = explicitBase ?? (best as RoutedLayoutCandidate | null);
    if (compactionBase === null) return false;
    const compactions = (["horizontal", "vertical"] as const)
      .flatMap((axis) => createSpeculativeAxisCutCompactions({
        axis,
        devices: compactionBase.packing.devices,
        routedConnections: compactionBase.routing.connections,
        limitWidth: options.request.width,
        limitHeight: options.request.height,
        maximumDistance: LOCAL_COMPACTION_POLICY.maximumCutDistance,
      }));
    clusterCandidatesGenerated += compactions.length;
    const compactionBeam = selectSpeculativeAxisCutCompactionBeam(
      compactions,
      LOCAL_COMPACTION_POLICY.speculativeCutBeam,
    );
    clusterCandidatesCheapRejected += Math.max(0, compactions.length - compactionBeam.length);
    const speculativePackings: PackingResult[] = [];
    for (const compaction of compactionBeam) {
      const moved = createMovedPacking(
        compactionBase.packing,
        compaction.devices,
        options.routingClearance,
      );
      const contracted = preserveContractedPaths
        ? contractRoutedConnectionsAcrossAxisCut({
            axis: compaction.axis,
            connections: compactionBase.routing.connections,
            devices: compaction.devices,
            movedDeviceIds: new Set(compaction.movedDeviceIds),
            cutCoordinate: compaction.cutCoordinate,
            distance: compaction.distance,
            limitWidth: options.request.width,
            limitHeight: options.request.height,
          })
        : null;
      const packing: PackingResult = {
        ...moved,
        debugLabel:
          `local-terminal-cluster:${preserveContractedPaths
            ? "path-fold-cut"
            : "speculative-cut"}:${compaction.axis}:${compaction.cutCoordinate}:`
            + `${compaction.distance}:${compaction.movedDeviceIds.length}`,
        evaluationKey: preserveContractedPaths
          ? `path-fold:${compaction.axis}:${packingSignature(moved)}`
          : undefined,
        preservationRoutingSeed: contracted === null
          ? undefined
          : {
              ...compactionBase.routing,
              connections: contracted.connections,
            },
        preservationForcedRipUpConnectionIds: contracted?.invalidConnectionIds,
      };
      const signature = packing.evaluationKey ?? packingSignature(packing);
      if (seenPackings.has(signature)) continue;
      seenPackings.add(signature);
      speculativePackings.push(packing);
    }
    for (const packing of speculativePackings) {
      evaluatePacking(
        packing,
        compactionBase,
        Math.max(LOCAL_COMPACTION_POLICY.minimumCutRoutingVariants, routingVariants),
      );
    }
    const nextBest = best as RoutedLayoutCandidate | null;
    return nextBest !== null
      && compareRoutedLayouts(nextBest, compactionBase) < 0;
  };
  // A physical row is an overlapping vertical band, not a set of equal-size
  // devices sharing exactly the same y coordinate. Power is deliberately
  // absent while moving equipment and routing; evaluatePacking places it again
  // only after logistics succeeds.
  const evaluateUpstreamMovementRound = (): boolean => {
    const upstreamBase = best as RoutedLayoutCandidate | null;
    if (upstreamBase === null) return false;
    const movements = createUpstreamRowMovementCandidates({
      devices: upstreamBase.packing.devices,
      routedConnections: upstreamBase.routing.connections,
      limitWidth: options.request.width,
      limitHeight: options.request.height,
      allowRotate: options.allowRotate,
    });
    const movementBeam = selectUpstreamRowMovementBeam({
      candidates: movements,
      routedConnections: upstreamBase.routing.connections,
      maximum: LOCAL_COMPACTION_POLICY.upstreamMovementBeam,
    });
    clusterCandidatesGenerated += movements.length;
    clusterCandidatesCheapRejected += Math.max(0, movements.length - movementBeam.length);
    for (const movement of movementBeam) {
      const moved = createMovedPacking(
        upstreamBase.packing,
        movement.devices,
        options.routingClearance,
      );
      const packing: PackingResult = {
        ...moved,
        debugLabel:
          `local-terminal-cluster:upstream-row:${movement.operation}:`
          + `${movement.rowDeviceIds.join(",")}:${movement.movedDeviceIds.join(",")}:`
          + `${movement.deltaX},${movement.deltaY},${movement.rotation}`,
      };
      const signature = packingSignature(packing);
      if (seenPackings.has(signature)) continue;
      seenPackings.add(signature);
      evaluatePacking(
        packing,
        upstreamBase,
        Math.max(LOCAL_COMPACTION_POLICY.minimumMovementRoutingVariants, routingVariants),
      );
    }
    const nextBest = best as RoutedLayoutCandidate | null;
    return nextBest !== null && compareRoutedLayouts(nextBest, upstreamBase) < 0;
  };

  // Global layer-width planning may place a terminal in the physical band of
  // one direct-upstream row. This changes layer membership, so it is excluded
  // from scope=local. A necessary frontage-width proof runs before placements
  // or A*, and the storage sidecar moves in the same globally routed candidate.
  const evaluateGlobalLayerInterlockRound = (): {
    readonly improved: boolean;
    readonly generated: number;
    readonly widthRejected: number;
  } => {
    const interlockBase = best as RoutedLayoutCandidate | null;
    if (interlockBase === null) return { improved: false, generated: 0, widthRejected: 0 };
    const candidateSet = createGlobalLayerInterlockCandidates({
      devices: interlockBase.packing.devices,
      requests: options.requests,
      routedConnections: interlockBase.routing.connections,
      limitWidth: options.request.width,
      limitHeight: options.request.height,
      allowRotate: options.allowRotate,
    });
    const interlocks = candidateSet.candidates;
    const interlockBeam = selectTerminalRowInterlockBeam({
      candidates: interlocks,
      routedConnections: interlockBase.routing.connections,
      maximum: GLOBAL_LAYER_INTERLOCK_POLICY.terminalRowInterlockBeam,
    });
    globalLayerInterlockCandidatesGenerated += interlocks.length;
    globalLayerInterlockWidthRejected += candidateSet.widthRejected;
    clusterCandidatesGenerated += interlocks.length + candidateSet.widthRejected;
    clusterCandidatesCheapRejected += candidateSet.widthRejected
      + Math.max(0, interlocks.length - interlockBeam.length);
    for (const interlock of interlockBeam) {
      const moved = createMovedPacking(
        interlockBase.packing,
        interlock.devices,
        options.routingClearance,
      );
      const packing: PackingResult = {
        ...moved,
        debugLabel:
          `global-layer-interlock:${interlock.terminalDeviceId}:`
          + `${interlock.rowDeviceIds.join(",")}:${interlock.side}:`
          + `${interlock.rotation}:${interlock.alignment}:`
          + `${interlock.storageDeviceId ?? "none"}:`
          + `width=${interlock.widthFeasibility?.requiredWidth ?? "unknown"}/`
          + `${interlock.widthFeasibility?.frontageWidth ?? "unknown"}:`
          + `offset=${interlock.rowDeviceOffsets.map((offset) =>
            `${offset.deviceId}@${offset.deltaX},${offset.deltaY}`).join(";") || "none"}`,
      };
      const signature = packingSignature(packing);
      if (seenPackings.has(signature)) continue;
      seenPackings.add(signature);
      evaluatePacking(
        packing,
        interlockBase,
        Math.max(LOCAL_COMPACTION_POLICY.minimumMovementRoutingVariants, routingVariants),
      );
    }
    const nextBest = best as RoutedLayoutCandidate | null;
    return {
      improved: nextBest !== null && compareRoutedLayouts(nextBest, interlockBase) < 0,
      generated: interlocks.length,
      widthRejected: candidateSet.widthRejected,
    };
  };

  // Storage is part of the physical outline, not a permanent anchor. Give it
  // an independent routed neighborhood after upstream equipment settles so a
  // stale terminal pose cannot keep an otherwise removable perimeter loop.
  const evaluateEdgeStorageMovementRound = (): boolean => {
    const storageBase = best as RoutedLayoutCandidate | null;
    if (storageBase === null) return false;
    const movements = createEdgeStorageMovementCandidates({
      devices: storageBase.packing.devices,
      routedConnections: storageBase.routing.connections,
      limitWidth: options.request.width,
      limitHeight: options.request.height,
      allowRotate: options.allowRotate,
    });
    const movementBeam = selectEdgeStorageMovementBeam({
      candidates: movements,
      maximum: LOCAL_COMPACTION_POLICY.edgeStorageMovementBeam,
    });
    clusterCandidatesGenerated += movements.length;
    clusterCandidatesCheapRejected += Math.max(0, movements.length - movementBeam.length);
    for (const movement of movementBeam) {
      const moved = createMovedPacking(
        storageBase.packing,
        movement.devices,
        options.routingClearance,
      );
      const packing: PackingResult = {
        ...moved,
        debugLabel:
          `local-terminal-cluster:edge-storage:${movement.storageDeviceId}:`
          + `${movement.deltaX},${movement.deltaY},${movement.rotation}`,
      };
      const signature = packingSignature(packing);
      if (seenPackings.has(signature)) continue;
      seenPackings.add(signature);
      evaluatePacking(
        packing,
        storageBase,
        Math.max(LOCAL_COMPACTION_POLICY.minimumMovementRoutingVariants, routingVariants),
      );
    }
    const nextBest = best as RoutedLayoutCandidate | null;
    return nextBest !== null && compareRoutedLayouts(nextBest, storageBase) < 0;
  };

  // Fixed equipment does not imply fixed logistics. Recompute congested port
  // neighborhoods after every successful routing refinement; a changed port
  // assignment can expose another strictly better neighborhood on the same
  // geometry.
  const evaluateFixedRoutingPolishRound = (): boolean => {
    const routingBase = best as RoutedLayoutCandidate | null;
    if (routingBase === null || !topologySequentialOnly) return false;
    const fixedRoutingCandidates = createFixedDeviceRoutingRefinements({
      request: options.request,
      registry: options.registry,
      requests: options.requests,
      productionDevices: routingBase.packing.devices,
      productionEntities: createEntities(options.requests, routingBase.packing.devices),
      routing: routingBase.routing,
      enforceFrontageConstraint: hardFrontageRequired,
      maximumNeighborhoods: 4,
      maximumConnectionsPerNeighborhood: 12,
    });
    for (const polishedRouting of fixedRoutingCandidates) {
      routedCandidates += 1;
      const powerPlacement = placePowerDiffusers({
        placeableDevices: routingBase.packing.devices,
        occupiedDevices: [...routingBase.packing.devices, ...polishedRouting.devices],
        requests: options.requests,
        registry: options.registry,
        limitWidth: options.request.width,
        limitHeight: options.request.height,
      });
      if (powerPlacement === null) continue;
      const powerDevices = powerPlacement.devices;
      const allDevices = [
        ...routingBase.packing.devices,
        ...polishedRouting.devices,
        ...powerDevices,
      ];
      const areaDevices = allDevices.filter((device) =>
        device.kind !== "warehouse-bus"
        && (
          device.kind !== "belt"
          || !polishedRouting.areaExcludedDeviceIds.has(device.id)
        ));
      const bounds = measureFactoryFootprintBounds(areaDevices);
      const physicalBounds = measureFactoryFootprintBounds(allDevices);
      const contourArea = measureConvexContourArea(areaDevices);
      const areaCompactness = measureLayoutCompactness(areaDevices);
      const contourCompactness = areaCompactness;
      const candidate: RoutedLayoutCandidate = {
        packing: routingBase.packing,
        productionEntities: {
          ...createEntities(options.requests, routingBase.packing.devices),
          ...createEntities(options.requests, powerDevices),
        },
        routing: polishedRouting,
        allDevices,
        bounds,
        contourArea,
        contourVoidArea: Math.max(0, contourArea - contourCompactness.occupiedCellCount),
        boundingVoidCellCount: areaCompactness.boundingVoidCellCount,
        enclosedVoidCellCount: contourCompactness.enclosedVoidCellCount,
        frontageOverflowCellCount: measureFrontageOverflowCells(areaDevices),
        minimumPowerDeviceCount: powerPlacement.minimumRequiredCount,
        equipmentArea: areaDevices.reduce(
          (sum, device) => sum + device.width * device.height,
          0,
        ),
        physicalBounds,
      };
      if (
        (!hardFrontageRequired || candidate.frontageOverflowCellCount === 0)
        && compareRoutedLayouts(candidate, best as RoutedLayoutCandidate) < 0
      ) {
        best = candidate;
      }
    }
    const nextBest = best as RoutedLayoutCandidate | null;
    return nextBest !== null && compareRoutedLayouts(nextBest, routingBase) < 0;
  };

  // Close the complete local neighborhood instead of assigning unrelated hard
  // round counts to its phases. Each accepted transition is a strict
  // lexicographic improvement. Path contraction is attempted before the cold
  // variants for the same geometry; both remain in the quality comparison, so
  // route preservation is an execution shortcut rather than a search-space
  // restriction. The integer search box
  // supplies a deterministic safety bound; ordinary termination is the first
  // complete pass with no accepted transition.
  const closeLocalNeighborhood = (): void => {
    const maximumConvergencePasses = Math.max(
      1,
      options.request.width + options.request.height,
    );
    localConvergenceStoppedBy = "safety-bound";
    for (let pass = 0; pass < maximumConvergencePasses; pass += 1) {
      localConvergencePasses += 1;
      const passBase = best as RoutedLayoutCandidate | null;
      if (passBase === null) break;

      // A successful cut can expose the next cut, so normalize cuts to their
      // own fixed point before changing equipment coordinates.
      for (let cutRound = 0; cutRound < maximumConvergencePasses; cutRound += 1) {
        if (evaluateProvenStraightCutRound()) {
          localConvergenceTransitions += 1;
          continue;
        }
        const sectionBase = best as RoutedLayoutCandidate | null;
        if (sectionBase === null) break;
        // Preservation is the fast feasibility witness, but the cold variants
        // for exactly the same equipment geometry still compete on port and
        // route quality. Shared all-ripped failures make this complete
        // evaluation cheaper without deleting any candidate state.
        evaluateSpeculativeCompactionRound(true, sectionBase);
        evaluateSpeculativeCompactionRound(false, sectionBase);
        const sectionBest = best as RoutedLayoutCandidate | null;
        if (sectionBest !== null && compareRoutedLayouts(sectionBest, sectionBase) < 0) {
          localConvergenceTransitions += 1;
          continue;
        }
        break;
      }

      if (evaluateUpstreamMovementRound()) localConvergenceTransitions += 1;
      if (evaluateEdgeStorageMovementRound()) localConvergenceTransitions += 1;
      if (evaluateFixedRoutingPolishRound()) localConvergenceTransitions += 1;

      const passBest = best as RoutedLayoutCandidate | null;
      if (passBest === null || compareRoutedLayouts(passBest, passBase) >= 0) {
        localConvergenceStoppedBy = "fixed-point";
        break;
      }
    }
  };
  if (requestedIterations > 0) {
    // Both scopes receive the same strict local closure. Global search then
    // starts from that fixed point instead of hiding a cross-layer mutation in
    // the local result.
    closeLocalNeighborhood();
  }
  if (!localOnly && requestedIterations > 0) {
    globalLayerInterlockStoppedBy = "safety-bound";
    for (
      let pass = 0;
      pass < GLOBAL_LAYER_INTERLOCK_POLICY.maximumPasses;
      pass += 1
    ) {
      globalLayerInterlockPasses += 1;
      const outcome = evaluateGlobalLayerInterlockRound();
      if (!outcome.improved) {
        globalLayerInterlockStoppedBy = outcome.generated === 0 && outcome.widthRejected > 0
          ? "width-infeasible"
          : "fixed-point";
        break;
      }
      globalLayerInterlockTransitions += 1;
      // Re-run the generic local closure after each accepted layer jump. It
      // may remove newly straight belt cuts, settle edge storage, and repack
      // power without permitting another topology-layer change.
      closeLocalNeighborhood();
    }
  }
  const selected = best as RoutedLayoutCandidate | null;
  if (selected !== null) {
    // Assignments happen inside evaluatePacking; retain the declared union at this boundary.
    const selectedRouteFailure = bestRouteFailure as {
      readonly progress: number;
      readonly evidence: RouteFailureEvidence;
    } | null;
    return {
      ...selected,
      search: {
        algorithm: packingCandidateSet.cpSatCandidateCount > 0
          ? "hybrid-cp-sat-lns-a-star"
          : "deterministic-lns-a-star",
        initialLayout,
        scope: optimizationScope,
        globalNeighborhoods,
        seed,
        requestedIterations,
        packingCandidates: evaluatedPackings,
        routedCandidates,
        powerInfeasibleCandidates,
        routingVariants,
        effectiveRoutingVariants,
        adaptiveCandidatesEvaluated,
        adaptiveRoutingAttempts,
        eliteStatesRetained: feasibleEliteArchive.size,
        eliteArchiveMaxDistance: measureEliteArchiveMaxDistance([...feasibleEliteArchive.values()]),
        alternativeRefinementBasesUsed,
        globalRebuildCandidatesGenerated,
        globalRebuildCandidatesRouted,
        globalRebuildCandidatesImproved,
        certifiedRouteFailureCutsLearned: certifiedRouteFailureCuts.size,
        certifiedRouteCapacityCutsLearned: certifiedRouteCapacityCuts.size,
        partialRebuildCandidatesGenerated,
        partialRebuildCandidatesRouted,
        partialRebuildCandidatesImproved,
        globalRebuildCpSatElapsedMs,
        globalLayerInterlockCandidatesGenerated,
        globalLayerInterlockWidthRejected,
        globalLayerInterlockCandidatesRouted,
        globalLayerInterlockCandidatesImproved,
        globalLayerInterlockPasses,
        globalLayerInterlockTransitions,
        globalLayerInterlockStoppedBy,
        objectiveHotspotDeviceIds: [...objectiveHotspotDeviceIds].sort(),
        cpSatCandidates: packingCandidateSet.cpSatCandidateCount,
        initialCandidatesGenerated,
        initialCandidatesSelected,
        warehouseCandidatesGenerated,
        warehouseCandidatesSelected,
        clusterCandidatesGenerated,
        clusterCandidatesCheapRejected,
        clusterCandidatesRouted,
        clusterCandidatesAStarRejected,
        clusterCandidatesImproved,
        routingVariantAttempts,
        localAreaLowerBoundRejected,
        localRepairAttempts,
        localFullRerouteAttempts,
        localFullRipFailureStatesReused,
        localConvergencePasses,
        localConvergenceTransitions,
        localConvergenceStoppedBy,
        localRoutingVariantsSkippedAfterSuccess,
        relaxedConnectivityRejectedPortPairs,
        seededInitialCandidatesRanked,
        seededInitialCandidatesPolished,
        seededInitialColdVariantsSkipped,
        cpSatStatus: packingCandidateSet.cpSatStatus,
        cpSatPythonVersion: packingCandidateSet.cpSatPythonVersion,
        cpSatOrToolsVersion: packingCandidateSet.cpSatOrToolsVersion,
        cpSatBudgetSeconds: packingCandidateSet.cpSatBudgetSeconds,
        cpSatAttemptedCandidates: packingCandidateSet.cpSatAttemptedCandidates,
        cpSatStoppedBy: packingCandidateSet.cpSatStoppedBy,
        cpSatElapsedMs: packingCandidateSet.cpSatElapsedMs,
        objective: {
          priorities: DEFAULT_LAYOUT_OBJECTIVE.priorities,
          vector: buildRoutedObjectiveVector(selected),
        },
      },
      routeFailureDiagnostics: selectedRouteFailure === null ? [] : [selectedRouteFailure.evidence],
    };
  }
  if (hardFrontageRequired && best === null
    && frontageRepairPool.size > 0) {
    const closest = selectFrontageRepairBeam([...frontageRepairPool.values()], 1)[0]!;
    const overflowingDeviceIds = listFrontageOverflowDeviceIds(closest.allDevices);
    const hardFailure = frontagePackingFailures.get(packingSignature(closest.packing));
    const hardFailureLabel = hardFailure === undefined
      ? "none"
      : `${hardFailure.evidence.sourceDeviceId ?? "boundary"}->`
        + `${hardFailure.evidence.targetDeviceId ?? "boundary"}`
        + `:${hardFailure.evidence.itemId}@${hardFailure.progress}`;
    throw new Error(
      `Unable to satisfy warehouse frontage hard constraint; closest routed layout has `
      + `${closest.frontageOverflowCellCount} occupied cells outside the unloader span `
      + `(devices: ${overflowingDeviceIds.join(", ") || "unknown"}; `
      + `hard route failure: ${hardFailureLabel})`,
    );
  }
  if (powerInfeasibleCandidates > 0) {
    throw new Error(
      `Material routing succeeded for ${powerInfeasibleCandidates} candidate layouts, `
      + `but none left a non-overlapping power-diffuser placement covering every powered device`,
    );
  }
  if (routingError !== null) throw routingError;
  const productionArea = options.requests.reduce(
    (sum, request) => sum + request.definition.footprint.width * request.definition.footprint.height,
    0,
  );
  throw new Error(
    `Unable to fit ${options.requests.length} devices (${productionArea} occupied cells) `
    + `within search bounds ${options.request.width}x${options.request.height}; `
    + `search bounds are not measured factory dimensions`,
  );
}

function createPackingCandidates(
  requests: readonly DeviceRequest[],
  registry: RegistryContract,
  limitWidth: number,
  limitHeight: number,
  allowRotate: boolean,
  routingClearance: number,
  searchIterations: number,
  searchSeed: number,
  cpSat: NonNullable<HeadlessOptimizationRequest["search"]>["cpSat"],
): PackingCandidateSet {
  if (requests.length === 0) {
    return {
      packings: [{ devices: [], usedWidth: 0, usedHeight: 0, equipmentArea: 0 }],
      cpSatCandidateCount: 0,
      cpSatStatus: "disabled",
    };
  }
  const orderings = buildOrderings(requests, searchIterations, searchSeed);
  const candidates = new Map<string, PackingResult>();
  const clustered = packInTerminalClusters(
    requests,
    limitWidth,
    limitHeight,
    allowRotate,
    routingClearance,
  );
  if (clustered !== null) candidates.set(packingSignature(clustered), clustered);
  const layerClearances = [
    { horizontal: 0, vertical: 1 },
    { horizontal: 0, vertical: routingClearance },
    { horizontal: 1, vertical: 1 },
    { horizontal: routingClearance, vertical: routingClearance },
  ].filter((candidate, index, all) => all.findIndex((other) =>
    other.horizontal === candidate.horizontal && other.vertical === candidate.vertical) === index);
  for (const deviceClearance of layerClearances) {
    const layered = packInFlowLayers(
      requests,
      limitWidth,
      limitHeight,
      allowRotate,
      routingClearance,
      deviceClearance,
    );
    if (layered !== null) candidates.set(packingSignature(layered), layered);
  }
  for (const ordering of orderings) {
    const deviceClearances = [...new Set([0, Math.min(1, routingClearance), routingClearance])];
    for (const deviceClearance of deviceClearances) {
      for (let placementVariant = 0; placementVariant < 4; placementVariant += 1) {
        const candidate = packInOrder(
          ordering,
          registry,
          limitWidth,
          limitHeight,
          allowRotate,
          routingClearance,
          deviceClearance,
          placementVariant,
        );
        if (candidate !== null) {
          candidates.set(packingSignature(candidate), candidate);
        }
      }
    }
  }
  let cpSatCandidateCount = 0;
  let cpSatStatus: CpSatStatus = "disabled";
  let cpSatPythonVersion: string | undefined;
  let cpSatOrToolsVersion: string | undefined;
  let cpSatBudgetSeconds: number | undefined;
  let cpSatAttemptedCandidates: number | undefined;
  let cpSatStoppedBy: CpSatStopReason | undefined;
  let cpSatElapsedMs: number | undefined;
  if (cpSat?.enabled === true) {
    const cpSatResult = createCpSatPackingCandidates({
      requests,
      registry,
      limitWidth,
      limitHeight,
      allowRotate,
      routingClearance,
      maxSeconds: cpSat.maxSeconds ?? 2,
      candidateCount: cpSat.candidates ?? 4,
      seed: searchSeed,
    });
    cpSatStatus = cpSatResult.status;
    cpSatPythonVersion = cpSatResult.pythonVersion;
    cpSatOrToolsVersion = cpSatResult.orToolsVersion;
    cpSatBudgetSeconds = cpSatResult.budgetSeconds;
    cpSatAttemptedCandidates = cpSatResult.attemptedCandidates;
    cpSatStoppedBy = cpSatResult.stoppedBy;
    cpSatElapsedMs = cpSatResult.elapsedMs;
    for (const candidate of cpSatResult.packings) {
      const signature = packingSignature(candidate);
      if (candidates.has(signature)) continue;
      candidates.set(signature, candidate);
      cpSatCandidateCount += 1;
    }
  }
  return {
    packings: [...candidates.values()].sort(comparePacking),
    cpSatCandidateCount,
    cpSatStatus,
    cpSatPythonVersion,
    cpSatOrToolsVersion,
    cpSatBudgetSeconds,
    cpSatAttemptedCandidates,
    cpSatStoppedBy,
    cpSatElapsedMs,
  };
}

function createCpSatPackingCandidates(options: {
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
  readonly routingClearance: number;
  readonly maxSeconds: number;
  readonly candidateCount: number;
  readonly seed: number;
}): {
  readonly packings: readonly PackingResult[];
  readonly status: CpSatStatus;
  readonly pythonVersion?: string;
  readonly orToolsVersion?: string;
  readonly budgetSeconds: number;
  readonly attemptedCandidates?: number;
  readonly stoppedBy?: CpSatStopReason;
  readonly elapsedMs?: number;
} {
  const requestsById = new Map(options.requests.map((request) => [request.id, request]));
  const flowEdges = createCpSatFlowEdges(options.requests, options.registry);
  const budgetSeconds = Math.max(0.1, Math.min(30, options.maxSeconds));
  const cpSatResult = solveCpSatLayouts({
    devices: options.requests.map((request) => ({
      id: request.id,
      width: request.definition.footprint.width,
      height: request.definition.footprint.height,
      portRequirements: createCpSatPortRequirements(request, flowEdges),
    })),
    edges: flowEdges,
    clusters: createCpSatFlowClusters(options.requests),
    limitWidth: options.limitWidth,
    limitHeight: options.limitHeight,
    routingClearance: options.routingClearance,
    allowRotate: options.allowRotate,
    maxSeconds: budgetSeconds,
    candidateCount: Math.max(1, Math.min(12, Math.trunc(options.candidateCount))),
    seed: options.seed,
    objectiveWeights: DEFAULT_CP_SAT_OBJECTIVE_WEIGHTS,
  });
  const packings = cpSatResult.layouts.flatMap((layout, layoutIndex): PackingResult[] => {
    const devices = layout.flatMap((placement): HeadlessPlacedDevice[] => {
      const request = requestsById.get(placement.id);
      if (request === undefined) return [];
      return [toProductionDevice(request, placement.x, placement.y, {
        width: placement.width,
        height: placement.height,
        rotation: placement.rotation,
      })];
    });
    if (devices.length !== options.requests.length || !hasProductionClearance(devices, 0)) return [];
    const bounds = measureBounds(devices);
    return [{
      devices,
      usedWidth: bounds.width + options.routingClearance,
      usedHeight: bounds.height + options.routingClearance,
      equipmentArea: devices.reduce((sum, device) => sum + device.width * device.height, 0),
      debugLabel: `cp-sat:${layoutIndex}`,
    }];
  });
  return {
    packings,
    status: cpSatResult.status,
    pythonVersion: cpSatResult.pythonVersion,
    orToolsVersion: cpSatResult.orToolsVersion,
    budgetSeconds,
    attemptedCandidates: cpSatResult.attemptedCandidates,
    stoppedBy: cpSatResult.stoppedBy,
    elapsedMs: cpSatResult.elapsedMs,
  };
}

function createCpSatFlowClusters(requests: readonly DeviceRequest[]): CpSatLayoutCluster[] {
  return discoverFlowClusters(requests.map((request): FlowClusterNode => ({
    id: request.id,
    kind: request.kind,
    directProducerIds: request.warehouseProducerIds,
    inputItemIds: [...request.inputs.keys()],
    outputItemIds: [...request.outputs.keys()],
  }))).map((cluster): CpSatLayoutCluster => ({
    terminalId: cluster.terminalId,
    producerIds: cluster.directProducerIds,
    sharedUpstreamIds: cluster.sharedUpstreamIds,
  }));
}

export function discoverFlowClusters(nodes: readonly FlowClusterNode[]): FlowCluster[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return nodes.flatMap((terminal): FlowCluster[] => {
    if (terminal.kind !== "storage" || (terminal.directProducerIds?.length ?? 0) < 2) return [];
    const directProducerIds = [...new Set(terminal.directProducerIds)]
      .filter((id) => nodeById.get(id)?.kind === "production")
      .sort();
    if (directProducerIds.length < 2) return [];
    const clusterIds = new Set([terminal.id, ...directProducerIds]);
    const sharedUpstreamIds: string[] = [];
    for (let hop = 0; hop < MAX_FLOW_CLUSTER_UPSTREAM_HOPS; hop += 1) {
      const remainingCapacity = MAX_FLOW_CLUSTER_DEVICES - clusterIds.size;
      if (remainingCapacity <= 0) break;
      const additions = nodes
        .filter((candidate) => candidate.kind === "production" && !clusterIds.has(candidate.id))
        .map((candidate) => ({
          candidate,
          consumerCount: nodes.filter((consumer) => clusterIds.has(consumer.id)
            && candidate.outputItemIds.some((itemId) => consumer.inputItemIds.includes(itemId))).length,
        }))
        .filter(({ consumerCount }) => consumerCount >= 2)
        .sort((left, right) => right.consumerCount - left.consumerCount
          || left.candidate.id.localeCompare(right.candidate.id))
        .slice(0, remainingCapacity);
      if (additions.length === 0) break;
      for (const { candidate } of additions) {
        clusterIds.add(candidate.id);
        sharedUpstreamIds.push(candidate.id);
      }
    }
    return [{
      terminalId: terminal.id,
      directProducerIds,
      sharedUpstreamIds: sharedUpstreamIds.sort(),
      allDeviceIds: [...clusterIds].sort(),
    }];
  });
}

function createCpSatFlowEdges(
  requests: readonly DeviceRequest[],
  registry: RegistryContract,
): CpSatLayoutEdge[] {
  const edges = new Map<string, CpSatLayoutEdge>();
  const itemIds = new Set(requests.flatMap((request) => [
    ...request.inputs.keys(),
    ...request.outputs.keys(),
  ]));
  for (const itemId of [...itemIds].sort()) {
    const producers = requests
      .filter((request) => (request.outputs.get(itemId) ?? 0) > 0.000001)
      .map((request) => ({ request, remaining: request.outputs.get(itemId)! }))
      .sort((left, right) => left.request.id.localeCompare(right.request.id));
    const consumers = requests
      .filter((request) => (request.inputs.get(itemId) ?? 0) > 0.000001)
      .map((request) => ({ request, remaining: request.inputs.get(itemId)! }))
      .sort((left, right) => left.request.id.localeCompare(right.request.id));
    for (const consumer of consumers) {
      const orderedProducers = [...producers].sort((left, right) => {
        // Material IDs are allocated deterministically, one at a time. When a
        // previous material already established consumer -> producer, prefer
        // the reciprocal producer -> consumer assignment here. This turns a
        // balanced recipe cycle into small instance-level feedback motifs
        // instead of an arbitrary crossed ring, without knowing recipe names.
        const leftReciprocal = hasAllocatedReverseConnection(
          edges.values(),
          left.request.id,
          consumer.request.id,
        );
        const rightReciprocal = hasAllocatedReverseConnection(
          edges.values(),
          right.request.id,
          consumer.request.id,
        );
        return Number(rightReciprocal) - Number(leftReciprocal)
          || left.request.id.localeCompare(right.request.id);
      });
      for (const producer of orderedProducers) {
        if (consumer.remaining <= 0.000001) break;
        if (producer.remaining <= 0.000001) continue;
        const transferred = Math.min(consumer.remaining, producer.remaining);
        const key = `${itemId}:${producer.request.id}->${consumer.request.id}`;
        const previous = edges.get(key);
        const laneCount = resolveRequiredLogisticsLaneCount(
          transferred,
          resolveItemLogisticsKind(itemId, registry),
        );
        edges.set(key, {
          sourceId: producer.request.id,
          targetId: consumer.request.id,
          itemId,
          laneCount: (previous?.laneCount ?? 0) + laneCount,
          weight: (previous?.weight ?? 0) + Math.max(1, Math.ceil(transferred)),
          sourceEdges: resolveCpSatPortEdges(producer.request, "output"),
          targetEdges: resolveCpSatPortEdges(consumer.request, "input"),
        });
        producer.remaining -= transferred;
        consumer.remaining -= transferred;
      }
    }
  }
  return [...edges.values()];
}

function hasAllocatedReverseConnection(
  connections: Iterable<{ readonly sourceId: string; readonly targetId: string }>,
  sourceId: string,
  targetId: string,
): boolean {
  for (const connection of connections) {
    if (connection.sourceId === targetId && connection.targetId === sourceId) return true;
  }
  return false;
}

function resolveCpSatPortEdges(
  request: DeviceRequest,
  direction: "input" | "output",
): Readonly<Partial<Record<GridRotation, GridEdge>>> {
  const result: Partial<Record<GridRotation, GridEdge>> = {};
  for (const rotation of [0, 90, 180, 270] as const) {
    const edge = resolvePortEdge(request, direction, rotation);
    if (edge !== null) result[rotation] = edge;
  }
  return result;
}

function createCpSatPortRequirements(
  request: DeviceRequest,
  edges: readonly CpSatLayoutEdge[],
): CpSatLayoutPortRequirement[] {
  const counts = {
    input: edges
      .filter((edge) => edge.targetId === request.id)
      .reduce((sum, edge) => sum + edge.laneCount, 0),
    output: edges
      .filter((edge) => edge.sourceId === request.id)
      .reduce((sum, edge) => sum + edge.laneCount, 0),
  };
  return (["input", "output"] as const).flatMap((direction): CpSatLayoutPortRequirement[] => {
    if (counts[direction] === 0) return [];
    const ports = new Map<string, {
      readonly id: string;
      readonly offsets: Partial<Record<GridRotation, GridPoint>>;
      readonly escapeEdges: Partial<Record<GridRotation, GridEdge>>;
    }>();
    for (const rotation of [0, 90, 180, 270] as const) {
      const entity: WorldEntity = {
        id: `cp-port:${request.id}`,
        definitionId: request.definition.id,
        position: { x: 0, y: 0 },
        rotation,
        config: request.config,
        tags: [],
      };
      for (const kind of ["belt", "pipe"] as const) {
        for (const endpoint of resolveDevicePortEndpoints({
          entity,
          definition: request.definition,
          kind,
          direction,
          pointerGridPoint: entity.position,
        })) {
          const id = `${kind}:${endpoint.portGroupId}:${endpoint.portId}`;
          const port = ports.get(id) ?? { id, offsets: {}, escapeEdges: {} };
          port.offsets[rotation] = endpoint.outsideGridPoint;
          port.escapeEdges[rotation] = endpoint.edge;
          ports.set(id, port);
        }
      }
    }
    return [{
      direction,
      requiredCount: counts[direction],
      // One cell only proves that the port itself is exposed. A second cell
      // gives A* room to turn; multi-lane faces reserve one additional cell.
      escapeDepth: Math.min(3, counts[direction] > 1 ? 3 : 2),
      ports: [...ports.values()],
    }];
  });
}

function attachWarehouseLogistics(
  productionPacking: PackingResult,
  requests: readonly DeviceRequest[],
  registry: RegistryContract,
  limitWidth: number,
  limitHeight: number,
  _routingClearance: number,
): PackingResult | null {
  void _routingClearance;
  const productionDeviceById = new Map(productionPacking.devices.map((device) => [device.id, device]));
  const requestTargetX = (request: DeviceRequest): number => {
    const targetIds = request.warehouseProducerIds
      ?? (request.warehouseConsumerId === undefined ? [] : [request.warehouseConsumerId]);
    const targets = targetIds.flatMap((id) => {
      const device = productionDeviceById.get(id);
      return device === undefined ? [] : [device];
    });
    return targets.length === 0
      ? Number.MAX_SAFE_INTEGER
      : targets.reduce((sum, device) => sum + device.position.x + device.width / 2, 0) / targets.length;
  };
  const compareByConsumerX = (left: DeviceRequest, right: DeviceRequest): number => {
    const leftTargetX = requestTargetX(left);
    const rightTargetX = requestTargetX(right);
    return leftTargetX - rightTargetX || left.id.localeCompare(right.id);
  };
  const unloaders = requests
    .filter((request) => request.definition.id === "item_port_unloader_1")
    .sort(compareByConsumerX);
  const storageRequests = requests.filter((request) => request.kind === "storage").sort(compareByConsumerX);
  const preplacedStorageIds = new Set(storageRequests
    .filter((request) => productionDeviceById.has(request.id))
    .map((request) => request.id));
  const busSource = requests.find((request) => request.id === "warehouse-bus-source");
  const busSegments = requests.filter((request) => request.kind === "warehouse-bus" && request !== busSource);
  const bottomSegmentCount = Math.ceil(unloaders.length / 2);
  const requiredSegmentCount = bottomSegmentCount;
  if (busSource === undefined || busSegments.length < requiredSegmentCount) return null;
  const busLeft = busSource.definition.footprint.width;
  const requiredWidth = Math.max(storageRequests.length * 3, busLeft + bottomSegmentCount * 8);
  if (requiredWidth > limitWidth) return null;
  const warehouseConsumerIds = new Set(unloaders.flatMap((request) =>
    request.warehouseConsumerId === undefined ? [] : [request.warehouseConsumerId]));
  const requestById = new Map(requests.map((request) => [request.id, request]));
  // Storage used to reserve a fixed five-cell strip above every heuristic
  // packing. That made the whole production block taller before local search
  // even started. Storage is now placed by the same geometry/flow objective
  // below, so production keeps its compact packing coordinates.
  const productionOffsetY = 0;
  let devices = productionPacking.devices.map((device): HeadlessPlacedDevice => ({
    ...device,
    position: { x: device.position.x, y: device.position.y + productionOffsetY },
    rotation: warehouseConsumerIds.has(device.id) && device.width === device.height
      ? resolvePortFacingRotation(requestById.get(device.id), "input", "SOUTH") ?? device.rotation
      : device.rotation,
  }));
  if (unloaders.length === 1) {
    const unloaderFrontageX = busLeft;
    const unloaderFrontageWidth = unloaders[0]!.definition.footprint.width;
    const verticallyAnchored = devices.map((device): HeadlessPlacedDevice => ({
      ...device,
      position: {
        x: device.width <= unloaderFrontageWidth ? unloaderFrontageX : device.position.x,
        y: device.position.y,
      },
    }));
    // Flow-layer packings already carry the correct upstream/downstream Y
    // order. When their footprints do not collide, align the complete local
    // chain to the sole unloader frontage instead of turning it into a row.
    if (hasProductionClearance(verticallyAnchored, 0)) {
      const top = verticallyAnchored.reduce(
        (minimum, device) => Math.min(minimum, device.position.y),
        Number.POSITIVE_INFINITY,
      );
      devices = verticallyAnchored.map((device): HeadlessPlacedDevice => ({
        ...device,
        position: { x: device.position.x, y: device.position.y - top },
      }));
    }
  }
  const warehouseConsumers = devices
    .filter((device) => warehouseConsumerIds.has(device.id))
    .sort((left, right) => left.position.x - right.position.x || left.id.localeCompare(right.id));
  const otherProduction = devices.filter((device) => !warehouseConsumerIds.has(device.id));
  // These machines use north/south ports, so they may touch horizontally. The
  // two rows above them are a routed multi-lane output corridor, not an
  // equipment halo; A* needs both rows for this six-lane warehouse-fed group.
  const warehouseConsumerRowY = otherProduction.reduce(
    (maximum, device) => Math.max(maximum, device.position.y + device.height),
    productionOffsetY,
  ) + 2;
  let warehouseConsumerX = busLeft;
  const warehouseConsumerPositions = new Map<string, GridPoint>();
  for (const device of warehouseConsumers) {
    warehouseConsumerPositions.set(device.id, { x: warehouseConsumerX, y: warehouseConsumerRowY });
    warehouseConsumerX += device.width;
  }
  if (warehouseConsumerX - 1 > limitWidth) return null;
  devices = devices.map((device) => {
    const position = warehouseConsumerPositions.get(device.id);
    return position === undefined ? device : { ...device, position };
  });
  devices.forEach((device) => productionDeviceById.set(device.id, device));
  const warehouseConsumerRowHeight = warehouseConsumers.reduce(
    (maximum, device) => Math.max(maximum, device.height),
    0,
  );
  // The unloader frontage is the fixed local anchor. Production/storage move
  // around it; the warehouse bus is derived one row below the anchor.
  const unloaderAnchorY = warehouseConsumerRowY + warehouseConsumerRowHeight + 1;
  const bottomBusY = unloaderAnchorY + 1;
  if (bottomBusY + 4 > limitHeight) return null;
  let equipmentArea = productionPacking.equipmentArea;
  devices.push({
    id: busSource.id,
    definitionId: busSource.definition.id,
    kind: "warehouse-bus",
    recipeId: null,
    position: { x: 0, y: bottomBusY },
    rotation: 0,
    width: 4,
    height: 4,
  });
  equipmentArea += 16;
  let nextUnloaderX = busLeft;
  unloaders.forEach((request, index) => {
    const segmentIndex = Math.floor(index / 2);
    const segmentX = busLeft + segmentIndex * 8;
    const targetX = requestTargetX(request);
    const desiredX = !Number.isFinite(targetX) || targetX === Number.MAX_SAFE_INTEGER
      ? segmentX + (index % 2 === 0 ? 1 : 4)
      : Math.round(targetX - 1.5);
    const busRight = busLeft + bottomSegmentCount * 8;
    const portX = Math.max(busLeft, Math.min(busRight - 3, Math.max(desiredX, nextUnloaderX)));
    nextUnloaderX = portX + 3;
    devices.push({
      id: request.id,
      definitionId: request.definition.id,
      kind: "warehouse-port",
      recipeId: null,
      position: { x: portX, y: bottomBusY - 1 },
      rotation: 180,
      width: 3,
      height: 1,
    });
    equipmentArea += 3;
    if (index % 2 === 0) {
      const segment = busSegments[segmentIndex]!;
      devices.push({
        id: segment.id,
        definitionId: segment.definition.id,
        kind: "warehouse-bus",
        recipeId: null,
        position: { x: segmentX, y: bottomBusY },
        rotation: 90,
        width: 8,
        height: 4,
      });
      equipmentArea += 32;
    }
  });
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  for (const storage of storageRequests) {
    if (preplacedStorageIds.has(storage.id)) continue;
    const storageCandidates: Array<{
      readonly device: HeadlessPlacedDevice;
      readonly score: readonly number[];
    }> = [];
    for (const rotation of [0, 90, 180, 270] as const) {
      const swapsFootprint = rotation === 90 || rotation === 270;
      const width = swapsFootprint
        ? storage.definition.footprint.height
        : storage.definition.footprint.width;
      const height = swapsFootprint
        ? storage.definition.footprint.width
        : storage.definition.footprint.height;
      for (let y = 0; y + height <= limitHeight; y += 1) {
        for (let x = 0; x + width <= limitWidth; x += 1) {
          const device: HeadlessPlacedDevice = {
            id: storage.id,
            definitionId: storage.definition.id,
            kind: "storage",
            recipeId: null,
            position: { x, y },
            rotation,
            width,
            height,
          };
          const candidateDevices = [...devices, device];
          if (!hasProductionClearance(candidateDevices, 0)) continue;
          const bounds = measureBounds(candidateDevices);
          const compactness = measureLayoutCompactness(candidateDevices);
          const flowScore = measureFlowPlacementScore(
            storage,
            { x, y, width, height, rotation },
            devices,
            requestsById,
            registry,
          );
          storageCandidates.push({
            device,
            score: [
              // Port direction/corridor is a feasibility screen. Geometry then
              // decides among candidates with equally usable storage inputs.
              flowScore[0],
              bounds.width * bounds.height,
              measureConvexContourArea(candidateDevices),
              compactness.enclosedVoidCellCount,
              compactness.boundingVoidCellCount,
              flowScore[1],
              y,
              x,
              rotation,
            ],
          });
        }
      }
    }
    const selectedStorage = storageCandidates
      .sort((left, right) => compareScore(left.score, right.score))[0]?.device;
    if (selectedStorage === undefined) return null;
    devices.push(selectedStorage);
    equipmentArea += 9;
  }
  if (!hasProductionClearance(devices, 0)) return null;
  const bounds = measureBounds(devices);
  if (bounds.width > limitWidth || bounds.height > limitHeight) return null;
  return {
    devices,
    usedWidth: bounds.width,
    usedHeight: bounds.height,
    equipmentArea,
    debugLabel: productionPacking.debugLabel,
  };
}

export interface TopologyComponent {
  readonly deviceIds: readonly string[];
  readonly layer: number;
}

/**
 * Attach an exclusive exit branch to the feedback SCC that feeds it.
 *
 * The SCC remains the proof of cyclic feasibility, while the attached device
 * gives the packer enough context to place one recycling member and one output
 * member around the same fan-out hub. A branch is contracted only when all of
 * its inputs come from that SCC and it continues downstream; shared merges and
 * terminal consumers therefore retain their own topology components.
 */
export function mergeExclusiveFeedbackBranches(options: {
  readonly components: readonly TopologyComponent[];
  readonly edges: readonly { readonly sourceId: string; readonly targetId: string }[];
}): readonly TopologyComponent[] {
  const componentByDeviceId = new Map<string, TopologyComponent>();
  for (const component of options.components) {
    for (const deviceId of component.deviceIds) componentByDeviceId.set(deviceId, component);
  }
  const attachments = new Map<TopologyComponent, TopologyComponent[]>();
  const claimed = new Set<TopologyComponent>();
  for (const component of options.components) {
    if (component.deviceIds.length < 2) continue;
    const memberIds = new Set(component.deviceIds);
    const candidateTargets = [...new Set(options.edges
      .filter((edge) => memberIds.has(edge.sourceId) && !memberIds.has(edge.targetId))
      .map((edge) => edge.targetId))]
      .sort();
    for (const targetId of candidateTargets) {
      const targetComponent = componentByDeviceId.get(targetId);
      if (targetComponent === undefined
        || targetComponent.deviceIds.length !== 1
        || claimed.has(targetComponent)) continue;
      const incomingEdges = options.edges.filter((edge) => edge.targetId === targetId);
      if (incomingEdges.length === 0
        || incomingEdges.some((edge) => !memberIds.has(edge.sourceId))) continue;
      const hasFeedbackFanout = incomingEdges.some((incoming) =>
        options.edges.some((edge) =>
          edge.sourceId === incoming.sourceId && memberIds.has(edge.targetId))
        && options.edges.some((edge) =>
          memberIds.has(edge.sourceId) && edge.targetId === incoming.sourceId));
      if (!hasFeedbackFanout) continue;
      const continuesDownstream = options.edges.some((edge) =>
        edge.sourceId === targetId && !memberIds.has(edge.targetId));
      if (!continuesDownstream) continue;
      attachments.set(component, [...(attachments.get(component) ?? []), targetComponent]);
      claimed.add(targetComponent);
    }
  }
  return options.components.flatMap((component): TopologyComponent[] => {
    if (claimed.has(component)) return [];
    const attached = attachments.get(component) ?? [];
    if (attached.length === 0) return [component];
    return [{
      deviceIds: [...new Set([
        ...component.deviceIds,
        ...attached.flatMap((candidate) => candidate.deviceIds),
      ])].sort(),
      layer: Math.min(component.layer, ...attached.map((candidate) => candidate.layer)),
    }];
  });
}

function requiresIsolatedFeedbackFold(
  component: TopologyComponent,
  edges: readonly { readonly sourceId: string; readonly targetId: string }[],
): boolean {
  if (component.deviceIds.length < 3) return false;
  const memberIds = new Set(component.deviceIds);
  const internalEdges = edges.filter((edge) =>
    memberIds.has(edge.sourceId) && memberIds.has(edge.targetId));
  const successorIdsBySource = new Map<string, Set<string>>();
  for (const edge of internalEdges) {
    const targets = successorIdsBySource.get(edge.sourceId) ?? new Set<string>();
    targets.add(edge.targetId);
    successorIdsBySource.set(edge.sourceId, targets);
  }
  const hasReciprocalFanout = internalEdges.some((edge) =>
    (successorIdsBySource.get(edge.sourceId)?.size ?? 0) >= 2
    && internalEdges.some((reverse) =>
      reverse.sourceId === edge.targetId && reverse.targetId === edge.sourceId));
  const hasExternalExit = edges.some((edge) =>
    memberIds.has(edge.sourceId) && !memberIds.has(edge.targetId));
  return hasReciprocalFanout && hasExternalExit;
}

/**
 * Delay a warehouse-fed, single-successor branch to the shelf immediately
 * before its consumer. The abstract DAG keeps its earliest topological layer;
 * this placement layer removes avoidable bypass lanes without changing order.
 */
export function resolveWarehouseBranchPlacementLayers(options: {
  readonly components: readonly TopologyComponent[];
  readonly edges: readonly { readonly sourceId: string; readonly targetId: string }[];
  readonly warehouseSuppliedDeviceIds: ReadonlySet<string>;
}): ReadonlyMap<TopologyComponent, number> {
  const componentByDeviceId = new Map<string, TopologyComponent>();
  for (const component of options.components) {
    for (const deviceId of component.deviceIds) componentByDeviceId.set(deviceId, component);
  }
  return new Map(options.components.map((component) => {
    if (!component.deviceIds.every((deviceId) =>
      options.warehouseSuppliedDeviceIds.has(deviceId))) return [component, component.layer] as const;
    const successors = new Set(options.edges.flatMap((edge) => {
      if (!component.deviceIds.includes(edge.sourceId)) return [];
      const successor = componentByDeviceId.get(edge.targetId);
      return successor === undefined || successor === component ? [] : [successor];
    }));
    if (successors.size !== 1) return [component, component.layer] as const;
    const successor = [...successors][0]!;
    const desiredLayer = Math.max(component.layer, successor.layer - 1);
    const firstBlockingLayer = options.components
      .filter((candidate) => requiresIsolatedFeedbackFold(candidate, options.edges))
      .map((candidate) => candidate.layer)
      .filter((layer) => layer > component.layer && layer <= desiredLayer)
      .sort((left, right) => left - right)[0];
    return [
      component,
      firstBlockingLayer === undefined
        ? desiredLayer
        : Math.max(component.layer, firstBlockingLayer - 1),
    ] as const;
  }));
}

/** Find the nearest downstream fan-in (or terminal) that defines a supply lane's branch order. */
export function resolveNearestDownstreamMergeOrder(
  deviceId: string,
  edges: readonly { readonly sourceId: string; readonly targetId: string }[],
): { readonly anchorIds: readonly string[]; readonly depth: number } {
  const successorsById = new Map<string, Set<string>>();
  const predecessorsById = new Map<string, Set<string>>();
  for (const edge of edges) {
    const successors = successorsById.get(edge.sourceId) ?? new Set<string>();
    successors.add(edge.targetId);
    successorsById.set(edge.sourceId, successors);
    const predecessors = predecessorsById.get(edge.targetId) ?? new Set<string>();
    predecessors.add(edge.sourceId);
    predecessorsById.set(edge.targetId, predecessors);
  }
  const queue = [{ id: deviceId, depth: 0 }];
  const visitedDepthById = new Map<string, number>();
  const anchors = new Set<string>();
  let selectedDepth = Number.POSITIVE_INFINITY;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (current.depth > selectedDepth) continue;
    const visitedDepth = visitedDepthById.get(current.id);
    if (visitedDepth !== undefined && visitedDepth <= current.depth) continue;
    visitedDepthById.set(current.id, current.depth);
    const successors = [...(successorsById.get(current.id) ?? [])];
    const isMerge = (predecessorsById.get(current.id)?.size ?? 0) >= 2;
    if (isMerge || successors.length === 0) {
      if (current.depth < selectedDepth) {
        anchors.clear();
        selectedDepth = current.depth;
      }
      if (current.depth === selectedDepth) anchors.add(current.id);
      continue;
    }
    for (const successorId of successors) {
      queue.push({ id: successorId, depth: current.depth + 1 });
    }
  }
  return {
    anchorIds: [...anchors].sort((left, right) =>
      left.localeCompare(right, "en", { numeric: true })),
    depth: Number.isFinite(selectedDepth) ? selectedDepth : 0,
  };
}

export interface FoldableFeedbackCycleRoles {
  readonly fanoutHubId: string;
  readonly externalExitId: string;
  readonly returnMemberIds: readonly string[];
}

export interface FoldedFeedbackShelfNode {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface FoldedFeedbackShelfPlan {
  readonly height: number;
  readonly placements: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
  }[];
}

/**
 * Place one feedback hub at the upper left and an arbitrary number of return
 * members on right-aligned shelves. The function owns geometry only; graph
 * roles and device orientations are resolved before it is called.
 */
export function packFoldedFeedbackShelves(options: {
  readonly fanoutHub: FoldedFeedbackShelfNode;
  readonly returnMembers: readonly FoldedFeedbackShelfNode[];
  readonly frontageWidth: number;
}): FoldedFeedbackShelfPlan | null {
  const { fanoutHub, returnMembers, frontageWidth } = options;
  if (frontageWidth <= 0
    || fanoutHub.width <= 0
    || fanoutHub.height <= 0
    || fanoutHub.width > frontageWidth
    || returnMembers.length === 0
    || returnMembers.some((member) =>
      member.width <= 0 || member.height <= 0 || member.width > frontageWidth)) return null;
  const memberIds = [fanoutHub.id, ...returnMembers.map((member) => member.id)];
  if (new Set(memberIds).size !== memberIds.length) return null;

  const placements: FoldedFeedbackShelfPlan["placements"][number][] = [{
    id: fanoutHub.id,
    x: 0,
    y: 0,
  }];
  let shelfY = 0;
  let shelfHeight = fanoutHub.height;
  let shelfRight = frontageWidth;
  for (const member of returnMembers) {
    const leftBoundary = shelfY === 0 ? fanoutHub.width + 1 : 0;
    if (shelfRight - member.width < leftBoundary) {
      shelfY += shelfHeight + 1;
      shelfHeight = 0;
      shelfRight = frontageWidth;
    }
    const x = shelfRight - member.width;
    if (x < 0) return null;
    placements.push({ id: member.id, x, y: shelfY });
    shelfRight = x - 1;
    shelfHeight = Math.max(shelfHeight, member.height);
  }
  return {
    height: shelfY + shelfHeight,
    placements,
  };
}

/**
 * Enumerate deterministic corridor distributions for the same feedback shelf.
 * The edge-biased packing maximizes one continuous middle corridor, while the
 * balanced packing divides the same free cells between both outer edges and
 * internal gaps. Split corridors are important when several upstream lanes
 * must reach different downstream horizontal bands.
 */
export function enumerateFoldedFeedbackShelfPlans(options: {
  readonly fanoutHub: FoldedFeedbackShelfNode;
  readonly returnMembers: readonly FoldedFeedbackShelfNode[];
  readonly frontageWidth: number;
}): FoldedFeedbackShelfPlan[] {
  const packed = packFoldedFeedbackShelves(options);
  if (packed === null) return [];
  const nodeById = new Map(
    [options.fanoutHub, ...options.returnMembers].map((node) => [node.id, node]),
  );
  const balancedPlacements: FoldedFeedbackShelfPlan["placements"][number][] = [];
  const shelfYs = [...new Set(packed.placements.map((placement) => placement.y))]
    .sort((left, right) => left - right);
  for (const shelfY of shelfYs) {
    const row = packed.placements
      .filter((placement) => placement.y === shelfY)
      .sort((left, right) => left.x - right.x);
    const occupiedWidth = row.reduce(
      (sum, placement) => sum + nodeById.get(placement.id)!.width,
      0,
    );
    const freeWidth = options.frontageWidth - occupiedWidth;
    if (freeWidth < Math.max(0, row.length - 1)) return [packed];
    const gaps = Array.from({ length: row.length + 1 }, () => 0);
    const evenGap = Math.floor(freeWidth / gaps.length);
    gaps.fill(evenGap);
    let remaining = freeWidth - evenGap * gaps.length;
    const outsideInGapOrder: number[] = [];
    for (let inset = 0; outsideInGapOrder.length < gaps.length; inset += 1) {
      const left = inset;
      const right = gaps.length - 1 - inset;
      if (left <= right) outsideInGapOrder.push(left);
      if (right > left) outsideInGapOrder.push(right);
    }
    if (evenGap === 0) {
      for (let index = 1; index < gaps.length - 1; index += 1) {
        gaps[index] = 1;
        remaining -= 1;
      }
    }
    for (let index = 0; remaining > 0; index += 1) {
      gaps[outsideInGapOrder[index % outsideInGapOrder.length]!]! += 1;
      remaining -= 1;
    }
    let x = gaps[0]!;
    for (const [index, placement] of row.entries()) {
      balancedPlacements.push({ id: placement.id, x, y: shelfY });
      x += nodeById.get(placement.id)!.width + gaps[index + 1]!;
    }
  }
  const balanced: FoldedFeedbackShelfPlan = {
    height: packed.height,
    placements: balancedPlacements,
  };
  const signature = (plan: FoldedFeedbackShelfPlan): string =>
    plan.placements.map((placement) =>
      `${placement.id}@${placement.x},${placement.y}`).join("|");
  return signature(balanced) === signature(packed) ? [packed] : [balanced, packed];
}

/**
 * Enumerate feedback-cycle folds from graph structure and lane demand only.
 * Equal-scoring roles remain separate candidates, so deterministic ordering
 * never silently turns a device identifier into a placement decision.
 */
export function enumerateFoldableFeedbackCycles(options: {
  readonly deviceIds: readonly string[];
  readonly internalEdges: readonly {
    readonly sourceId: string;
    readonly targetId: string;
  }[];
  readonly externalOutgoingEdges: readonly {
    readonly sourceId: string;
    readonly laneCount: number;
  }[];
}): FoldableFeedbackCycleRoles[] {
  const deviceIds = [...new Set(options.deviceIds)].sort();
  if (deviceIds.length < 3) return [];
  const deviceIdSet = new Set(deviceIds);
  const successorIdsBySource = new Map(deviceIds.map((deviceId) => [
    deviceId,
    new Set<string>(),
  ]));
  for (const edge of options.internalEdges) {
    if (!deviceIdSet.has(edge.sourceId) || !deviceIdSet.has(edge.targetId)) continue;
    successorIdsBySource.get(edge.sourceId)!.add(edge.targetId);
  }
  const canReach = (
    sourceId: string,
    targetId: string,
  ): boolean => {
    const visited = new Set<string>();
    const pending = [sourceId];
    while (pending.length > 0) {
      const deviceId = pending.pop()!;
      if (visited.has(deviceId)) continue;
      if (deviceId === targetId) return true;
      visited.add(deviceId);
      pending.push(...(successorIdsBySource.get(deviceId) ?? []));
    }
    return false;
  };
  const maximumSuccessorCount = Math.max(
    0,
    ...[...successorIdsBySource.values()].map((successorIds) => successorIds.size),
  );
  if (maximumSuccessorCount < 2) return [];
  const fanoutHubIds = deviceIds.filter((deviceId) =>
    successorIdsBySource.get(deviceId)!.size === maximumSuccessorCount);
  const outgoingLaneCountBySource = new Map(deviceIds.map((deviceId) => [deviceId, 0]));
  for (const edge of options.externalOutgoingEdges) {
    if (!deviceIdSet.has(edge.sourceId)) continue;
    outgoingLaneCountBySource.set(
      edge.sourceId,
      outgoingLaneCountBySource.get(edge.sourceId)! + Math.max(0, edge.laneCount),
    );
  }
  return fanoutHubIds.flatMap((fanoutHubId) =>
    deviceIds
      .filter((deviceId) =>
        deviceId !== fanoutHubId
        && (outgoingLaneCountBySource.get(deviceId) ?? 0) > 0
        && canReach(fanoutHubId, deviceId))
      .sort((left, right) =>
        (outgoingLaneCountBySource.get(right) ?? 0)
          - (outgoingLaneCountBySource.get(left) ?? 0)
        || left.localeCompare(right))
      .flatMap((externalExitId): FoldableFeedbackCycleRoles[] => {
        const returnMemberIds = deviceIds.filter((deviceId) =>
          deviceId !== fanoutHubId && deviceId !== externalExitId);
        if (returnMemberIds.length === 0
          || returnMemberIds.some((deviceId) =>
            !canReach(fanoutHubId, deviceId) || !canReach(deviceId, fanoutHubId))) return [];
        return [{ fanoutHubId, externalExitId, returnMemberIds }];
      }));
}

/**
 * Backward-compatible strict classifier for callers that can consume only one
 * fold. Search code should prefer `enumerateFoldableFeedbackCycles`.
 */
export function identifyFoldableFeedbackCycle(options: Parameters<
  typeof enumerateFoldableFeedbackCycles
>[0]): FoldableFeedbackCycleRoles | null {
  const candidates = enumerateFoldableFeedbackCycles(options);
  const outgoingLaneCountBySource = new Map<string, number>();
  for (const edge of options.externalOutgoingEdges) {
    outgoingLaneCountBySource.set(
      edge.sourceId,
      (outgoingLaneCountBySource.get(edge.sourceId) ?? 0) + Math.max(0, edge.laneCount),
    );
  }
  const maximumOutgoingLaneCount = Math.max(
    0,
    ...candidates.map((candidate) =>
      outgoingLaneCountBySource.get(candidate.externalExitId) ?? 0),
  );
  const strongestCandidates = candidates.filter((candidate) =>
    outgoingLaneCountBySource.get(candidate.externalExitId) === maximumOutgoingLaneCount);
  return strongestCandidates.length === 1 ? strongestCandidates[0]! : null;
}

export interface TopologyLayerFeasibilityDiagnostic {
  readonly layer: number;
  readonly reason: "accepted" | "no-ready-component" | "frontage-capacity";
  readonly componentDeviceIds: readonly (readonly string[])[];
  readonly throughLaneCount: number;
  readonly reservedApproachLaneCount: number;
  readonly minimumOccupiedWidth: number;
  readonly requiredWidth: number;
  readonly frontageWidth: number;
}

export interface TopologyLayerFeasibilityResult {
  readonly feasible: boolean;
  readonly components: readonly TopologyComponent[];
  readonly diagnostics: readonly TopologyLayerFeasibilityDiagnostic[];
}

/**
 * Condense a geometry-free directed material graph into SCC nodes, then assign
 * every SCC its longest-path layer in the resulting DAG. Coordinates,
 * footprints, rotations and ports are deliberately absent from this phase.
 */
export function buildTopologyComponents(
  nodeIds: readonly string[],
  edges: readonly { readonly sourceId: string; readonly targetId: string }[],
): readonly TopologyComponent[] {
  const nodes = [...new Set(nodeIds)].sort();
  const nodeSet = new Set(nodes);
  const adjacency = new Map(nodes.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!nodeSet.has(edge.sourceId) || !nodeSet.has(edge.targetId)) continue;
    const targets = adjacency.get(edge.sourceId)!;
    if (!targets.includes(edge.targetId)) targets.push(edge.targetId);
  }
  adjacency.forEach((targets) => targets.sort());

  let nextIndex = 0;
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (id: string): void => {
    const index = nextIndex;
    nextIndex += 1;
    indexById.set(id, index);
    lowLinkById.set(id, index);
    stack.push(id);
    onStack.add(id);
    for (const targetId of adjacency.get(id) ?? []) {
      if (!indexById.has(targetId)) {
        visit(targetId);
        lowLinkById.set(id, Math.min(lowLinkById.get(id)!, lowLinkById.get(targetId)!));
      } else if (onStack.has(targetId)) {
        lowLinkById.set(id, Math.min(lowLinkById.get(id)!, indexById.get(targetId)!));
      }
    }
    if (lowLinkById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component.sort());
  };
  nodes.forEach((id) => {
    if (!indexById.has(id)) visit(id);
  });

  const componentIndexByNode = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    component.forEach((id) => componentIndexByNode.set(id, componentIndex));
  });
  const predecessors = components.map(() => new Set<number>());
  const successors = components.map(() => new Set<number>());
  for (const edge of edges) {
    const source = componentIndexByNode.get(edge.sourceId);
    const target = componentIndexByNode.get(edge.targetId);
    if (source === undefined || target === undefined || source === target) continue;
    successors[source]!.add(target);
    predecessors[target]!.add(source);
  }
  const indegree = predecessors.map((items) => items.size);
  const layers = components.map(() => 0);
  const ready = components
    .map((_, index) => index)
    .filter((index) => indegree[index] === 0)
    .sort((left, right) => components[left]![0]!.localeCompare(components[right]![0]!));
  while (ready.length > 0) {
    const componentIndex = ready.shift()!;
    for (const successor of successors[componentIndex]!) {
      layers[successor] = Math.max(layers[successor]!, layers[componentIndex]! + 1);
      indegree[successor] = indegree[successor]! - 1;
      if (indegree[successor] === 0) {
        ready.push(successor);
        ready.sort((left, right) =>
          components[left]![0]!.localeCompare(components[right]![0]!));
      }
    }
  }
  return components
    .map((deviceIds, componentIndex): TopologyComponent => ({
      deviceIds,
      layer: layers[componentIndex]!,
    }))
    .sort((left, right) =>
      left.layer - right.layer || left.deviceIds[0]!.localeCompare(right.deviceIds[0]!));
}

/**
 * Refine the geometry-free SCC DAG into capacity-aware construction layers.
 *
 * Longest-path layering alone can place unrelated source and feedback
 * components in the same level even when their combined footprint consumes the
 * complete warehouse frontage. This deterministic ready-set scheduler splits
 * such peers before coordinates are generated. A trial layer is admitted only
 * when its optimistic equipment span, unavoidable side-port approaches, and
 * lanes that must pass from an earlier layer to a later layer fit together.
 *
 * This is a necessary pre-routing proof, not a replacement for exact placement
 * or port-aware routing. The later Tetris construction still performs the
 * row-by-row geometric check with actual rectangles.
 */
export function designCapacityAwareTopologyLayers(options: {
  readonly components: readonly TopologyComponent[];
  readonly edges: readonly {
    readonly sourceId: string;
    readonly targetId: string;
    readonly laneCount: number;
  }[];
  readonly frontageWidth: number;
  readonly minimumHorizontalSpanByDeviceId: ReadonlyMap<string, number>;
  readonly minimumApproachLaneCountByDeviceId?: ReadonlyMap<string, number>;
  readonly preferredFirstDeviceIds?: ReadonlySet<string>;
}): TopologyLayerFeasibilityResult {
  const componentIndexByDeviceId = new Map<string, number>();
  options.components.forEach((component, componentIndex) => {
    component.deviceIds.forEach((deviceId) =>
      componentIndexByDeviceId.set(deviceId, componentIndex));
  });
  const predecessors = options.components.map(() => new Set<number>());
  const successors = options.components.map(() => new Set<number>());
  for (const edge of options.edges) {
    const sourceIndex = componentIndexByDeviceId.get(edge.sourceId);
    const targetIndex = componentIndexByDeviceId.get(edge.targetId);
    if (sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex) {
      continue;
    }
    predecessors[targetIndex]!.add(sourceIndex);
    successors[sourceIndex]!.add(targetIndex);
  }
  const componentMinimumSpan = (componentIndex: number): number => {
    const component = options.components[componentIndex]!;
    const widestMember = Math.max(
      0,
      ...component.deviceIds.map((deviceId) =>
        Math.max(
          0,
          options.minimumHorizontalSpanByDeviceId.get(deviceId)
            ?? options.frontageWidth + 1,
        )),
    );
    // A non-trivial SCC needs one feedback escape cell on each side in the
    // generic folded component box. This remains optimistic because members
    // may occupy different rows.
    return widestMember + Number(component.deviceIds.length > 1) * 2;
  };
  const componentApproachLanes = (componentIndex: number): number => {
    const component = options.components[componentIndex]!;
    // SCC members can be folded onto separate rows, so only the largest
    // unavoidable member reservation is simultaneous in the optimistic proof.
    return Math.max(
      0,
      ...component.deviceIds.map((deviceId) =>
        Math.max(
          0,
          options.minimumApproachLaneCountByDeviceId?.get(deviceId) ?? 0,
        )),
    );
  };
  const componentRequiresIsolatedFeedbackFold = (componentIndex: number): boolean =>
    requiresIsolatedFeedbackFold(options.components[componentIndex]!, options.edges);
  const preferred = options.preferredFirstDeviceIds ?? new Set<string>();
  const unscheduled = new Set(options.components.map((_, index) => index));
  const scheduled = new Set<number>();
  const assignedLayerByComponent = new Map<number, number>();
  const diagnostics: TopologyLayerFeasibilityDiagnostic[] = [];
  let layer = 0;
  const feedbackContinuationDistance = (componentIndex: number): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const [feedbackIndex, assignedLayer] of assignedLayerByComponent) {
      if (assignedLayer >= layer
        || !componentRequiresIsolatedFeedbackFold(feedbackIndex)) continue;
      const queue = [{ index: feedbackIndex, distance: 0 }];
      const visited = new Set<number>();
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor]!;
        if (visited.has(current.index) || current.distance >= best) continue;
        visited.add(current.index);
        if (current.index === componentIndex) {
          best = current.distance;
          break;
        }
        for (const successor of successors[current.index]!) {
          queue.push({ index: successor, distance: current.distance + 1 });
        }
      }
    }
    return best;
  };

  while (unscheduled.size > 0) {
    const ready = [...unscheduled]
      .filter((componentIndex) =>
        [...predecessors[componentIndex]!].every((predecessor) =>
          scheduled.has(predecessor)))
      .sort((left, right) => {
        const leftComponent = options.components[left]!;
        const rightComponent = options.components[right]!;
        // Once an isolated feedback fold has been placed, finish its newly
        // unlocked exit branch before starting another independent fold. This
        // keeps the fold -> exit connection local instead of forcing it to
        // cross the next full-frontage feedback box.
        const isNearFeedbackContinuation = (componentIndex: number): boolean => {
          const distance = feedbackContinuationDistance(componentIndex);
          return distance >= 1 && distance <= 2;
        };
        const continuationDifference = Number(isNearFeedbackContinuation(right))
          - Number(isNearFeedbackContinuation(left));
        if (continuationDifference !== 0) return continuationDifference;
        const leftPreferred = leftComponent.deviceIds.every((id) => preferred.has(id));
        const rightPreferred = rightComponent.deviceIds.every((id) => preferred.has(id));
        return Number(rightPreferred) - Number(leftPreferred)
          || leftComponent.layer - rightComponent.layer
          || componentMinimumSpan(right) - componentMinimumSpan(left)
          || leftComponent.deviceIds[0]!.localeCompare(rightComponent.deviceIds[0]!);
      });
    if (ready.length === 0) {
      diagnostics.push({
        layer,
        reason: "no-ready-component",
        componentDeviceIds: [...unscheduled]
          .map((index) => options.components[index]!.deviceIds),
        throughLaneCount: 0,
        reservedApproachLaneCount: 0,
        minimumOccupiedWidth: 0,
        requiredWidth: options.frontageWidth + 1,
        frontageWidth: options.frontageWidth,
      });
      return { feasible: false, components: options.components, diagnostics };
    }

    const layerComponents: number[] = [];
    let selectedMinimumOccupiedWidth = 0;
    let selectedApproachLaneCount = 0;
    let selectedThroughLaneCount = 0;
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;
      for (const componentIndex of ready) {
        if (layerComponents.includes(componentIndex)) continue;
        const trialComponents = [...layerComponents, componentIndex];
        if (trialComponents.length > 1
          && trialComponents.some(componentRequiresIsolatedFeedbackFold)) continue;
        const trialSet = new Set(trialComponents);
        const trialMinimumOccupiedWidth = trialComponents.reduce(
          (sum, index) => sum + componentMinimumSpan(index),
          0,
        );
        const trialApproachLaneCount = trialComponents.reduce(
          (sum, index) => sum + componentApproachLanes(index),
          0,
        );
        const trialThroughLaneCount = options.edges
          .filter((edge) => {
            const sourceIndex = componentIndexByDeviceId.get(edge.sourceId);
            const targetIndex = componentIndexByDeviceId.get(edge.targetId);
            return sourceIndex !== undefined
              && targetIndex !== undefined
              && scheduled.has(sourceIndex)
              && unscheduled.has(targetIndex)
              && !trialSet.has(targetIndex);
          })
          .reduce((sum, edge) => sum + Math.max(0, edge.laneCount), 0);
        const requiredWidth = trialMinimumOccupiedWidth
          + trialApproachLaneCount
          + trialThroughLaneCount;
        if (requiredWidth > options.frontageWidth) continue;
        layerComponents.push(componentIndex);
        selectedMinimumOccupiedWidth = trialMinimumOccupiedWidth;
        selectedApproachLaneCount = trialApproachLaneCount;
        selectedThroughLaneCount = trialThroughLaneCount;
        madeProgress = true;
      }
    }

    if (layerComponents.length === 0) {
      const strongestCandidate = ready
        .map((componentIndex) => {
          const trialSet = new Set([componentIndex]);
          const throughLaneCount = options.edges
            .filter((edge) => {
              const sourceIndex = componentIndexByDeviceId.get(edge.sourceId);
              const targetIndex = componentIndexByDeviceId.get(edge.targetId);
              return sourceIndex !== undefined
                && targetIndex !== undefined
                && scheduled.has(sourceIndex)
                && unscheduled.has(targetIndex)
                && !trialSet.has(targetIndex);
            })
            .reduce((sum, edge) => sum + Math.max(0, edge.laneCount), 0);
          const reservedApproachLaneCount = componentApproachLanes(componentIndex);
          const minimumOccupiedWidth = componentMinimumSpan(componentIndex);
          return {
            componentIndex,
            throughLaneCount,
            reservedApproachLaneCount,
            minimumOccupiedWidth,
            requiredWidth: throughLaneCount
              + reservedApproachLaneCount
              + minimumOccupiedWidth,
          };
        })
        .sort((left, right) => left.requiredWidth - right.requiredWidth
          || options.components[left.componentIndex]!.deviceIds[0]!.localeCompare(
            options.components[right.componentIndex]!.deviceIds[0]!,
          ))[0]!;
      diagnostics.push({
        layer,
        reason: "frontage-capacity",
        componentDeviceIds: [
          options.components[strongestCandidate.componentIndex]!.deviceIds,
        ],
        throughLaneCount: strongestCandidate.throughLaneCount,
        reservedApproachLaneCount: strongestCandidate.reservedApproachLaneCount,
        minimumOccupiedWidth: strongestCandidate.minimumOccupiedWidth,
        requiredWidth: strongestCandidate.requiredWidth,
        frontageWidth: options.frontageWidth,
      });
      return { feasible: false, components: options.components, diagnostics };
    }

    diagnostics.push({
      layer,
      reason: "accepted",
      componentDeviceIds: layerComponents.map((index) =>
        options.components[index]!.deviceIds),
      throughLaneCount: selectedThroughLaneCount,
      reservedApproachLaneCount: selectedApproachLaneCount,
      minimumOccupiedWidth: selectedMinimumOccupiedWidth,
      requiredWidth: selectedMinimumOccupiedWidth
        + selectedApproachLaneCount
        + selectedThroughLaneCount,
      frontageWidth: options.frontageWidth,
    });
    for (const componentIndex of layerComponents) {
      assignedLayerByComponent.set(componentIndex, layer);
      unscheduled.delete(componentIndex);
      scheduled.add(componentIndex);
    }
    layer += 1;
  }

  const components = options.components
    .map((component, componentIndex): TopologyComponent => ({
      deviceIds: component.deviceIds,
      layer: assignedLayerByComponent.get(componentIndex) ?? component.layer,
    }))
    .sort((left, right) =>
      left.layer - right.layer || left.deviceIds[0]!.localeCompare(right.deviceIds[0]!));
  return { feasible: true, components, diagnostics };
}

/**
 * Construct equipment from an empty, geometry-free material graph. Warehouse
 * ports form a horizontal frontage; all later rows are shelves inside exactly
 * that frontage width. Multiple alignments are construction variants of the
 * same frozen topology, not mutations of an earlier layout.
 */
function createTopologySequentialWarehousePackings(options: {
  readonly request: HeadlessOptimizationRequest;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
  readonly routingClearance: number;
}): PackingResult[] {
  const placeableRequests = options.requests.filter((request) =>
    request.kind === "production" || request.kind === "storage");
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const allocatedEdges = createCpSatFlowEdges(placeableRequests, options.registry);
  const supplyOrderMemo = new Map<string, {
    readonly rootIds: readonly string[];
    readonly depth: number;
  }>();
  const resolveSupplyOrder = (
    deviceId: string,
    visiting: ReadonlySet<string> = new Set(),
  ): { readonly rootIds: readonly string[]; readonly depth: number } => {
    const cached = supplyOrderMemo.get(deviceId);
    if (cached !== undefined) return cached;
    if (visiting.has(deviceId)) return { rootIds: [deviceId], depth: 0 };
    const predecessorIds = [...new Set(allocatedEdges
      .filter((edge) => edge.targetId === deviceId)
      .map((edge) => edge.sourceId))];
    if (predecessorIds.length === 0) {
      const result = { rootIds: [deviceId], depth: 0 } as const;
      supplyOrderMemo.set(deviceId, result);
      return result;
    }
    const nextVisiting = new Set(visiting).add(deviceId);
    const predecessors = predecessorIds.map((predecessorId) =>
      resolveSupplyOrder(predecessorId, nextVisiting));
    const result = {
      rootIds: [...new Set(predecessors.flatMap((predecessor) => predecessor.rootIds))]
        .sort((left, right) => left.localeCompare(right, "en", { numeric: true })),
      depth: 1 + Math.max(...predecessors.map((predecessor) => predecessor.depth)),
    };
    supplyOrderMemo.set(deviceId, result);
    return result;
  };
  const downstreamMergeOrderMemo = new Map<string, {
    readonly anchorIds: readonly string[];
    readonly depth: number;
  }>();
  const resolveDownstreamMergeOrder = (deviceId: string) => {
    const cached = downstreamMergeOrderMemo.get(deviceId);
    if (cached !== undefined) return cached;
    const result = resolveNearestDownstreamMergeOrder(deviceId, allocatedEdges);
    downstreamMergeOrderMemo.set(deviceId, result);
    return result;
  };
  const unloaders = options.requests
    .filter((request) => request.kind === "warehouse-port" && request.warehouseConsumerId !== undefined)
    // Generated IDs reach two digits on larger lines. Plain lexicographic
    // order places "...-10" between "...-1" and "...-2", which wraps one
    // supplied device back to the second frontage slot and forces otherwise
    // monotone material banks to cross. Order by the graph consumer first and
    // compare numeric runs naturally.
    .sort((left, right) => {
      const leftConsumerId = left.warehouseConsumerId ?? left.id;
      const rightConsumerId = right.warehouseConsumerId ?? right.id;
      const leftDemandOrder = resolveDownstreamMergeOrder(leftConsumerId);
      const rightDemandOrder = resolveDownstreamMergeOrder(rightConsumerId);
      const leftOrder = resolveSupplyOrder(leftConsumerId);
      const rightOrder = resolveSupplyOrder(rightConsumerId);
      return leftDemandOrder.anchorIds.join("\u0000").localeCompare(
        rightDemandOrder.anchorIds.join("\u0000"),
        "en",
        { numeric: true },
      )
        || leftDemandOrder.depth - rightDemandOrder.depth
        || leftOrder.rootIds.join("\u0000").localeCompare(
        rightOrder.rootIds.join("\u0000"),
        "en",
        { numeric: true },
      )
        || leftOrder.depth - rightOrder.depth
        || leftConsumerId.localeCompare(rightConsumerId, "en", { numeric: true })
        || left.id.localeCompare(right.id, "en", { numeric: true });
    });
  const busSource = options.requests.find((request) => request.id === "warehouse-bus-source");
  const busSegments = options.requests
    .filter((request) => request.kind === "warehouse-bus" && request.id !== "warehouse-bus-source")
    .sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }));
  if (placeableRequests.length === 0 || unloaders.length === 0 || busSource === undefined) return [];

  // Compatibility remains useful for recognizing roles inside a component,
  // but component membership must follow the already balanced instance flow.
  // Re-expanding equivalent cyclic machines to every compatible peer merges
  // independent feedback motifs and reintroduces crossed assignments that the
  // material allocator has explicitly eliminated.
  const logicalEdges = placeableRequests.flatMap((producer) =>
    placeableRequests.flatMap((consumer) =>
      producer.id !== consumer.id
      && [...producer.outputs.keys()].some((itemId) => consumer.inputs.has(itemId))
        ? [{ sourceId: producer.id, targetId: consumer.id }]
        : []));
  const initialComponents = mergeExclusiveFeedbackBranches({
    components: buildTopologyComponents(
      placeableRequests.map((request) => request.id),
      allocatedEdges,
    ),
    edges: allocatedEdges,
  });
  const suppliedIds = new Set(unloaders.flatMap((request) =>
    request.warehouseConsumerId === undefined ? [] : [request.warehouseConsumerId]));
  const rotations = options.allowRotate ? [0, 90, 180, 270] as const : [0] as const;
  const orientForSouthboundFlow = (
    request: DeviceRequest,
  ): { readonly width: number; readonly height: number; readonly rotation: GridRotation } => {
    const hasInput = request.inputs.size > 0;
    const hasOutput = request.outputs.size > 0;
    const rotation = [...rotations].sort((left, right) => {
      const score = (candidate: GridRotation): number =>
        Number(hasInput && resolvePortEdge(request, "input", candidate) !== "NORTH") * 4
        + Number(hasOutput && resolvePortEdge(request, "output", candidate) !== "SOUTH") * 4
        + candidate / 90;
      return score(left) - score(right);
    })[0]!;
    const swaps = rotation === 90 || rotation === 270;
    return {
      width: swaps ? request.definition.footprint.height : request.definition.footprint.width,
      height: swaps ? request.definition.footprint.width : request.definition.footprint.height,
      rotation,
    };
  };
  const orientForEastboundFlow = (
    request: DeviceRequest,
  ): { readonly width: number; readonly height: number; readonly rotation: GridRotation } => {
    const hasInput = request.inputs.size > 0;
    const hasOutput = request.outputs.size > 0;
    const rotation = [...rotations].sort((left, right) => {
      const score = (candidate: GridRotation): number =>
        Number(hasInput && resolvePortEdge(request, "input", candidate) !== "WEST") * 4
        + Number(hasOutput && resolvePortEdge(request, "output", candidate) !== "EAST") * 4
        + candidate / 90;
      return score(left) - score(right);
    })[0]!;
    const swaps = rotation === 90 || rotation === 270;
    return {
      width: swaps ? request.definition.footprint.height : request.definition.footprint.width,
      height: swaps ? request.definition.footprint.width : request.definition.footprint.height,
      rotation,
    };
  };
  const orientForNorthboundFlow = (
    request: DeviceRequest,
  ): { readonly width: number; readonly height: number; readonly rotation: GridRotation } => {
    const hasInput = request.inputs.size > 0;
    const hasOutput = request.outputs.size > 0;
    const rotation = [...rotations].sort((left, right) => {
      const score = (candidate: GridRotation): number =>
        Number(hasInput && resolvePortEdge(request, "input", candidate) !== "SOUTH") * 4
        + Number(hasOutput && resolvePortEdge(request, "output", candidate) !== "NORTH") * 4
        + candidate / 90;
      return score(left) - score(right);
    })[0]!;
    const swaps = rotation === 90 || rotation === 270;
    return {
      width: swaps ? request.definition.footprint.height : request.definition.footprint.width,
      height: swaps ? request.definition.footprint.width : request.definition.footprint.height,
      rotation,
    };
  };
  const unloaderOrientation = (() => {
    const request = unloaders[0]!;
    const rotation = rotations.find((candidate) =>
      resolvePortEdge(request, "output", candidate) === "SOUTH") ?? rotations[0]!;
    const swaps = rotation === 90 || rotation === 270;
    return {
      width: swaps ? request.definition.footprint.height : request.definition.footprint.width,
      height: swaps ? request.definition.footprint.width : request.definition.footprint.height,
      rotation,
    };
  })();
  const requiredBusSegments = Math.ceil(unloaders.length / 2);
  if (busSegments.length < requiredBusSegments) return [];
  const busSourceOrientation = { ...busSource.definition.footprint, rotation: 0 as const };
  const firstBusSegment = busSegments[0]!;
  const busSegmentOrientation = {
    width: firstBusSegment.definition.footprint.height,
    height: firstBusSegment.definition.footprint.width,
    rotation: 90 as const,
  };
  const busSegmentRowY = busSourceOrientation.height;
  const unloaderY = busSegmentRowY + busSegmentOrientation.height;
  const warehouseShellHeight = unloaderY + unloaderOrientation.height;
  const busWidth = requiredBusSegments * busSegmentOrientation.width;
  if (busWidth > options.limitWidth || warehouseShellHeight > options.limitHeight) return [];
  // Keep the actual port frontage contiguous. A port may overlap either half
  // of a connected eight-cell segment; forcing an artificial two-per-segment
  // slot pattern widens six ports from 18 to 22 cells for no physical reason.
  const unloaderXs = unloaders.map((_, index) => index * unloaderOrientation.width);
  const frontageStart = Math.min(...unloaderXs);
  const frontageEnd = Math.max(...unloaderXs.map((x) => x + unloaderOrientation.width));
  const frontageWidth = frontageEnd - frontageStart;
  const initialComponentByDeviceId = new Map<string, TopologyComponent>();
  initialComponents.forEach((component) =>
    component.deviceIds.forEach((deviceId) =>
      initialComponentByDeviceId.set(deviceId, component)));
  const layerPreferredOrientationByDeviceId = new Map<string, {
    readonly width: number;
    readonly height: number;
    readonly rotation: GridRotation;
  }>();
  const minimumHorizontalSpanByDeviceId = new Map<string, number>();
  const minimumApproachLaneCountByDeviceId = new Map<string, number>();
  for (const request of placeableRequests) {
    const component = initialComponentByDeviceId.get(request.id);
    const incomingLaneCount = allocatedEdges
      .filter((edge) =>
        edge.targetId === request.id
        && initialComponentByDeviceId.get(edge.sourceId) !== component)
      .reduce((sum, edge) => sum + edge.laneCount, 0);
    const outgoingLaneCount = allocatedEdges
      .filter((edge) =>
        edge.sourceId === request.id
        && initialComponentByDeviceId.get(edge.targetId) !== component)
      .reduce((sum, edge) => sum + edge.laneCount, 0);
    const orientationChoices = rotations.map((rotation) => {
      const swaps = rotation === 90 || rotation === 270;
      const width = swaps
        ? request.definition.footprint.height
        : request.definition.footprint.width;
      const height = swaps
        ? request.definition.footprint.width
        : request.definition.footprint.height;
      const inputEdge = resolvePortEdge(request, "input", rotation);
      const lateralTerminalFanIn = incomingLaneCount >= 2 && outgoingLaneCount === 0;
      const approachLaneCount =
        Number(
          incomingLaneCount > 0
          && (lateralTerminalFanIn
            ? inputEdge !== "EAST" && inputEdge !== "WEST"
            : inputEdge !== "NORTH"),
        ) * incomingLaneCount
        + Number(
          outgoingLaneCount > 0
          && resolvePortEdge(request, "output", rotation) !== "SOUTH",
        ) * outgoingLaneCount;
      return { rotation, width, height, approachLaneCount };
    }).sort((left, right) =>
      left.approachLaneCount - right.approachLaneCount
      || left.width - right.width
      || left.rotation - right.rotation);
    const optimisticOrientation = orientationChoices[0]!;
    layerPreferredOrientationByDeviceId.set(request.id, optimisticOrientation);
    minimumHorizontalSpanByDeviceId.set(request.id, optimisticOrientation.width);
    minimumApproachLaneCountByDeviceId.set(
      request.id,
      optimisticOrientation.approachLaneCount,
    );
  }
  const layerFeasibility = designCapacityAwareTopologyLayers({
    components: initialComponents,
    edges: allocatedEdges,
    frontageWidth,
    minimumHorizontalSpanByDeviceId,
    minimumApproachLaneCountByDeviceId,
    preferredFirstDeviceIds: suppliedIds,
  });
  if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
    console.error(JSON.stringify({
      label: "topology-layer-feasibility",
      feasible: layerFeasibility.feasible,
      diagnostics: layerFeasibility.diagnostics,
    }));
  }
  if (!layerFeasibility.feasible) return [];
  const components = layerFeasibility.components;
  const placementLayerByComponent = resolveWarehouseBranchPlacementLayers({
    components,
    edges: allocatedEdges,
    warehouseSuppliedDeviceIds: suppliedIds,
  });
  const placementLayer = (component: TopologyComponent): number =>
    placementLayerByComponent.get(component) ?? component.layer;
  const orientationById = new Map(placeableRequests.map((request) => [
    request.id,
    layerPreferredOrientationByDeviceId.get(request.id)!,
  ]));

  const candidates: PackingResult[] = [];
  const appendWarehouseShell = (devices: HeadlessPlacedDevice[]): boolean => {
    devices.push(toProductionDevice(busSource, 0, 0, busSourceOrientation));
    for (const [index, segment] of busSegments.slice(0, requiredBusSegments).entries()) {
      devices.push(toProductionDevice(
        segment,
        index * busSegmentOrientation.width,
        busSegmentRowY,
        busSegmentOrientation,
      ));
    }
    for (const [index, unloader] of unloaders.entries()) {
      devices.push(toProductionDevice(
        unloader,
        unloaderXs[index]!,
        unloaderY,
        unloaderOrientation,
      ));
    }
    return hasProductionClearance(devices, 0)
      && hasValidWarehouseHubAdjacency(devices, options.requests);
  };
  const appendCandidate = (
    devices: HeadlessPlacedDevice[],
    debugLabel: string,
    routingSeed?: RoutingResult,
  ): void => {
    if (!appendWarehouseShell(devices)) return;
    const bounds = measureBounds(devices);
    candidates.push({
      devices,
      usedWidth: bounds.width,
      usedHeight: bounds.height,
      equipmentArea: devices.reduce((sum, device) => sum + device.width * device.height, 0),
      debugLabel,
      routingSeed,
    });
  };

  interface ComponentBox {
    readonly component: TopologyComponent;
    readonly width: number;
    readonly height: number;
    readonly routingPriority?: number;
    readonly placements: readonly {
      readonly request: DeviceRequest;
      readonly x: number;
      readonly y: number;
      readonly orientation: {
        readonly width: number;
        readonly height: number;
        readonly rotation: GridRotation;
      };
    }[];
  }
  const componentByDeviceId = new Map<string, TopologyComponent>();
  components.forEach((component) =>
    component.deviceIds.forEach((deviceId) =>
      componentByDeviceId.set(deviceId, component)));
  if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
    console.error(JSON.stringify({
      components,
      allocatedEdges: allocatedEdges.map((edge) => ({
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        itemId: edge.itemId,
        laneCount: edge.laneCount,
      })),
    }));
  }
  const componentBoxVariants = new Map<TopologyComponent, ComponentBox[]>();
  const maximumFoldedFeedbackVariants = 8;
  // A sparse feedback-cycle exit may reserve an adjacent same-row successor
  // inside its otherwise empty component rectangle.
  const horizontalSuccessorSourceById = new Map<string, string>();
  for (const component of components) {
    const componentIds = new Set(component.deviceIds);
    const stableRequests = component.deviceIds
      .map((deviceId) => requestById.get(deviceId)!)
      .sort((left, right) => left.id.localeCompare(right.id));
    const internalEdges = allocatedEdges.filter((edge) =>
      componentIds.has(edge.sourceId) && componentIds.has(edge.targetId));
    const logicalInternalEdges = logicalEdges.filter((edge) =>
      componentIds.has(edge.sourceId) && componentIds.has(edge.targetId));
    const externalIncoming = allocatedEdges.filter((edge) =>
      !componentIds.has(edge.sourceId) && componentIds.has(edge.targetId));
    const externalOutgoing = allocatedEdges.filter((edge) =>
      componentIds.has(edge.sourceId) && !componentIds.has(edge.targetId));
    const orderScore = (ordered: readonly DeviceRequest[]): {
      readonly numeric: readonly number[];
      readonly signature: string;
    } => {
      const indexById = new Map(ordered.map((request, index) => [request.id, index]));
      const backwardLanes = internalEdges.reduce((sum, edge) =>
        sum + ((indexById.get(edge.sourceId) ?? 0) >= (indexById.get(edge.targetId) ?? 0)
          ? edge.laneCount
          : 0), 0);
      const externalDistance = externalIncoming.reduce((sum, edge) =>
        sum + (indexById.get(edge.targetId) ?? 0) * edge.laneCount, 0)
        + externalOutgoing.reduce((sum, edge) =>
          sum + (ordered.length - 1 - (indexById.get(edge.sourceId) ?? 0)) * edge.laneCount, 0);
      const internalSpan = internalEdges.reduce((sum, edge) =>
        sum + Math.abs(
          (indexById.get(edge.sourceId) ?? 0) - (indexById.get(edge.targetId) ?? 0),
        ) * edge.laneCount, 0);
      return {
        numeric: [backwardLanes, externalDistance, internalSpan],
        signature: ordered.map((request) => request.id).join("|"),
      };
    };
    let orderedRequests = stableRequests;
    if (stableRequests.length > 1 && stableRequests.length <= 8) {
      let bestScore = orderScore(orderedRequests);
      const visit = (prefix: DeviceRequest[], remaining: DeviceRequest[]): void => {
        if (remaining.length === 0) {
          const score = orderScore(prefix);
          const comparison = compareScore(score.numeric, bestScore.numeric)
            || score.signature.localeCompare(bestScore.signature);
          if (comparison < 0) {
            orderedRequests = [...prefix];
            bestScore = score;
          }
          return;
        }
        for (const [index, request] of remaining.entries()) {
          visit(
            [...prefix, request],
            [...remaining.slice(0, index), ...remaining.slice(index + 1)],
          );
        }
      };
      visit([], stableRequests);
    } else if (stableRequests.length > 8) {
      orderedRequests = [...stableRequests].sort((left, right) => {
        const externalIncomingDifference = externalIncoming.filter((edge) =>
          edge.targetId === right.id).length - externalIncoming.filter((edge) =>
          edge.targetId === left.id).length;
        if (externalIncomingDifference !== 0) return externalIncomingDifference;
        const externalOutgoingDifference = externalOutgoing.filter((edge) =>
          edge.sourceId === left.id).length - externalOutgoing.filter((edge) =>
          edge.sourceId === right.id).length;
        return externalOutgoingDifference || left.id.localeCompare(right.id);
      });
    }
    const isScc = orderedRequests.length > 1;
    const feedbackInset = isScc ? 1 : 0;
    const externalOutgoingIds = new Set(externalOutgoing.map((edge) => edge.sourceId));
    const bypassLaneCount = allocatedEdges
      .filter((edge) => {
        const source = componentByDeviceId.get(edge.sourceId);
        const target = componentByDeviceId.get(edge.targetId);
        return source !== undefined
          && target !== undefined
          && source !== component
          && placementLayer(source) <= placementLayer(component)
          && placementLayer(target) > placementLayer(component);
      })
      .reduce((sum, edge) => sum + edge.laneCount, 0);
    const boxVariants: ComponentBox[] = [];
    const foldedCycles = isScc && bypassLaneCount > 0
      ? enumerateFoldableFeedbackCycles({
          deviceIds: orderedRequests.map((request) => request.id),
          // SCC membership was derived from compatibility edges, while the
          // frozen lane allocation may omit an otherwise valid return edge
          // after one equivalent producer has satisfied all demand. Use the
          // same logical graph for role recognition; actual external lanes
          // still decide which member is eligible as the production exit.
          internalEdges: logicalInternalEdges,
          externalOutgoingEdges: externalOutgoing,
        }).slice(0, maximumFoldedFeedbackVariants)
      : [];
    for (const [foldedVariantIndex, foldedCycle] of foldedCycles.entries()) {
      // Fold every bounded graph-derived role assignment around its
      // through-flow cut. Equal-scoring hubs/exits remain separate candidates;
      // identifiers only stabilize enumeration order and never select the sole
      // geometry admitted to search.
      const cycleFanoutHub = requestById.get(foldedCycle.fanoutHubId)!;
      const cycleExternalExit = requestById.get(foldedCycle.externalExitId)!;
      const returnMembers = orderedRequests.filter((request) =>
        foldedCycle.returnMemberIds.includes(request.id));
      const hubOrientation = orientForSouthboundFlow(cycleFanoutHub);
      const exitOrientation = orientForEastboundFlow(cycleExternalExit);
      const orientationByMemberId = new Map([
        [cycleFanoutHub.id, hubOrientation] as const,
        ...returnMembers.map((request) =>
          [request.id, orientForNorthboundFlow(request)] as const),
      ]);
      const shelfPlans = enumerateFoldedFeedbackShelfPlans({
        fanoutHub: {
          id: cycleFanoutHub.id,
          width: hubOrientation.width,
          height: hubOrientation.height,
        },
        returnMembers: returnMembers.map((request) => {
          const orientation = orientationByMemberId.get(request.id)!;
          return {
            id: request.id,
            width: orientation.width,
            height: orientation.height,
          };
        }),
        frontageWidth,
      });
      for (const [shelfVariantIndex, shelfPlan] of shelfPlans.entries()) {
        if (boxVariants.length >= maximumFoldedFeedbackVariants) break;
        const upperPlacements: ComponentBox["placements"][number][] =
          shelfPlan.placements.map((placement) => ({
            request: requestById.get(placement.id)!,
            x: placement.x,
            y: placement.y,
            orientation: orientationByMemberId.get(placement.id)!,
          }));
        const fanoutPlacement = upperPlacements.find((placement) =>
          placement.request.id === cycleFanoutHub.id)!;
        const lowerX = Math.min(
          frontageWidth - exitOrientation.width,
          fanoutPlacement.x,
        );
        if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
          console.error(JSON.stringify({
            label: "folded-feedback-cycle",
            foldedVariantIndex,
            foldedVariantCount: foldedCycles.length,
            shelfVariantIndex,
            shelfVariantCount: shelfPlans.length,
            componentDeviceIds: component.deviceIds,
            roles: foldedCycle,
            bypassLaneCount,
            upperPlacements: upperPlacements.map((placement) => ({
              deviceId: placement.request.id,
              x: placement.x,
              y: placement.y,
              width: placement.orientation.width,
              height: placement.orientation.height,
              rotation: placement.orientation.rotation,
            })),
          }));
        }
        const lowerY = shelfPlan.height + 1;
        boxVariants.push({
          component,
          width: frontageWidth,
          height: lowerY + exitOrientation.height,
          // The edge-biased shelf keeps one continuous through corridor. It
          // is the preferred joint profile when several feedback folds must
          // preserve the same long upstream lanes.
          routingPriority: shelfVariantIndex === shelfPlans.length - 1 ? -1 : 0,
          placements: [
            ...upperPlacements,
            {
              request: cycleExternalExit,
              x: lowerX,
              y: lowerY,
              orientation: exitOrientation,
            },
          ],
        });
      }
    }
    // A feedback component can contain a chain of alternating producer/hub
    // pairs followed by several members that export material outside the SCC.
    // Put the complete allocated chain on the upper shelf and its external
    // exits on a lower shelf. The final hub then feeds every exit across the
    // shared inter-row track instead of trying to jump over a nearer exit in
    // the same row.
    if (isScc && orderedRequests.length <= 8 && externalOutgoingIds.size >= 2) {
      const nonExitRequests = orderedRequests.filter((request) =>
        !externalOutgoingIds.has(request.id));
      const nonExitIds = new Set(nonExitRequests.map((request) => request.id));
      let longestChain: DeviceRequest[] = [];
      const visitChain = (path: DeviceRequest[]): void => {
        const signature = path.map((request) => request.id).join("|");
        const longestSignature = longestChain.map((request) => request.id).join("|");
        if (path.length > longestChain.length
          || (path.length === longestChain.length && signature < longestSignature)) {
          longestChain = [...path];
        }
        const tail = path[path.length - 1];
        if (tail === undefined) return;
        const visitedIds = new Set(path.map((request) => request.id));
        const successors = internalEdges
          .filter((edge) => edge.sourceId === tail.id && nonExitIds.has(edge.targetId))
          .map((edge) => requestById.get(edge.targetId)!)
          .filter((request) => !visitedIds.has(request.id))
          .sort((left, right) => left.id.localeCompare(right.id));
        for (const successor of successors) visitChain([...path, successor]);
      };
      for (const start of nonExitRequests) visitChain([start]);
      const finalHub = longestChain[longestChain.length - 1];
      const exitRequests = orderedRequests.filter((request) =>
        externalOutgoingIds.has(request.id)
        && finalHub !== undefined
        && internalEdges.some((edge) =>
          edge.sourceId === finalHub.id && edge.targetId === request.id));
      if (longestChain.length === nonExitRequests.length
        && finalHub !== undefined
        && exitRequests.length === externalOutgoingIds.size) {
        const upperOrientations = longestChain.map((request, index) =>
          index === longestChain.length - 1
            ? orientForSouthboundFlow(request)
            : orientForEastboundFlow(request));
        const exitOrientations = exitRequests.map((request) =>
          orientForSouthboundFlow(request));
        if (longestChain.length >= 3) {
          const prefixRequests = longestChain.slice(0, -1);
          const prefixOrientations = prefixRequests.map((request) =>
            orientForEastboundFlow(request));
          let prefixCursorX = feedbackInset;
          const prefixPlacements = prefixRequests.map((request, index) => {
            const orientation = prefixOrientations[index]!;
            const placement = {
              request,
              x: prefixCursorX,
              y: 0,
              orientation,
            };
            prefixCursorX += orientation.width + 1;
            return placement;
          });
          const prefixWidth = prefixCursorX - 1;
          const prefixHeight = Math.max(...prefixOrientations.map((orientation) => orientation.height));
          const hubOrientation = orientForSouthboundFlow(finalHub);
          const hubY = prefixHeight + 1;
          const hubX = Math.max(feedbackInset, prefixWidth - hubOrientation.width);
          const exitWidth = exitOrientations.reduce(
            (sum, orientation, index) => sum + orientation.width + Number(index > 0),
            0,
          );
          const lowerY = hubY + hubOrientation.height + 1;
          let lowerCursorX = Math.max(feedbackInset, prefixWidth - exitWidth);
          const lowerPlacements = exitRequests.map((request, index) => {
            const orientation = exitOrientations[index]!;
            const placement = {
              request,
              x: lowerCursorX,
              y: lowerY,
              orientation,
            };
            lowerCursorX += orientation.width + 1;
            return placement;
          });
          const threeShelfWidth = Math.max(
            prefixWidth,
            hubX + hubOrientation.width,
            lowerCursorX - 1,
          );
          if (threeShelfWidth <= frontageWidth) {
            boxVariants.push({
              component,
              width: threeShelfWidth,
              height: lowerY + Math.max(...exitOrientations.map((orientation) => orientation.height)),
              routingPriority: 1,
              placements: [
                ...prefixPlacements,
                { request: finalHub, x: hubX, y: hubY, orientation: hubOrientation },
                ...lowerPlacements,
              ],
            });
          }
        }
        let upperCursorX = feedbackInset;
        const upperPlacements = longestChain.map((request, index) => {
          const orientation = upperOrientations[index]!;
          const placement = {
            request,
            x: upperCursorX,
            y: 0,
            orientation,
          };
          upperCursorX += orientation.width + 1;
          return placement;
        });
        const chainWidth = upperCursorX - 1;
        const upperHeight = Math.max(...upperOrientations.map((orientation) => orientation.height));
        const exitWidth = exitOrientations.reduce(
          (sum, orientation, index) => sum + orientation.width + Number(index > 0),
          0,
        );
        let exitCursorX = Math.max(feedbackInset, chainWidth - exitWidth);
        const lowerY = upperHeight + 1;
        const lowerPlacements = exitRequests.map((request, index) => {
          const orientation = exitOrientations[index]!;
          const placement = {
            request,
            x: exitCursorX,
            y: lowerY,
            orientation,
          };
          exitCursorX += orientation.width + 1;
          return placement;
        });
        const chainExitWidth = Math.max(chainWidth, exitCursorX - 1);
        if (chainExitWidth <= frontageWidth) {
          boxVariants.push({
            component,
            width: chainExitWidth,
            height: lowerY + Math.max(...exitOrientations.map((orientation) => orientation.height)),
            routingPriority: 0,
            placements: [...upperPlacements, ...lowerPlacements],
          });
        }
      }
    }
    const eastboundOrientationById = new Map(orderedRequests.map((request) => [
      request.id,
      externalOutgoingIds.has(request.id)
        ? orientForSouthboundFlow(request)
        : orientForEastboundFlow(request),
    ]));
    const componentOrientationById = isScc
      ? eastboundOrientationById
      : new Map(orderedRequests.map((request) => [
          request.id,
          horizontalSuccessorSourceById.has(request.id)
            ? orientForEastboundFlow(request)
            : orientationById.get(request.id)!,
        ]));
    const widestDevice = Math.max(
      ...orderedRequests.map((request) => componentOrientationById.get(request.id)!.width),
    );
    // A cyclic component's feedback track is not spare cut capacity. Even when
    // it runs beside the component, its endpoint/turn cell cannot be crossed by
    // a parallel through-lane. Reserve the complete bypass demand outside the
    // SCC box; local compaction may only reclaim it after an actual route proves
    // that a perpendicular crossing is legal.
    const reservedBypassWidth = Math.max(0, bypassLaneCount);
    const sccWidthLimit = isScc
      ? Math.max(
          widestDevice + feedbackInset * 2,
          frontageWidth - Math.min(
            reservedBypassWidth,
            frontageWidth - widestDevice - feedbackInset * 2,
          ),
        )
      : widestDevice;
    const contentWidthLimit = sccWidthLimit - feedbackInset * 2;
    // One free row is sufficient for a simple reciprocal pair, while a wider
    // strongly connected component can need a second track for another return
    // edge. Keep bounded 1/2/3-row alternatives so routing—not an item-specific
    // coordinate rule—decides how much feedback space is actually necessary.
    const rowGapVariants = isScc ? [1, 2, 3] : [0];
    for (const rowGap of rowGapVariants) {
      let cursorX = 0;
      let cursorY = 0;
      let rowHeight = 0;
      let occupiedContentWidth = 0;
      const placements = orderedRequests.map((request) => {
        const orientation = componentOrientationById.get(request.id)!;
        const precedingGap = isScc && cursorX > 0 ? 1 : 0;
        if (isScc && cursorX > 0
          && cursorX + precedingGap + orientation.width > contentWidthLimit) {
          cursorX = 0;
          cursorY += rowHeight + rowGap;
          rowHeight = 0;
        }
        const effectiveGap = isScc && cursorX > 0 ? 1 : 0;
        cursorX += effectiveGap;
        const placement = {
          request,
          x: feedbackInset + cursorX,
          y: cursorY,
          orientation,
        };
        cursorX += orientation.width;
        rowHeight = Math.max(rowHeight, orientation.height);
        occupiedContentWidth = Math.max(occupiedContentWidth, cursorX);
        return placement;
      });
      boxVariants.push({
        component,
        width: occupiedContentWidth + feedbackInset * 2,
        height: cursorY + rowHeight,
        placements,
      });
    }
    componentBoxVariants.set(component, boxVariants);
  }
  if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
    console.error(JSON.stringify({
      label: "topology-component-box-variants",
      components: [...componentBoxVariants.entries()].map(([component, variants]) => ({
        componentDeviceIds: component.deviceIds,
        variants: variants.map((box, variantIndex) => ({
          variantIndex,
          width: box.width,
          height: box.height,
          placements: box.placements.map((placement) => ({
            deviceId: placement.request.id,
            x: placement.x,
            y: placement.y,
            width: placement.orientation.width,
            height: placement.orientation.height,
            rotation: placement.orientation.rotation,
          })),
        })),
      })),
    }));
  }
  // Explore every alternative independently against the primary boxes of all
  // other components. This gives each ambiguous SCC a fair routing attempt
  // without a Cartesian-product explosion across unrelated cycles.
  // Warehouse supply edges are not part of allocatedEdges, so an externally
  // fed line can have a large routing graph while its internal edge count looks
  // deceptively small. Bound construction when any stable graph-size proxy is
  // large enough.
  const isLargeTopology = allocatedEdges.length >= 32
    || components.length >= 24
    || unloaders.length >= 12;
  const alternativeComponentBoxes = [...componentBoxVariants.entries()].flatMap(
    ([component, variants]) => variants.slice(1).map((box, variantIndex) => ({
      component,
      variantIndex: variantIndex + 1,
      box,
    })),
  );
  if (isLargeTopology) {
    alternativeComponentBoxes.sort((left, right) =>
      (left.box.routingPriority ?? 1) - (right.box.routingPriority ?? 1)
      || left.box.width * left.box.height - right.box.width * right.box.height
      || left.box.width - right.box.width
      || left.box.height - right.box.height
      || left.variantIndex - right.variantIndex);
  }
  const jointCorridorProfile = new Map<TopologyComponent, number>();
  for (const [component, variants] of componentBoxVariants) {
    const selected = variants
      .map((box, variantIndex) => ({ box, variantIndex }))
      .filter(({ variantIndex, box }) => variantIndex > 0 && (box.routingPriority ?? 1) < 0)
      .sort((left, right) => (left.box.routingPriority ?? 1) - (right.box.routingPriority ?? 1)
        || left.variantIndex - right.variantIndex)[0];
    if (selected !== undefined) jointCorridorProfile.set(component, selected.variantIndex);
  }
  const componentBoxProfiles: ReadonlyMap<TopologyComponent, number>[] = [
    new Map(),
    ...(jointCorridorProfile.size === 0 ? [] : [jointCorridorProfile]),
    ...alternativeComponentBoxes.map(({ component, variantIndex }) =>
      new Map([[component, variantIndex]])),
  ];
  const selectComponentBox = (
    component: TopologyComponent,
    profileIndex: number,
  ): ComponentBox => {
    const variants = componentBoxVariants.get(component)!;
    return variants[componentBoxProfiles[profileIndex]?.get(component) ?? 0] ?? variants[0]!;
  };
  const componentPredecessors = (component: TopologyComponent): TopologyComponent[] => {
    const predecessors = new Set<TopologyComponent>();
    for (const edge of allocatedEdges) {
      if (!component.deviceIds.includes(edge.targetId)) continue;
      const predecessor = componentByDeviceId.get(edge.sourceId);
      if (predecessor !== undefined && predecessor !== component) predecessors.add(predecessor);
    }
    return [...predecessors];
  };
  const topologyPortCorridorPenalty = (
    devices: readonly HeadlessPlacedDevice[],
  ): number => {
    const isUnavailable = (point: GridPoint): boolean =>
      point.x < frontageStart
      || point.x >= frontageEnd
      || point.y < 0
      || point.y >= options.limitHeight
      || devices.some((device) =>
        point.x >= device.position.x
        && point.x < device.position.x + device.width
        && point.y >= device.position.y
        && point.y < device.position.y + device.height);
    let penalty = 0;
    for (const device of devices) {
      const request = requestById.get(device.id);
      if (request === undefined
        || (request.kind !== "production" && request.kind !== "storage")) continue;
      const entity: WorldEntity = {
        id: `topology-port-score:${device.id}`,
        definitionId: request.definition.id,
        position: device.position,
        rotation: device.rotation,
        config: request.config,
        tags: [],
      };
      for (const direction of ["input", "output"] as const) {
        for (const kind of ["belt", "pipe"] as const) {
          const required = allocatedEdges
            .filter((edge) =>
              resolveItemLogisticsKind(edge.itemId, options.registry) === kind
              && (direction === "input"
                ? edge.targetId === device.id
                : edge.sourceId === device.id))
            .reduce((sum, edge) => sum + edge.laneCount, 0);
          if (required === 0) continue;
          const accesses = resolveDevicePortEndpoints({
            entity,
            definition: request.definition,
            kind,
            direction,
            pointerGridPoint: entity.position,
          }).filter((endpoint) => !isUnavailable(endpoint.outsideGridPoint))
            .map((endpoint) => {
              const point = endpoint.outsideGridPoint;
              const escapeOptions = [
                { x: point.x - 1, y: point.y },
                { x: point.x + 1, y: point.y },
                { x: point.x, y: point.y - 1 },
                { x: point.x, y: point.y + 1 },
              ].filter((neighbor) => !isUnavailable(neighbor)).length;
              return { key: gridKey(point), escapeOptions };
            });
          const unique = [...new Map(accesses.map((access) => [access.key, access])).values()]
            .sort((left, right) => right.escapeOptions - left.escapeOptions);
          penalty += Math.max(0, required - unique.length) * 1_000;
          penalty += unique.slice(0, required)
            .reduce((sum, access) => sum + Math.max(0, 2 - access.escapeOptions) * 8, 0);
        }
      }
    }
    return penalty;
  };
  const multiInputApproachDeficit = (devices: readonly HeadlessPlacedDevice[]): number => {
    const deviceById = new Map(devices.map((device) => [device.id, device]));
    const incomingSourcesByTarget = new Map<string, Set<string>>();
    for (const edge of allocatedEdges) {
      const sources = incomingSourcesByTarget.get(edge.targetId) ?? new Set<string>();
      sources.add(edge.sourceId);
      incomingSourcesByTarget.set(edge.targetId, sources);
    }
    const minimumApproach = Math.max(1, options.routingClearance + 2);
    return allocatedEdges.reduce((sum, edge) => {
      if ((incomingSourcesByTarget.get(edge.targetId)?.size ?? 0) < 2) return sum;
      if (requestById.get(edge.targetId)?.kind !== "production") return sum;
      const source = deviceById.get(edge.sourceId);
      const target = deviceById.get(edge.targetId);
      if (source === undefined || target === undefined) return sum;
      const horizontalGap = Math.max(
        0,
        target.position.x - (source.position.x + source.width),
        source.position.x - (target.position.x + target.width),
      );
      const verticalGap = Math.max(
        0,
        target.position.y - (source.position.y + source.height),
        source.position.y - (target.position.y + target.height),
      );
      return sum + Math.max(0, minimumApproach - horizontalGap - verticalGap);
    }, 0);
  };
  for (let constructionVariant = 0;
    constructionVariant < 6 * componentBoxProfiles.length;
    constructionVariant += 1) {
    const alignmentVariant = constructionVariant % 6;
    const componentBoxProfileIndex = Math.floor(constructionVariant / 6);
    const devices: HeadlessPlacedDevice[] = [];
    const centerByComponent = new Map<TopologyComponent, number>();
    let y = warehouseShellHeight + 1;
    let valid = true;
    const layers = [...new Set(components.map(placementLayer))]
      .sort((left, right) => left - right);
    for (const [layerIndex, layer] of layers.entries()) {
      const layerBoxes = components
        .filter((component) => placementLayer(component) === layer)
        .map((component) => selectComponentBox(component, componentBoxProfileIndex))
        .sort((left, right) => {
          const leftPredecessors = componentPredecessors(left.component);
          const rightPredecessors = componentPredecessors(right.component);
          const barycenter = (predecessors: readonly TopologyComponent[]): number =>
            predecessors.length === 0
              ? Number.POSITIVE_INFINITY
              : predecessors.reduce(
                  (sum, predecessor) => sum + (centerByComponent.get(predecessor) ?? 0),
                  0,
                ) / predecessors.length;
          const barycenterDifference = barycenter(leftPredecessors) - barycenter(rightPredecessors);
          if (Number.isFinite(barycenterDifference) && barycenterDifference !== 0) {
            return barycenterDifference;
          }
          const leftSupplied = left.component.deviceIds.every((id) => suppliedIds.has(id));
          const rightSupplied = right.component.deviceIds.every((id) => suppliedIds.has(id));
          return Number(rightSupplied) - Number(leftSupplied)
            || left.component.deviceIds[0]!.localeCompare(right.component.deviceIds[0]!);
        });
      const placedBoxes: Array<{
        readonly box: ComponentBox;
        readonly x: number;
        readonly y: number;
      }> = [];
      const nominalLayerWidth = layerBoxes.reduce((sum, box) => sum + box.width, 0);
      const widestLayerBox = Math.max(...layerBoxes.map((box) => box.width));
      const containsWarehouseSupplied = layerBoxes.some((box) =>
        box.component.deviceIds.every((id) => suppliedIds.has(id)));
      // A non-source layer laid edge-to-edge across the complete unloader
      // frontage behaves like a wall: later connections can reach its ports,
      // but cannot pass the row without leaving the hard frontage. Preserve
      // north/south port orientation and stagger the layer instead, reserving
      // a topology-derived vertical belt channel. Variants 3-5 retain the
      // unreserved geometry as a fallback for unusually shaped port sets.
      const verticalChannelWidth = alignmentVariant < 3
        && !containsWarehouseSupplied
        && nominalLayerWidth >= frontageWidth
        ? Math.min(3, Math.max(0, frontageWidth - widestLayerBox))
        : 0;
      const reserveChannelOnLeft = verticalChannelWidth > 0 && alignmentVariant % 3 === 1;
      const layerPlacementStartX = reserveChannelOnLeft ? verticalChannelWidth : 0;
      const layerPlacementEndX = reserveChannelOnLeft
        ? frontageWidth
        : frontageWidth - verticalChannelWidth;
      const maximumLocalHeight = layerBoxes.reduce((sum, box) => sum + box.height + 1, 0);
      for (const box of [...layerBoxes].sort((left, right) => {
        const leftSupplied = left.component.deviceIds.every((id) => suppliedIds.has(id));
        const rightSupplied = right.component.deviceIds.every((id) => suppliedIds.has(id));
        return Number(rightSupplied) - Number(leftSupplied)
          || right.height - left.height
          || right.width - left.width
          || left.component.deviceIds[0]!.localeCompare(right.component.deviceIds[0]!);
      })) {
        if (box.width > frontageWidth) {
          valid = false;
          break;
        }
        const predecessors = componentPredecessors(box.component);
        const exclusivePredecessors = predecessors.filter((predecessor) => {
          const successorComponents = new Set(allocatedEdges
            .filter((edge) => predecessor.deviceIds.includes(edge.sourceId))
            .map((edge) => componentByDeviceId.get(edge.targetId))
            .filter((component): component is TopologyComponent =>
              component !== undefined && component !== predecessor));
          return successorComponents.size <= 1;
        });
        const orderingPredecessors = exclusivePredecessors.length > 0
          ? exclusivePredecessors
          : predecessors;
        const predecessorCenter = orderingPredecessors.length === 0
          ? null
          : orderingPredecessors.reduce(
              (sum, predecessor) => sum + (centerByComponent.get(predecessor) ?? frontageWidth / 2),
              0,
            ) / orderingPredecessors.length;
        const suppliedIndexes = box.component.deviceIds.flatMap((deviceId) => {
          return unloaders.flatMap((unloader, index) =>
            unloader.warehouseConsumerId === deviceId ? [index] : []);
        });
        const suppliedCenter = suppliedIndexes.length === 0
          ? null
          : suppliedIndexes.reduce(
              (sum, index) =>
                sum + unloaderXs[index]! - frontageStart + unloaderOrientation.width / 2,
              0,
            ) / suppliedIndexes.length;
        const successorComponents = new Set(allocatedEdges
          .filter((edge) => box.component.deviceIds.includes(edge.sourceId))
          .map((edge) => componentByDeviceId.get(edge.targetId))
          .filter((component): component is TopologyComponent =>
            component !== undefined && component !== box.component));
        const fanoutCenter = successorComponents.size >= 2
          ? frontageWidth / 2
          : null;
        // Preserve graph continuity first. A multi-successor node does not
        // belong at the geometric center by definition; forcing it there can
        // sever it from its own predecessor and block unrelated bypass edges.
        const desiredCenter = predecessorCenter ?? suppliedCenter ?? fanoutCenter;
        let bestPlacement: {
          readonly x: number;
          readonly y: number;
          readonly score: readonly number[];
        } | null = null;
        for (let localY = 0; localY <= maximumLocalHeight - box.height; localY += 1) {
          for (let x = layerPlacementStartX; x <= layerPlacementEndX - box.width; x += 1) {
            const sameLayerRoutingGap = 3;
            const overlaps = placedBoxes.some((placed) =>
              x < placed.x + placed.box.width
              && x + box.width > placed.x
              && localY < placed.y + placed.box.height + sameLayerRoutingGap
              && localY + box.height + sameLayerRoutingGap > placed.y);
            if (overlaps) continue;
            const resultingHeight = Math.max(
              localY + box.height,
              ...placedBoxes.map((placed) => placed.y + placed.box.height),
            );
            const centerDistance = desiredCenter === null
              || (verticalChannelWidth > 0 && localY > 0)
              ? 0
              : Math.abs(x + box.width / 2 - desiredCenter);
            const xTieBreak = alignmentVariant % 3 === 0
              ? x
              : alignmentVariant % 3 === 1
                ? frontageWidth - box.width - x
                : Math.abs(x + box.width / 2 - frontageWidth / 2);
            const score = [resultingHeight, centerDistance, localY, xTieBreak, x] as const;
            if (bestPlacement === null || compareScore(score, bestPlacement.score) < 0) {
              bestPlacement = { x, y: localY, score };
            }
          }
        }
        if (bestPlacement === null) {
          valid = false;
          break;
        }
        placedBoxes.push({ box, x: bestPlacement.x, y: bestPlacement.y });
      }
      if (!valid) break;
      for (const placed of placedBoxes) {
        for (const placement of placed.box.placements) {
          devices.push(toProductionDevice(
            placement.request,
            frontageStart + placed.x + placement.x,
            y + placed.y + placement.y,
            placement.orientation,
          ));
        }
        centerByComponent.set(
          placed.box.component,
          placed.x + placed.box.width / 2,
        );
      }
      const layerHeight = Math.max(
        ...placedBoxes.map((placed) => placed.y + placed.box.height),
      );
      y += layerHeight + 1;
      if (layerIndex < layers.length - 1) {
        const cutLaneCount = allocatedEdges
          .filter((edge) => {
            const source = componentByDeviceId.get(edge.sourceId);
            const target = componentByDeviceId.get(edge.targetId);
            return source !== undefined && target !== undefined
              && placementLayer(source) <= layer && placementLayer(target) > layer;
          })
          .reduce((sum, edge) => sum + edge.laneCount, 0);
        // Each edge-disjoint logistics lane may need its own orthogonal track.
        // A square-root gap systematically under-reserves fan-out cuts; use a
        // bounded linear channel count and let local compaction remove slack
        // only after routing has proved feasible.
        const cutRoutingGap = Math.max(1, Math.min(8, cutLaneCount));
        // The staggered saturated layer already contains a dedicated vertical
        // channel, so one of the otherwise separate cut rows can share that
        // channel. This keeps the baseline within the requested height without
        // reducing the number of usable lanes.
        y += verticalChannelWidth > 0
          ? Math.max(1, cutRoutingGap - 1)
          : cutRoutingGap;
      }
    }
    if (!valid || y - 1 > options.limitHeight) {
      if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
        console.error(JSON.stringify({
          label: `graph-layered-${alignmentVariant}-profile-${componentBoxProfileIndex}`,
          rejected: valid ? "height-limit" : "placement",
          requiredHeight: y - 1,
          limitHeight: options.limitHeight,
        }));
      }
      continue;
    }
    if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
      console.error(JSON.stringify({
        label: `graph-layered-${alignmentVariant}-profile-${componentBoxProfileIndex}`,
        devices: devices.map((device) => ({
          id: device.id,
          x: device.position.x,
          y: device.position.y,
          width: device.width,
          height: device.height,
          rotation: device.rotation,
        })),
      }));
    }
    appendCandidate(
      devices,
      `warehouse-supply-cluster:topology-sequential:graph-layered-${alignmentVariant}-profile-${componentBoxProfileIndex}`,
    );
  }

  // Incremental Tetris repeatedly reroutes every topology prefix. That is
  // valuable packing diversity for small graphs, but becomes superlinear on
  // large construction-only requests. Keep only the most compact alternate
  // component profile and the stable low-shelf gravity objective for that
  // case; ordinary searches retain the full profile/objective bank.
  const isLargeConstructionBaseline = options.request.search?.scope === "local"
    && (options.request.search?.iterations ?? 16) === 0
    && isLargeTopology;

  interface TetrisPlacedBox {
    readonly component: TopologyComponent;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }
  interface TetrisState {
    readonly devices: readonly HeadlessPlacedDevice[];
    readonly placedBoxes: readonly TetrisPlacedBox[];
    readonly centerByComponent: ReadonlyMap<TopologyComponent, number>;
    readonly bottomByComponent: ReadonlyMap<TopologyComponent, number>;
    readonly score: readonly number[];
    readonly lastVerticalOffset: number;
    readonly lastHorizontalBand: 0 | 1 | 2;
    /**
     * Persistent horizontal lineage of routing-critical blocks. Besides
     * multi-device SCCs, a fan-out component must retain its left/centre/right
     * landing because its first successful outgoing route is not enough to
     * prove that the remaining branches will still have an exit corridor.
     */
    readonly structuralBandSignature: string;
    /** Preserve geometry for one final cold route after incremental routing deadlocks. */
    readonly deferredRouting?: boolean;
    readonly prefixDevices?: readonly HeadlessPlacedDevice[];
    readonly prefixRouting?: RoutingResult;
  }
  const componentLayers = [...new Set(components.map(placementLayer))]
    .sort((left, right) => left - right);
  const tetrisGeometrySignature = (state: TetrisState): string =>
    state.placedBoxes
      .map((box) => `${box.component.deviceIds.join(",")}@${box.x},${box.y}`)
      .join("|");
  const tetrisStateSignature = (state: TetrisState): string =>
    `${tetrisGeometrySignature(state)}|routing:${state.deferredRouting === true ? "cold" : "prefix"}`;
  // Three deterministic gravity objectives retain the same topology while
  // exploring a low shelf, a narrow stack, and a balanced near-square skyline.
  // Unlike the shelf baseline, a later component may fall beside a tall earlier
  // component instead of inheriting the maximum height of the whole layer.
  // Start with the topology-stable low shelf. It keeps warehouse-supplied
  // peers in source order, which is also the only non-crossing order when a
  // saturated cut has exactly one track per lane. Balanced/narrow variants
  // remain available for normal searches after this deterministic baseline.
  const tetrisProfileIndexes = isLargeConstructionBaseline
    ? [Math.min(1, componentBoxProfiles.length - 1)]
    : componentBoxProfiles.map((_, index) => index);
  const tetrisVariants = isLargeConstructionBaseline ? [0] : [0, 2, 1];
  for (const componentBoxProfileIndex of tetrisProfileIndexes) {
    for (const tetrisVariant of tetrisVariants) {
    let states: TetrisState[] = [{
      devices: [],
      placedBoxes: [],
      centerByComponent: new Map(),
      bottomByComponent: new Map(),
      score: [0],
      lastVerticalOffset: 0,
      lastHorizontalBand: 1,
      structuralBandSignature: "root",
    }];
    let rejected = false;
    for (const layer of componentLayers) {
      const layerBoxPool = components
        .filter((component) => placementLayer(component) === layer)
        .map((component) => selectComponentBox(component, componentBoxProfileIndex));
      const layerDeviceIds = new Set(layerBoxPool.flatMap((box) =>
        box.component.deviceIds));
      // Edges that start above this layer and end below it cannot terminate on
      // any device in the layer. They need real pass-through cells on every
      // equipment-occupied row. Prefix routing alone cannot detect this wall:
      // the lower endpoint has not landed yet, so the edge is still hidden.
      const requiredThroughLaneCount = allocatedEdges
        .filter((edge) => {
          const source = componentByDeviceId.get(edge.sourceId);
          const target = componentByDeviceId.get(edge.targetId);
          return source !== undefined && target !== undefined
            && placementLayer(source) < layer && placementLayer(target) > layer;
        })
        .reduce((sum, edge) => sum + edge.laneCount, 0);
      const suppliedFirst = [...layerBoxPool].sort((left, right) => {
          const leftSupplied = left.component.deviceIds.every((id) => suppliedIds.has(id));
          const rightSupplied = right.component.deviceIds.every((id) => suppliedIds.has(id));
          return Number(rightSupplied) - Number(leftSupplied)
            || right.height - left.height
            || right.width - left.width
            || left.component.deviceIds[0]!.localeCompare(right.component.deviceIds[0]!);
        });
      const alternateEnds = <T,>(values: readonly T[]): T[] => {
        const result: T[] = [];
        let left = 0;
        let right = values.length - 1;
        while (left <= right) {
          result.push(values[left]!);
          left += 1;
          if (left <= right) {
            result.push(values[right]!);
            right -= 1;
          }
        }
        return result;
      };
      const layerBoxes = tetrisVariant === 0
        ? suppliedFirst
        : tetrisVariant === 1
          ? [...layerBoxPool].sort((left, right) =>
              right.width * right.height - left.width * left.height
              || right.height - left.height
              // Equal-shape peers use the reverse topology-stable order. The
              // low-shelf variant already covers the forward order.
              || right.component.deviceIds[0]!.localeCompare(left.component.deviceIds[0]!))
          : (() => {
              // For incomparable same-layer branches, also try inserting the
              // non-supplied blocks between the two halves of the supplied
              // chain. This is a graph-derived ordering alternative, not a
              // recipe- or device-ID-specific exception.
              const supplied = suppliedFirst.filter((box) =>
                box.component.deviceIds.every((id) => suppliedIds.has(id)));
              const branches = suppliedFirst.filter((box) =>
                !box.component.deviceIds.every((id) => suppliedIds.has(id)));
              const split = Math.ceil(supplied.length / 2);
              return [
                ...supplied.slice(0, split),
                // When every peer has the same layer and shape, forward and
                // area sorting collapse to the same construction. Alternating
                // both ends lets an outer branch reserve its corridor before
                // the middle branch without enumerating every permutation.
                ...alternateEnds(branches),
                ...supplied.slice(split),
              ];
            })();
      const saturatedRoutingShelf = layerBoxes.length > 1
        && !layerBoxes.some((box) =>
          box.component.deviceIds.every((id) => suppliedIds.has(id)))
        && layerBoxes.reduce((sum, box) => sum + box.width, 0) >= frontageWidth;
      for (const [layerBoxIndex, box] of layerBoxes.entries()) {
        const componentDeviceIds = new Set(box.component.deviceIds);
        const externalSuccessorCount = new Set(allocatedEdges
          .filter((edge) => componentDeviceIds.has(edge.sourceId)
            && !componentDeviceIds.has(edge.targetId))
          .map((edge) => edge.targetId)).size;
        const preservesHorizontalLineage = box.component.deviceIds.length > 1
          || externalSuccessorCount >= 2
          || saturatedRoutingShelf;
        const expanded: TetrisState[] = [];
        for (const state of states) {
          const predecessors = componentPredecessors(box.component);
          const horizontalSourceId = box.component.deviceIds.length === 1
            ? horizontalSuccessorSourceById.get(box.component.deviceIds[0]!)
            : undefined;
          const horizontalSourceDevice = horizontalSourceId === undefined
            ? undefined
            : state.devices.find((device) => device.id === horizontalSourceId);
          const horizontalLanding = horizontalSourceDevice === undefined
            ? null
            : {
                x: horizontalSourceDevice.position.x
                  + horizontalSourceDevice.width
                  + 1
                  - frontageStart,
                y: horizontalSourceDevice.position.y,
              };
          const exclusivePredecessors = predecessors.filter((predecessor) => {
            const successorComponents = new Set(allocatedEdges
              .filter((edge) => predecessor.deviceIds.includes(edge.sourceId))
              .map((edge) => componentByDeviceId.get(edge.targetId))
              .filter((candidate): candidate is TopologyComponent =>
                candidate !== undefined && candidate !== predecessor));
            return successorComponents.size <= 1;
          });
          // Shared fan-out producers (for example one additive source feeding
          // several terminals) must not pull every terminal toward their common
          // center. Preserve the order of the exclusive main-line predecessors.
          const orderingPredecessors = exclusivePredecessors.length > 0
            ? exclusivePredecessors
            : predecessors;
          const predecessorTop = predecessors.length === 0
            ? warehouseShellHeight + 1
            : Math.min(...predecessors.map((predecessor) =>
                state.placedBoxes.find((placed) =>
                  placed.component === predecessor)?.y ?? warehouseShellHeight + 1));
          const predecessorBottom = predecessors.length === 0
            ? warehouseShellHeight
            : Math.max(...predecessors.map((predecessor) => {
                const placed = state.placedBoxes.find((candidate) =>
                  candidate.component === predecessor);
                return placed === undefined
                  ? warehouseShellHeight
                  : placed.y + placed.height;
              }));
          const precedingLayerBottom = Math.max(
            warehouseShellHeight,
            ...state.placedBoxes
              .filter((placed) =>
                placementLayer(placed.component) < placementLayer(box.component))
              .map((placed) => placed.y + placed.height),
          );
          const incomingLaneCount = allocatedEdges
            .filter((edge) => box.component.deviceIds.includes(edge.targetId)
              && !box.component.deviceIds.includes(edge.sourceId))
            .reduce((sum, edge) => sum + edge.laneCount, 0);
          const outgoingLaneCount = allocatedEdges
            .filter((edge) => box.component.deviceIds.includes(edge.sourceId)
              && !box.component.deviceIds.includes(edge.targetId))
            .reduce((sum, edge) => sum + edge.laneCount, 0);
          // A frontage-saturating row of multi-input consumers is a routing
          // wall even though its footprints fit exactly: every incoming fan-in
          // competes on the same cut immediately above the ports. Split that
          // shelf into two balanced sub-rows so routes can exchange horizontal
          // order between them. This is derived from cut saturation and degree,
          // not from any recipe or entity identifier.
          const saturatedMultiInputRowOffset = saturatedRoutingShelf
            && incomingLaneCount >= 2
            && layerBoxIndex >= Math.ceil(layerBoxes.length / 2)
            ? Math.max(...layerBoxes.map((candidate) => candidate.height))
              + options.routingClearance + 1
            : 0;
          const minimumY = horizontalLanding?.y ?? (
            Math.max(
              warehouseShellHeight + 1,
              predecessorTop,
              isLargeConstructionBaseline && predecessors.length > 0
                ? predecessorBottom + options.routingClearance + 1
                : warehouseShellHeight + 1,
              // A warehouse-fed intermediate can also have internal material
              // predecessors. Sharing their row points its input face back at
              // the warehouse and makes both supplies contend on the same
              // cells. Keep this merge below the complete predecessor bank.
              box.component.deviceIds.some((deviceId) => suppliedIds.has(deviceId))
                && predecessors.length > 0
                ? predecessorBottom + options.routingClearance + 1
                : warehouseShellHeight + 1,
              saturatedRoutingShelf
                ? precedingLayerBottom + options.routingClearance + 2
                  + Math.max(0, incomingLaneCount - 1)
                  + saturatedMultiInputRowOffset
                : warehouseShellHeight + 1,
              // A layer crossed by still-hidden upstream/downstream edges may
              // not reuse the height band of earlier equipment. Even when the
              // new box itself fits a skyline hole, its active rows would make
              // that earlier equipment consume the reserved through capacity.
              // Start a fresh band; later compression can reclaim rows after
              // complete routes prove that the lanes do not need them.
              requiredThroughLaneCount > 0
                ? precedingLayerBottom + 2
                : warehouseShellHeight + 1,
            )
          );
          const predecessorCenter = orderingPredecessors.length === 0
            ? null
            : orderingPredecessors.reduce(
                (sum, predecessor) =>
                  sum + (state.centerByComponent.get(predecessor) ?? frontageWidth / 2),
                0,
              ) / orderingPredecessors.length;
          const suppliedIndexes = box.component.deviceIds.flatMap((deviceId) => {
            return unloaders.flatMap((unloader, index) =>
              unloader.warehouseConsumerId === deviceId ? [index] : []);
          });
          const suppliedCenter = suppliedIndexes.length === 0
            ? null
            : suppliedIndexes.reduce(
                (sum, index) =>
                  sum + unloaderXs[index]! - frontageStart + unloaderOrientation.width / 2,
                0,
            ) / suppliedIndexes.length;
          const successorComponents = [...new Set(allocatedEdges
            .filter((edge) => box.component.deviceIds.includes(edge.sourceId))
            .map((edge) => componentByDeviceId.get(edge.targetId))
            .filter((candidate): candidate is TopologyComponent =>
              candidate !== undefined && candidate !== box.component))];
          const successorAnchorCenters = successorComponents.flatMap((successor) => {
            const peerCenters = componentPredecessors(successor)
              .filter((predecessor) => predecessor !== box.component)
              .flatMap((predecessor) => {
                const center = state.centerByComponent.get(predecessor);
                return center === undefined ? [] : [center];
              });
            return peerCenters.length === 0
              ? []
              : [peerCenters.reduce((sum, center) => sum + center, 0) / peerCenters.length];
          });
          // A singleton fan-out source should anticipate where its consumers
          // will land. Their already-placed *other* predecessors provide a
          // graph-derived anchor before those consumers themselves exist. This
          // separates parallel additive sources instead of stacking all of
          // them over their shared upstream component.
          const fanoutSuccessorCenter = box.component.deviceIds.length === 1
            && outgoingLaneCount >= 2
            && successorAnchorCenters.length > 0
            ? successorAnchorCenters.reduce((sum, center) => sum + center, 0)
              / successorAnchorCenters.length
            : null;
          const desiredCenter = suppliedCenter
            ?? fanoutSuccessorCenter
            ?? predecessorCenter;
          const suppliedLandingX = suppliedCenter === null
            ? null
            : Math.max(
                0,
                Math.min(
                  frontageWidth - box.width,
                  Math.round(suppliedCenter - box.width / 2),
                ),
              );
          const singletonRequest = box.component.deviceIds.length === 1
            ? requestById.get(box.component.deviceIds[0]!)
            : undefined;
          const singletonInputEdge = singletonRequest === undefined
            ? null
            : resolvePortEdge(
                singletonRequest,
                "input",
                box.placements[0]!.orientation.rotation,
              );
          const lateralTerminalLandingX = suppliedCenter === null
            && predecessors.length >= 2
            && incomingLaneCount >= 2
            && outgoingLaneCount === 0
            && (singletonInputEdge === "EAST" || singletonInputEdge === "WEST")
            ? singletonInputEdge === "EAST"
              ? 0
              : frontageWidth - box.width
            : null;
          const monotoneLandingX = lateralTerminalLandingX ?? (suppliedCenter === null
            && predecessorCenter !== null
            && incomingLaneCount >= 2
            && orderingPredecessors.length >= 2
            ? Math.round(predecessorCenter - box.width / 2)
            : null);
          for (let localX = 0; localX <= frontageWidth - box.width; localX += 1) {
            // A dedicated unloader already supplies the exact monotone landing
            // order for its first production device. Moving that device to a
            // different frontage slot forces otherwise independent source
            // lanes to cross before the process graph even begins.
            if (suppliedLandingX !== null && localX !== suppliedLandingX) {
              continue;
            }
            if (monotoneLandingX !== null && localX !== monotoneLandingX) {
              continue;
            }
            if (horizontalLanding !== null && localX !== horizontalLanding.x) {
              continue;
            }
            let lowestLegalY: number | null = null;
            for (let localY = minimumY;
              localY + box.height <= options.limitHeight;
              localY += 1) {
              const placedBox: TetrisPlacedBox = {
                component: box.component,
                x: localX,
                y: localY,
                width: box.width,
                height: box.height,
              };
              if (horizontalLanding !== null && localY !== horizontalLanding.y) continue;
              const placedDevices = box.placements.map((placement) =>
                toProductionDevice(
                  placement.request,
                  frontageStart + localX + placement.x,
                  localY + placement.y,
                  placement.orientation,
                ));
              const devices = [...state.devices, ...placedDevices];
              if (!hasProductionClearance(devices, 0)
                || measureFrontageOverflowCells([
                  ...devices,
                  ...unloaders.map((unloader, index) => toProductionDevice(
                    unloader,
                    unloaderXs[index]!,
                    unloaderY,
                    unloaderOrientation,
                  )),
                ]) > 0) continue;
              lowestLegalY ??= localY;
              const verticalOffset = localY - lowestLegalY;
              if (![0, 1, 2, 3, 4, 8].includes(verticalOffset)) continue;
              // Keep warehouse-supplied peers on the common direct-feed row.
              // Later graph components retain lifted rollback positions.
              if (suppliedCenter !== null && verticalOffset !== 0) continue;
              const bottom = localY + box.height;
              const center = localX + box.width / 2;
              const nextCenters = new Map(state.centerByComponent);
              nextCenters.set(box.component, center);
              const nextBottoms = new Map(state.bottomByComponent);
              nextBottoms.set(box.component, bottom);
              const bounds = measureBounds(devices);
              const occupiedArea = devices.reduce(
                (sum, device) => sum + device.width * device.height,
                0,
              );
              const shapeMinX = Math.min(...devices.map((device) => device.position.x));
              const shapeWidth = bounds.width - shapeMinX;
              const shapeHeight = bounds.height - (warehouseShellHeight + 1);
              const shapeArea = shapeWidth * shapeHeight;
              const horizontalSlack = frontageWidth - box.width;
              const horizontalBand: 0 | 1 | 2 = horizontalSlack <= 0
                ? 1
                : localX <= horizontalSlack / 3
                  ? 0
                  : localX >= horizontalSlack * 2 / 3
                    ? 2
                    : 1;
              const centerDistance = desiredCenter === null
                ? 0
                : Math.abs(center - desiredCenter);
              const xTieBreak = tetrisVariant === 0
                ? localX
                  : tetrisVariant === 1
                  ? frontageWidth - box.width - localX
                  : Math.abs(center - frontageWidth / 2);
              const shapeScore = tetrisVariant === 0
                ? [
                    Math.max(...nextBottoms.values()),
                    shapeArea,
                    shapeArea - occupiedArea,
                  ]
                : tetrisVariant === 1
                  ? [
                      shapeWidth,
                      shapeHeight,
                      shapeArea - occupiedArea,
                    ]
                  : [
                      Math.max(shapeWidth, shapeHeight),
                      Math.abs(shapeWidth - shapeHeight),
                      shapeArea,
                      shapeArea - occupiedArea,
                    ];
              expanded.push({
                devices,
                placedBoxes: [...state.placedBoxes, placedBox],
                centerByComponent: nextCenters,
                bottomByComponent: nextBottoms,
                prefixDevices: state.prefixDevices,
                prefixRouting: state.prefixRouting,
                lastVerticalOffset: verticalOffset,
                lastHorizontalBand: horizontalBand,
                structuralBandSignature: preservesHorizontalLineage
                  ? `${state.structuralBandSignature}:h${horizontalBand}`
                    + `:v${Math.min(verticalOffset, 4)}`
                  : state.structuralBandSignature,
                score: [
                  ...shapeScore,
                  centerDistance,
                  xTieBreak,
                  localY,
                  localX,
                ],
              });
              // Gravity is the default, but routing may reject the lowest
              // landing. Keep three lifted rollback positions and no others.
              if (verticalOffset === 8) break;
            }
          }
        }
        const uniqueExpanded = new Map<string, TetrisState>();
        for (const state of expanded.sort((left, right) =>
          topologyPortCorridorPenalty(left.devices) - topologyPortCorridorPenalty(right.devices)
          || multiInputApproachDeficit(left.devices) - multiInputApproachDeficit(right.devices)
          || compareScore(left.score, right.score))) {
          const signature = tetrisStateSignature(state);
          if (!uniqueExpanded.has(signature)) uniqueExpanded.set(signature, state);
        }
        const orderedExpanded = [...uniqueExpanded.values()];
        const shapeDiverse = new Map<string, TetrisState>();
        const diversitySlots = [
          { verticalOffset: 0, horizontalBand: 0 as const },
          { verticalOffset: 0, horizontalBand: 1 as const },
          { verticalOffset: 0, horizontalBand: 2 as const },
          { verticalOffset: 1 },
          { verticalOffset: 2 },
          { verticalOffset: 3 },
          { verticalOffset: 4 },
          { verticalOffset: 8 },
        ] as const;
        for (const slot of diversitySlots) {
          const retainedLineages = new Set<string>();
          for (const state of orderedExpanded.filter((candidate) =>
            candidate.lastVerticalOffset === slot.verticalOffset
            && (!("horizontalBand" in slot)
              || candidate.lastHorizontalBand === slot.horizontalBand))) {
            if (retainedLineages.has(state.structuralBandSignature)) continue;
            retainedLineages.add(state.structuralBandSignature);
            shapeDiverse.set(tetrisStateSignature(state), state);
          }
        }
        const shapeDiverseStates = [...shapeDiverse.values()];
        const shapeQueues = diversitySlots.map((slot) =>
          shapeDiverseStates.filter((candidate) =>
            candidate.lastVerticalOffset === slot.verticalOffset
            && (!("horizontalBand" in slot)
              || candidate.lastHorizontalBand === slot.horizontalBand)));
        states = [];
        const maximumStatesPerComponent = 18;
        for (let queueIndex = 0;
          states.length < maximumStatesPerComponent;
          queueIndex += 1) {
          let appended = false;
          for (const queue of shapeQueues) {
            const candidate = queue[queueIndex];
            if (candidate === undefined) continue;
            states.push(candidate);
            appended = true;
            if (states.length >= maximumStatesPerComponent) break;
          }
          if (!appended) break;
        }
        if (states.length === 0) {
          rejected = true;
          break;
        }
        // Commit one topology component at a time. In a wide layer of parallel
        // multi-input consumers, preserving routes accepted for earlier
        // components leaves each later component only its new incident
        // connections to solve instead of restarting all belts.
        const routedStates: TetrisState[] = [];
        const geometricStates = states;
        // Prefix routing is a feasibility filter, not the final router. On a
        // large construction-only graph, exhaustively rerouting every one of
        // the shape-diverse states makes a single SCC placement dominate the
        // whole baseline build. Probe a representative beam and retain the
        // untouched geometric beam below as cold-routing fallbacks.
        const prefixProbeStates = isLargeConstructionBaseline
          ? states.slice(0, 6)
          : states;
        for (const slot of diversitySlots) {
          // Preserve one routed state for each rollback shape. Taking the
          // first few globally would keep only center gravity-landed states
          // and silently discard side corridors that later components need.
          const routedLineages = new Set<string>();
          for (const state of prefixProbeStates.filter((candidate) =>
            candidate.lastVerticalOffset === slot.verticalOffset
            && (!("horizontalBand" in slot)
              || candidate.lastHorizontalBand === slot.horizontalBand))) {
            if (routedLineages.has(state.structuralBandSignature)) continue;
            if (state.deferredRouting) {
              routedStates.push(state);
              routedLineages.add(state.structuralBandSignature);
              continue;
            }
            const prefixDevices = [...state.devices];
            if (!appendWarehouseShell(prefixDevices)) continue;
            const prefixRouting = routeTopologyPrefix({
              request: options.request,
              requests: options.requests,
              registry: options.registry,
              devices: prefixDevices,
              previousDevices: state.prefixDevices,
              previousRouting: state.prefixRouting,
              fastProof: isLargeConstructionBaseline,
            });
            if (prefixRouting === null) continue;
            routedStates.push({
              ...state,
              prefixDevices,
              prefixRouting,
            });
            routedLineages.add(state.structuralBandSignature);
          }
        }
        const placedDeviceIds = new Set(
          geometricStates[0]?.devices.map((device) => device.id) ?? [],
        );
        const containsPlacedFeedbackComponent = components.some((component) =>
          component.deviceIds.length > 1
          && component.deviceIds.every((deviceId) => placedDeviceIds.has(deviceId)));
        const containsOpenFanout = [...placedDeviceIds].some((sourceId) => {
          const targets = allocatedEdges
            .filter((edge) => edge.sourceId === sourceId)
            .map((edge) => edge.targetId);
          return targets.some((targetId) => placedDeviceIds.has(targetId))
            && targets.some((targetId) => !placedDeviceIds.has(targetId));
        });
        const alreadyHasColdFallback = routedStates.some((state) =>
          state.deferredRouting === true);
        const fallbackLimit = routedStates.length === 0
          ? 6
          : !alreadyHasColdFallback
            && (containsPlacedFeedbackComponent || containsOpenFanout)
            ? 3
            : 0;
        if (fallbackLimit > 0 && geometricStates.length > 0) {
          // Prefix routes deliberately freeze previously accepted paths. That
          // is fast when construction is monotone, but a late fan-out branch
          // or a feedback component can require all earlier ports to be
          // reassigned together. A successful prefix is therefore not proof
          // that every remaining branch is reachable. Preserve a small,
          // shape-diverse geometric fallback and let the final cold router
          // solve the complete graph from scratch.
          const routeableFallbacks = [...geometricStates].sort((left, right) =>
            topologyPortCorridorPenalty(left.devices) - topologyPortCorridorPenalty(right.devices)
            || multiInputApproachDeficit(left.devices) - multiInputApproachDeficit(right.devices)
            || compareScore(left.score, right.score));
          const retainedLineages = new Set<string>();
          let retainedFallbackCount = 0;
          for (const state of routeableFallbacks) {
            if (fallbackLimit < 6
              && retainedLineages.has(state.structuralBandSignature)) continue;
            retainedLineages.add(state.structuralBandSignature);
            routedStates.push({
              ...state,
              deferredRouting: true,
              prefixDevices: undefined,
              prefixRouting: undefined,
            });
            retainedFallbackCount += 1;
            if (retainedFallbackCount >= fallbackLimit) break;
          }
        }
        states = routedStates;
        if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
          console.error(JSON.stringify({
            label: `graph-tetris-${tetrisVariant}-profile-${componentBoxProfileIndex}`,
            layer,
            component: box.component.deviceIds,
            routedStates: states.length,
            stateBounds: states.map((state) => ({
              width: measureBounds(state.devices).width,
              height: measureBounds(state.devices).height,
              topologyPortCorridorPenalty: topologyPortCorridorPenalty(state.devices),
              multiInputApproachDeficit: multiInputApproachDeficit(state.devices),
            })),
          }));
        }
        if (states.length === 0) {
          rejected = true;
          break;
        }
      }
      if (!rejected && requiredThroughLaneCount > 0) {
        states = states.filter((state) => hasRequiredThroughCorridorCapacity({
          devices: state.devices,
          layerDeviceIds,
          frontageStart,
          frontageEnd,
          requiredLaneCount: requiredThroughLaneCount,
        }));
        if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
          console.error(JSON.stringify({
            label: `graph-tetris-${tetrisVariant}-profile-${componentBoxProfileIndex}`,
            layer,
            requiredThroughLaneCount,
            corridorFeasibleStates: states.length,
          }));
        }
        if (states.length === 0) rejected = true;
      }
      if (rejected) break;
    }
    if (rejected) continue;
    const compareCompleteStates = (left: TetrisState, right: TetrisState): number =>
      topologyPortCorridorPenalty(left.devices) - topologyPortCorridorPenalty(right.devices)
      || multiInputApproachDeficit(left.devices) - multiInputApproachDeficit(right.devices)
      || compareScore(left.score, right.score);
    const prefixCompleteStates = states
      .filter((state) => state.deferredRouting !== true)
      .sort(compareCompleteStates);
    const coldCompleteStates = states
      .filter((state) => state.deferredRouting === true)
      .sort(compareCompleteStates);
    const orderedCompleteStates: TetrisState[] = [];
    for (let index = 0;
      index < Math.max(prefixCompleteStates.length, coldCompleteStates.length);
      index += 1) {
      if (prefixCompleteStates[index] !== undefined) {
        orderedCompleteStates.push(prefixCompleteStates[index]!);
      }
      if (coldCompleteStates[index] !== undefined) {
        orderedCompleteStates.push(coldCompleteStates[index]!);
      }
    }
    if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
      console.error(JSON.stringify({
        label: `graph-tetris-complete-${tetrisVariant}-profile-${componentBoxProfileIndex}`,
        states: orderedCompleteStates.map((state) => ({
          deferredRouting: state.deferredRouting === true,
          topologyPortCorridorPenalty: topologyPortCorridorPenalty(state.devices),
          multiInputApproachDeficit: multiInputApproachDeficit(state.devices),
          bounds: measureBounds(state.devices),
          devices: state.devices.map((device) =>
            `${device.id}@${device.position.x},${device.position.y},${device.rotation}`),
        })),
      }));
    }
    for (const [stateIndex, state] of orderedCompleteStates.entries()) {
      appendCandidate(
        [...state.devices],
        `warehouse-supply-cluster:topology-sequential:graph-tetris-${tetrisVariant}-profile-${componentBoxProfileIndex}-${stateIndex}`,
        state.prefixRouting,
      );
    }
    // A local zero-iteration request is a construction proof, not a packing
    // diversity search. Once one complete incrementally routed Tetris family
    // exists, evaluating two more gravity objectives only repeats expensive
    // route-prefix work without changing the requested baseline.
    if (states.some((state) => state.deferredRouting !== true
      || multiInputApproachDeficit(state.devices) === 0)
      && options.request.search?.scope === "local"
      && (options.request.search?.iterations ?? 16) === 0) {
      // The bounded Tetris family was constructed specifically to repair a
      // routing-obstructed large layered baseline. Evaluate that proof family
      // before spending the refinement beam on the ordinary shelf variants
      // that motivated it.
      return [
        ...candidates.filter((candidate) => candidate.debugLabel?.includes(":graph-tetris-")),
        ...candidates.filter((candidate) => !candidate.debugLabel?.includes(":graph-tetris-")),
      ];
    }
  }
  }
  return isLargeConstructionBaseline
    ? [
        ...candidates.filter((candidate) => candidate.debugLabel?.includes(":graph-tetris-")),
        ...candidates.filter((candidate) => !candidate.debugLabel?.includes(":graph-tetris-")),
      ]
    : candidates;

}

/**
 * Route every connection whose endpoints exist in the current topology prefix.
 * Outputs belonging to future layers remain uncommitted; the next layer may
 * therefore reuse the corridor after the current prefix is rerouted.
 */
function routeTopologyPrefix(options: {
  readonly request: HeadlessOptimizationRequest;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly previousDevices?: readonly HeadlessPlacedDevice[];
  readonly previousRouting?: RoutingResult;
  /** Use one deterministic no-rip-up probe before preserving a cold fallback. */
  readonly fastProof?: boolean;
}): RoutingResult | null {
  const placedIds = new Set(options.devices.map((device) => device.id));
  const prefixRequests = options.requests.filter((request) => placedIds.has(request.id));
  const productionEntities = createEntities(prefixRequests, options.devices);
  // The production graph is allocated once from the complete request. A
  // prefix merely reveals the edges whose two endpoints have already landed;
  // recomputing allocation from the prefix would silently connect an early
  // producer to the wrong same-layer consumer.
  const prefixFlowEdges = createCpSatFlowEdges(options.requests, options.registry)
    .filter((edge) => placedIds.has(edge.sourceId) && placedIds.has(edge.targetId));
  const previousDeviceIds = new Set(
    options.previousDevices?.map((device) => device.id) ?? [],
  );
  const addedDeviceIds = new Set(
    options.devices
      .map((device) => device.id)
      .filter((id) => !previousDeviceIds.has(id)),
  );
  const addedExternalIncomingEdgeCount = prefixFlowEdges.filter((edge) =>
    addedDeviceIds.has(edge.targetId) && !addedDeviceIds.has(edge.sourceId)).length;
  const topologyComponents = buildTopologyComponents(
    prefixRequests.map((request) => request.id),
    prefixFlowEdges,
  );
  const componentByDeviceId = new Map<string, TopologyComponent>();
  for (const component of topologyComponents) {
    for (const deviceId of component.deviceIds) {
      componentByDeviceId.set(deviceId, component);
    }
  }
  const previousConnections = options.previousRouting?.connections ?? [];
  let strongestFailure: Error | null = null;
  let strongestProgress = -1;
  const prefixRoutingVariants = options.fastProof === true
    ? [32]
    : [32, 31, 29, 13, 12, 9, 0, 30, 28, 10, 2]
      .slice(0, Math.max(
        5,
        Math.min(11, (options.request.search?.routingVariants ?? 3) + 4),
      ));
  for (const routingVariant of prefixRoutingVariants) {
    const priorityConnectionKeys: string[] = [];
    const forcedRipUpConnectionIds = new Set<string>();
    const addRipUpConnection = (connection: ReroutableConnection): void => {
      if (forcedRipUpConnectionIds.size >= 16) return;
      forcedRipUpConnectionIds.add(connection.id);
      // A strongly connected production component is one indivisible routing
      // skeleton. Releasing just one of its reciprocal paths often makes the
      // rerouter reproduce the same deadlock around the paths that remained
      // frozen, so release all previous paths incident to that SCC together.
      const endpointComponents = [
        connection.sourceDeviceId === null
          ? undefined
          : componentByDeviceId.get(connection.sourceDeviceId),
        connection.targetDeviceId === null
          ? undefined
          : componentByDeviceId.get(connection.targetDeviceId),
      ].filter((component): component is TopologyComponent =>
        component !== undefined && component.deviceIds.length > 1);
      for (const component of endpointComponents) {
        const memberIds = new Set(component.deviceIds);
        for (const related of previousConnections) {
          if (forcedRipUpConnectionIds.size >= 16) break;
          if ((related.sourceDeviceId !== null && memberIds.has(related.sourceDeviceId))
            || (related.targetDeviceId !== null && memberIds.has(related.targetDeviceId))) {
            forcedRipUpConnectionIds.add(related.id);
          }
        }
      }
    };
    const expandRipUpFrontier = (): boolean => {
      if (forcedRipUpConnectionIds.size >= 16) return false;
      const next = previousConnections
        .filter((connection) => !forcedRipUpConnectionIds.has(connection.id))
        .map((connection) => ({
          connection,
          conflicts: previousConnections.filter((other) =>
            forcedRipUpConnectionIds.has(other.id)
            && connectionsInteract(connection, other)).length,
        }))
        .filter(({ conflicts }) => conflicts > 0)
        .sort((left, right) => right.conflicts - left.conflicts
          || left.connection.id.localeCompare(right.connection.id))[0]?.connection;
      if (next === undefined) return false;
      addRipUpConnection(next);
      return true;
    };
    const priorityAttemptLimit = options.fastProof === true ? 1 : 4;
    for (let priorityAttempt = 0; priorityAttempt < priorityAttemptLimit; priorityAttempt += 1) {
      try {
        const routing = routeMaterialFlow({
          request: {
            ...options.request,
            // A final target producer whose storage has not been placed yet must
            // not be mistaken for a map-boundary export during prefix validation.
            targets: [],
          },
          registry: options.registry,
          requests: prefixRequests,
          productionDevices: options.devices,
          productionEntities,
          routingVariant,
          prioritizeFanoutGroups: true,
          preferFirstFeasibleRoute: false,
          enforceFrontageConstraint: true,
          freezeFlowAllocation: true,
          previousRouting: options.previousRouting,
          previousProductionDevices: options.previousDevices,
          movedDeviceIds: options.previousDevices === undefined
            ? undefined
            : findMovedDeviceIds(options.previousDevices, options.devices),
          forcedRipUpConnectionIds: forcedRipUpConnectionIds.size === 0
            ? undefined
            : forcedRipUpConnectionIds,
          priorityConnectionKeys,
          flowAllocationRequests: options.requests,
        });
        if (listFrontageOverflowConnectionIds(options.devices, routing.connections).length === 0) {
          return routing;
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const progress = Number.parseInt(
          failure.message.match(/Completed connections: (\d+)\//)?.[1] ?? "-1",
          10,
        );
        if (progress >= strongestProgress) {
          strongestProgress = progress;
          strongestFailure = failure;
        }
        if (!(error instanceof RouteFailureError)) break;
        const failureKey = routeFailureConnectionKey(error.evidence);
        const previousRipUpCount = forcedRipUpConnectionIds.size;
        if (options.previousRouting !== undefined) {
          const frontierCells = new Set(error.evidence.frontierBlockers
            .filter((blocker) => blocker.ownerKind === "logistics")
            .map((blocker) => `${blocker.x},${blocker.y}`));
          for (const connection of previousConnections) {
            if (forcedRipUpConnectionIds.size >= 16) break;
            if (connection.points.some((point) => frontierCells.has(gridKey(point)))) {
              addRipUpConnection(connection);
            }
          }
          // If the failed route itself belonged to the previous prefix, start
          // the release even when its reachable frontier contains only
          // equipment cells and therefore names no logistics blocker.
          for (const connection of previousConnections) {
            if (routeConnectionKey(connection) === failureKey) {
              addRipUpConnection(connection);
            }
          }
        }
        const repeatedFailure = priorityConnectionKeys.includes(failureKey);
        if (repeatedFailure) {
          priorityConnectionKeys.splice(priorityConnectionKeys.indexOf(failureKey), 1);
        }
        // The most recently blocked path moves to the front. Alternating two
        // mutually blocking paths therefore explores both route orders instead
        // of locking in whichever one happened to fail first.
        priorityConnectionKeys.unshift(failureKey);
        if (repeatedFailure && forcedRipUpConnectionIds.size === previousRipUpCount
          && !expandRipUpFrontier()) break;
      }
    }
    if (options.previousRouting !== undefined && addedExternalIncomingEdgeCount >= 2) {
      const rebuildPriorityConnectionKeys = [...priorityConnectionKeys];
      for (let rebuildAttempt = 0; rebuildAttempt < 6; rebuildAttempt += 1) {
        try {
          // Local preservation is the fast path, but a route that does not touch
          // the new component can still divide the frontage into disconnected
          // corridors. Rebuild only the current topology prefix before rejecting
          // the equipment placement; future components remain absent.
          const rebuilt = routeMaterialFlow({
            request: {
              ...options.request,
              targets: [],
            },
            registry: options.registry,
            requests: prefixRequests,
            productionDevices: options.devices,
            productionEntities,
            routingVariant,
            prioritizeFanoutGroups: true,
            preferFirstFeasibleRoute: rebuildAttempt % 2 === 1,
            enforceFrontageConstraint: true,
            freezeFlowAllocation: false,
            priorityConnectionKeys: rebuildPriorityConnectionKeys,
            flowAllocationRequests: options.requests,
          });
          if (listFrontageOverflowConnectionIds(options.devices, rebuilt.connections).length === 0) {
            return rebuilt;
          }
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          const progress = Number.parseInt(
            failure.message.match(/Completed connections: (\d+)\//)?.[1] ?? "-1",
            10,
          );
          if (progress >= strongestProgress) {
            strongestProgress = progress;
            strongestFailure = failure;
          }
          if (!(error instanceof RouteFailureError)) break;
          const failureKey = routeFailureConnectionKey(error.evidence);
          const existingIndex = rebuildPriorityConnectionKeys.indexOf(failureKey);
          if (existingIndex >= 0) rebuildPriorityConnectionKeys.splice(existingIndex, 1);
          if (rebuildAttempt % 3 === 0) {
            rebuildPriorityConnectionKeys.push(failureKey);
          } else if (rebuildAttempt % 3 === 1) {
            rebuildPriorityConnectionKeys.unshift(failureKey);
          } else {
            rebuildPriorityConnectionKeys.splice(
              Math.floor(rebuildPriorityConnectionKeys.length / 2),
              0,
              failureKey,
            );
          }
        }
      }
    }
  }
  if (process.env["INDUSTRIAL_PLANNER_TRACE_TOPOLOGY_BASELINE"] === "1") {
    console.error(
      `[graph-tetris-prefix-rejected] devices=${options.devices.length} `
      + `progress=${strongestProgress} ${strongestFailure?.message ?? "unknown"}`,
    );
  }
  return null;
}

function createWarehouseSupplyClusterPacking(options: {
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): PackingResult | null {
  const reject = (reason: string): null => {
    if (process.env["INDUSTRIAL_PLANNER_TRACE_WAREHOUSE_CLUSTER"] === "1") {
      console.error(`[warehouse-supply-cluster-rejected] ${reason}`);
    }
    return null;
  };
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const productionRequests = options.requests.filter((request) => request.kind === "production");
  const storageRequests = options.requests.filter((request) => request.kind === "storage");
  const unloaders = options.requests
    .filter((request) => request.kind === "warehouse-port" && request.warehouseConsumerId !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const busSource = options.requests.find((request) => request.id === "warehouse-bus-source");
  const busSegments = options.requests
    .filter((request) => request.kind === "warehouse-bus" && request.id !== "warehouse-bus-source")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (unloaders.length < 2 || busSource === undefined) return reject("missing-unloaders-or-bus");

  const suppliedIds = new Set(unloaders.flatMap((request) =>
    request.warehouseConsumerId === undefined ? [] : [request.warehouseConsumerId]));
  if (suppliedIds.size !== unloaders.length) return reject("unloaders-not-one-to-one");
  const suppliedRequests = [...suppliedIds]
    .flatMap((id) => {
      const request = requestById.get(id);
      return request?.kind === "production" ? [request] : [];
    });
  if (suppliedRequests.length !== suppliedIds.size) return reject("missing-supplied-production");

  const placeableRequests = options.requests.filter((request) =>
    request.kind === "production" || request.kind === "storage");
  const flowEdges = createCpSatFlowEdges(placeableRequests, options.registry);
  const downstreamById = new Map<string, DeviceRequest>();
  const suppliedByDownstreamId = new Map<string, DeviceRequest[]>();
  for (const edge of flowEdges) {
    if (!suppliedIds.has(edge.sourceId)) continue;
    const downstream = requestById.get(edge.targetId);
    const supplied = requestById.get(edge.sourceId);
    if (downstream?.kind !== "production" || supplied?.kind !== "production") continue;
    downstreamById.set(downstream.id, downstream);
    const group = suppliedByDownstreamId.get(downstream.id) ?? [];
    if (!group.some((request) => request.id === supplied.id)) group.push(supplied);
    suppliedByDownstreamId.set(downstream.id, group);
  }
  const downstreamRequests = [...downstreamById.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (downstreamRequests.length < 2) return reject("insufficient-downstream-groups");
  const groupedSuppliedIds = new Set([...suppliedByDownstreamId.values()].flat().map((request) => request.id));
  if (groupedSuppliedIds.size !== suppliedRequests.length) return reject("supplied-device-not-grouped");

  const downstreamIds = new Set(downstreamRequests.map((request) => request.id));
  const sharedUpstreamRequests = productionRequests
    .filter((request) => !suppliedIds.has(request.id) && !downstreamIds.has(request.id))
    .map((request) => ({
      request,
      consumerCount: downstreamRequests.filter((downstream) =>
        measureDirectedFlowLaneCount(request, downstream, options.registry) > 0).length,
    }))
    .filter(({ consumerCount }) => consumerCount >= 2)
    .sort((left, right) => right.consumerCount - left.consumerCount
      || left.request.id.localeCompare(right.request.id))
    .map(({ request }) => request);
  const sharedUpstreamIds = new Set(sharedUpstreamRequests.map((request) => request.id));
  const remainingRequests = productionRequests
    .filter((request) =>
      !suppliedIds.has(request.id)
      && !downstreamIds.has(request.id)
      && !sharedUpstreamIds.has(request.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  // A recirculating supply chain is most compact when its bidirectional hub is
  // between its peers. Derive that hub from material flow (rather than recipe
  // names), then face its ports back into the column.
  const remainingHub = remainingRequests
    .map((request) => ({
      request,
      bidirectionalDegree: remainingRequests.filter((other) =>
        other.id !== request.id && hasBidirectionalMaterialFlow(request, other)).length,
    }))
    .filter(({ bidirectionalDegree }) => bidirectionalDegree >= 2)
    .sort((left, right) => right.bidirectionalDegree - left.bidirectionalDegree
      || left.request.id.localeCompare(right.request.id))[0]?.request;
  const remainingLayoutRequests = remainingHub === undefined
    ? remainingRequests
    : (() => {
        const peers = remainingRequests.filter((request) => request.id !== remainingHub.id);
        const middleIndex = Math.ceil(peers.length / 2);
        return [...peers.slice(0, middleIndex), remainingHub, ...peers.slice(middleIndex)];
      })();
  const storage = storageRequests
    .map((request) => ({
      request,
      producerCount: (request.warehouseProducerIds ?? []).filter((id) => downstreamIds.has(id)).length,
    }))
    .sort((left, right) => right.producerCount - left.producerCount
      || left.request.id.localeCompare(right.request.id))[0]?.request;
  if (storage === undefined) return reject("missing-terminal-storage");

  const orient = (
    request: DeviceRequest,
    direction: "input" | "output",
    edge: GridEdge,
  ): { readonly width: number; readonly height: number; readonly rotation: GridRotation } => {
    const rotation = options.allowRotate
      ? resolvePortFacingRotation(request, direction, edge) ?? 0
      : 0;
    const swaps = rotation === 90 || rotation === 270;
    return {
      width: swaps ? request.definition.footprint.height : request.definition.footprint.width,
      height: swaps ? request.definition.footprint.width : request.definition.footprint.height,
      rotation,
    };
  };
  const storageOrientation = orient(storage, "input", "EAST");
  const remainingOrientations = new Map(remainingLayoutRequests.map((request) => [
    request.id,
    orient(request, "output", request.id === remainingHub?.id ? "WEST" : "EAST"),
  ]));
  const downstreamOrientations = new Map(downstreamRequests.map((request) => [
    request.id,
    orient(request, "output", "WEST"),
  ]));
  const suppliedOrientations = new Map(suppliedRequests.map((request) => [
    request.id,
    orient(request, "input", "EAST"),
  ]));
  const sharedOrientations = new Map(sharedUpstreamRequests.map((request) => [
    request.id,
    orient(request, "output", "NORTH"),
  ]));

  const remainingColumnWidth = Math.max(
    0,
    ...remainingLayoutRequests.map((request) => remainingOrientations.get(request.id)!.width),
  );
  const downstreamColumnWidth = Math.max(
    ...downstreamRequests.map((request) => downstreamOrientations.get(request.id)!.width),
  );
  const suppliedColumnWidth = Math.max(
    ...suppliedRequests.map((request) => suppliedOrientations.get(request.id)!.width),
  );
  const downstreamX = remainingColumnWidth + 1 + storageOrientation.width + 1;
  const suppliedX = downstreamX + downstreamColumnWidth + 3;
  const remainingX = remainingHub === undefined ? 0 : 1;

  const devices: HeadlessPlacedDevice[] = [];
  let remainingY = 0;
  for (const request of remainingLayoutRequests) {
    const orientation = remainingOrientations.get(request.id)!;
    devices.push(toProductionDevice(request, remainingX, remainingY, orientation));
    remainingY += orientation.height + 1;
  }

  const placedDownstreamById = new Map<string, HeadlessPlacedDevice>();
  const placedSuppliedById = new Map<string, HeadlessPlacedDevice>();
  let moduleY = 0;
  for (const downstream of downstreamRequests) {
    const downstreamOrientation = downstreamOrientations.get(downstream.id)!;
    const suppliedGroup = (suppliedByDownstreamId.get(downstream.id) ?? [])
      .sort((left, right) => left.id.localeCompare(right.id));
    const suppliedHeight = suppliedGroup.reduce(
      (sum, request) => sum + suppliedOrientations.get(request.id)!.height,
      0,
    );
    const moduleHeight = Math.max(downstreamOrientation.height, suppliedHeight);
    const downstreamDevice = toProductionDevice(downstream, downstreamX, moduleY, downstreamOrientation);
    devices.push(downstreamDevice);
    placedDownstreamById.set(downstream.id, downstreamDevice);
    let suppliedY = moduleY;
    for (const supplied of suppliedGroup) {
      const orientation = suppliedOrientations.get(supplied.id)!;
      const device = toProductionDevice(supplied, suppliedX, suppliedY, orientation);
      devices.push(device);
      placedSuppliedById.set(supplied.id, device);
      suppliedY += orientation.height;
    }
    moduleY += moduleHeight;
  }

  const storageX = downstreamX - storageOrientation.width - 1;
  const storageY = Math.max(0, Math.floor((moduleY - storageOrientation.height) / 2));
  devices.push(toProductionDevice(storage, storageX, storageY, storageOrientation));
  let sharedX = suppliedX;
  for (const request of [...sharedUpstreamRequests].reverse()) {
    const orientation = sharedOrientations.get(request.id)!;
    sharedX -= orientation.width;
    devices.push(toProductionDevice(request, sharedX, moduleY, orientation));
  }

  const unloaderByConsumerId = new Map(unloaders.map((request) => [request.warehouseConsumerId!, request]));
  const firstUnloader = unloaders[0]!;
  const unloaderOrientation = orient(firstUnloader, "output", "WEST");
  const unloaderX = suppliedX + suppliedColumnWidth + 1;
  const busX = unloaderX + unloaderOrientation.width;
  for (const supplied of suppliedRequests) {
    const target = placedSuppliedById.get(supplied.id);
    const unloader = unloaderByConsumerId.get(supplied.id);
    if (target === undefined || unloader === undefined) return reject(`missing-pair:${supplied.id}`);
    const targetEntity: WorldEntity = {
      id: target.id,
      definitionId: target.definitionId,
      position: target.position,
      rotation: target.rotation,
      config: supplied.config,
      tags: [],
    };
    const targetPoints = new Set(resolveDevicePortEndpoints({
      entity: targetEntity,
      definition: supplied.definition,
      kind: "belt",
      direction: "input",
      pointerGridPoint: target.position,
    }).map((endpoint) => gridKey(endpoint.outsideGridPoint)));
    const candidateYs = Array.from(
      { length: target.height + unloaderOrientation.height + 1 },
      (_, offset) => target.position.y - unloaderOrientation.height + offset,
    ).filter((y) => y >= 0);
    const alignedY = candidateYs.find((y) => {
      const candidateDevice = toProductionDevice(
        unloader,
        unloaderX,
        y,
        unloaderOrientation,
      );
      if (devices.some((device) => rectanglesOverlap(device, candidateDevice))) return false;
      const entity: WorldEntity = {
        id: unloader.id,
        definitionId: unloader.definition.id,
        position: { x: unloaderX, y },
        rotation: unloaderOrientation.rotation,
        config: unloader.config,
        tags: [],
      };
      return resolveDevicePortEndpoints({
        entity,
        definition: unloader.definition,
        kind: "belt",
        direction: "output",
        pointerGridPoint: entity.position,
      }).some((endpoint) => targetPoints.has(gridKey(endpoint.outsideGridPoint)));
    });
    if (alignedY === undefined) return reject(`unaligned-unloader:${supplied.id}`);
    devices.push(toProductionDevice(unloader, unloaderX, alignedY, unloaderOrientation));
  }

  const busSourceOrientation = { ...busSource.definition.footprint, rotation: 0 as const };
  devices.push(toProductionDevice(busSource, busX, 0, busSourceOrientation));
  const requiredSegmentCount = Math.ceil(unloaders.length / 2);
  if (busSegments.length < requiredSegmentCount) return reject("insufficient-bus-segments");
  let busY = busSourceOrientation.height;
  for (const segment of busSegments.slice(0, requiredSegmentCount)) {
    const orientation = { ...segment.definition.footprint, rotation: 0 as const };
    devices.push(toProductionDevice(segment, busX, busY, orientation));
    busY += orientation.height;
  }

  if (devices.length !== productionRequests.length + storageRequests.length + unloaders.length
    + requiredSegmentCount + 1) return reject(`device-count:${devices.length}`);
  if (!hasProductionClearance(devices, 0)) {
    const overlap = devices.flatMap((left, leftIndex) =>
      devices.slice(leftIndex + 1).flatMap((right) =>
        rectanglesOverlap(left, right) ? [JSON.stringify({ left, right })] : []))[0];
    return reject(`device-overlap:${overlap ?? "unknown"}`);
  }
  const bounds = measureBounds(devices);
  if (bounds.width > options.limitWidth || bounds.height > options.limitHeight) return reject("outside-limit");
  const requiredDeviceIds = new Set([
    ...suppliedIds,
    ...downstreamIds,
    ...sharedUpstreamIds,
    storage.id,
  ]);
  const portScore = measureExactPortFeasibility(
    devices,
    options.requests,
    flowEdges,
    options.limitWidth,
    options.limitHeight,
    requiredDeviceIds,
  );
  if (process.env["INDUSTRIAL_PLANNER_TRACE_WAREHOUSE_CLUSTER"] === "1") {
    console.error(
      `[warehouse-supply-cluster-candidate] ports=${String(portScore)} bounds=${bounds.width}x${bounds.height}`,
    );
  }
  if (portScore === null) return reject("port-funnel");
  return {
    devices,
    usedWidth: bounds.width,
    usedHeight: bounds.height,
    equipmentArea: devices.reduce((sum, device) => sum + device.width * device.height, 0),
    debugLabel: `warehouse-supply-cluster:${downstreamRequests.length}x${suppliedRequests.length}`,
  };
}

function createFrontageFanoutSwapNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): PackingResult[] {
  const unloaders = options.packing.devices.filter((device) => device.kind === "warehouse-port");
  if (unloaders.length < 2) return [];
  const unloaderBounds = {
    minX: Math.min(...unloaders.map((device) => device.position.x)),
    minY: Math.min(...unloaders.map((device) => device.position.y)),
    maxX: Math.max(...unloaders.map((device) => device.position.x + device.width)),
    maxY: Math.max(...unloaders.map((device) => device.position.y + device.height)),
  };
  const verticalFrontage = unloaderBounds.maxY - unloaderBounds.minY
    >= unloaderBounds.maxX - unloaderBounds.minX;
  const frontageEnd = verticalFrontage ? unloaderBounds.maxY : unloaderBounds.maxX;
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const flowEdges = createCpSatFlowEdges(
    options.requests.filter((request) => request.kind === "production" || request.kind === "storage"),
    options.registry,
  );
  const generated: Array<{ readonly packing: PackingResult; readonly score: readonly number[] }> = [];
  for (const root of options.packing.devices) {
    const rootRequest = requestById.get(root.id);
    if (root.kind !== "production" || rootRequest === undefined
      || !hasMultiConsumerOutput(rootRequest, options.requests)) continue;
    const rootEnd = verticalFrontage
      ? root.position.y + root.height
      : root.position.x + root.width;
    if (rootEnd <= frontageEnd) continue;
    const rootOutputItems = new Set(rootRequest.outputs.keys());
    const consumerIds = new Set(options.requests
      .filter((request) => [...request.inputs.keys()].some((itemId) => rootOutputItems.has(itemId)))
      .map((request) => request.id));
    const consumerInputItems = new Set(options.requests
      .filter((request) => consumerIds.has(request.id))
      .flatMap((request) => [...request.inputs.keys()]));
    const swapDevices = options.packing.devices.filter((device) => {
      const request = requestById.get(device.id);
      if (device.kind !== "production" || request === undefined || device.id === root.id) return false;
      const insideFrontage = verticalFrontage
        ? device.position.y + device.height <= frontageEnd
        : device.position.x + device.width <= frontageEnd;
      return insideFrontage
        && request.definition.footprint.width === rootRequest.definition.footprint.width
        && request.definition.footprint.height === rootRequest.definition.footprint.height
        && [...request.outputs.keys()].some((itemId) => consumerInputItems.has(itemId));
    });
    const rootRotations = options.allowRotate ? [0, 90, 180, 270] as const : [root.rotation] as const;
    for (const swapDevice of swapDevices) {
      const swapRotations = options.allowRotate ? [0, 90, 180, 270] as const : [swapDevice.rotation] as const;
      for (const rootRotation of rootRotations) {
        for (const swapRotation of swapRotations) {
          const devices = options.packing.devices.map((device): HeadlessPlacedDevice => {
            if (device.id === root.id) {
              return {
                ...device,
                position: { ...swapDevice.position },
                rotation: rootRotation,
              };
            }
            if (device.id === swapDevice.id) {
              return {
                ...device,
                position: { ...root.position },
                rotation: swapRotation,
              };
            }
            return device;
          });
          if (!hasProductionClearance(devices, 0)) continue;
          const portScore = measureExactPortFeasibility(
            devices,
            options.requests,
            flowEdges,
            options.limitWidth,
            options.limitHeight,
            new Set([root.id, swapDevice.id, ...consumerIds]),
          );
          const bounds = measureBounds(devices);
          generated.push({
            packing: {
              devices,
              usedWidth: bounds.width,
              usedHeight: bounds.height,
              equipmentArea: options.packing.equipmentArea,
              debugLabel: `warehouse-supply-cluster:frontage:swap:${root.id}:${swapDevice.id}:${rootRotation},${swapRotation}`,
            },
            score: [
              portScore ?? Number.MAX_SAFE_INTEGER,
              measureEnclosedVoidCells(devices),
              rootRotation === 270 || rootRotation === 90 ? 0 : 1,
              Math.abs(swapDevice.position.y - frontageEnd),
              rootRotation,
              swapRotation,
              swapDevice.position.y,
            ],
          });
        }
      }
    }
  }
  const unique = new Map<string, PackingResult>();
  for (const candidate of generated.sort((left, right) => compareScore(left.score, right.score))) {
    unique.set(packingSignature(candidate.packing), candidate.packing);
  }
  return [...unique.values()].slice(0, 16);
}

/**
 * Inserts an overflowing fan-out device between its consumers and their other
 * producers. Unlike the older spine move, every consumer is repaired
 * independently: no shared translation vector is assumed.
 *
 * This is deliberately an equipment-only search. Existing belts are absent
 * from the packing and therefore cannot veto a placement. The final funnel
 * still requires every affected device to expose enough input/output exterior
 * cells for all material lanes; A* owns the subsequent belt layout.
 */
function createIndependentFanoutInsertionNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): PackingResult[] {
  const unloaders = options.packing.devices.filter((device) => device.kind === "warehouse-port");
  if (unloaders.length < 2) return [];
  const unloaderBounds = {
    minX: Math.min(...unloaders.map((device) => device.position.x)),
    minY: Math.min(...unloaders.map((device) => device.position.y)),
    maxX: Math.max(...unloaders.map((device) => device.position.x + device.width)),
    maxY: Math.max(...unloaders.map((device) => device.position.y + device.height)),
  };
  const verticalFrontage = unloaderBounds.maxY - unloaderBounds.minY
    >= unloaderBounds.maxX - unloaderBounds.minX;
  const frontageStart = verticalFrontage ? unloaderBounds.minY : unloaderBounds.minX;
  const frontageEnd = verticalFrontage ? unloaderBounds.maxY : unloaderBounds.maxX;
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const deviceById = new Map(options.packing.devices.map((device) => [device.id, device]));
  const flowEdges = createCpSatFlowEdges(
    options.requests.filter((request) => request.kind === "production" || request.kind === "storage"),
    options.registry,
  );
  const roots = options.packing.devices.filter((device) => {
    const request = requestById.get(device.id);
    if (device.kind !== "production" || request === undefined) return false;
    const frontageDeviceEnd = verticalFrontage
      ? device.position.y + device.height
      : device.position.x + device.width;
    return frontageDeviceEnd > frontageEnd && hasMultiConsumerOutput(request, options.requests);
  });
  const generated: Array<{
    readonly packing: PackingResult;
    readonly score: readonly number[];
    readonly movementPattern: string;
  }> = [];
  for (const root of roots) {
    const rootRequest = requestById.get(root.id)!;
    const rootOutputItems = new Set(rootRequest.outputs.keys());
    const consumerRequests = options.requests.filter((request) =>
      request.id !== root.id
      && [...request.inputs.keys()].some((itemId) => rootOutputItems.has(itemId)));
    const consumerDevices = consumerRequests.flatMap((request) => {
      const device = deviceById.get(request.id);
      return device === undefined ? [] : [device];
    });
    if (consumerDevices.length === 0 || consumerDevices.length > 4) continue;
    const consumerIds = new Set(consumerDevices.map((device) => device.id));
    const consumerInputItems = new Set(consumerRequests.flatMap((request) => [...request.inputs.keys()]));
    const parallelDevices = options.requests
      .filter((request) => request.id !== root.id
        && !consumerIds.has(request.id)
        && [...request.outputs.keys()].some((itemId) => consumerInputItems.has(itemId)))
      .flatMap((request) => {
        const device = deviceById.get(request.id);
        return device?.kind === "production" ? [device] : [];
      });
    if (parallelDevices.length === 0) continue;
    const averageCenter = (devices: readonly HeadlessPlacedDevice[]) => ({
      x: devices.reduce((sum, device) => sum + device.position.x + device.width / 2, 0) / devices.length,
      y: devices.reduce((sum, device) => sum + device.position.y + device.height / 2, 0) / devices.length,
    });
    const consumerCenter = averageCenter(consumerDevices);
    const parallelCenter = averageCenter(parallelDevices);
    const horizontalBanks = Math.abs(consumerCenter.x - parallelCenter.x)
      >= Math.abs(consumerCenter.y - parallelCenter.y);
    const outward = horizontalBanks
      ? { x: consumerCenter.x < parallelCenter.x ? -1 : 1, y: 0 }
      : { x: 0, y: consumerCenter.y < parallelCenter.y ? -1 : 1 };
    const movableIds = new Set([root.id, ...consumerIds]);
    const fixedDevices = options.packing.devices.filter((device) => !movableIds.has(device.id));
    interface ConsumerPlacementState {
      readonly devices: readonly HeadlessPlacedDevice[];
      readonly movement: number;
      readonly displacementKey: string;
      readonly outwardDistances: readonly number[];
    }
    let beam: ConsumerPlacementState[] = [{
      devices: fixedDevices,
      movement: 0,
      displacementKey: "",
      outwardDistances: [],
    }];
    const orderedConsumers = [...consumerDevices].sort((left, right) =>
      (verticalFrontage ? left.position.y - right.position.y : left.position.x - right.position.x)
      || left.id.localeCompare(right.id));
    for (const original of orderedConsumers) {
      const request = requestById.get(original.id)!;
      const next: ConsumerPlacementState[] = [];
      const rotations = options.allowRotate
        ? [original.rotation, ((original.rotation + 180) % 360) as GridRotation]
        : [original.rotation];
      for (const state of beam) {
        for (let outwardDistance = 0; outwardDistance <= 3; outwardDistance += 1) {
          for (let lateralOffset = -1; lateralOffset <= 1; lateralOffset += 1) {
            for (const rotation of rotations) {
              const swaps = rotation === 90 || rotation === 270;
              const width = swaps
                ? request.definition.footprint.height
                : request.definition.footprint.width;
              const height = swaps
                ? request.definition.footprint.width
                : request.definition.footprint.height;
              const x = original.position.x
                + outward.x * outwardDistance
                + (horizontalBanks ? 0 : lateralOffset);
              const y = original.position.y
                + outward.y * outwardDistance
                + (horizontalBanks ? lateralOffset : 0);
              if (x < 0 || y < 0 || x + width > options.limitWidth || y + height > options.limitHeight) {
                continue;
              }
              const placed: HeadlessPlacedDevice = {
                ...original,
                position: { x, y },
                rotation,
                width,
                height,
              };
              if (state.devices.some((device) => rectanglesOverlap(device, placed))) continue;
              next.push({
                devices: [...state.devices, placed],
                movement: state.movement
                  + outwardDistance
                  + Math.abs(lateralOffset)
                  + Number(rotation !== original.rotation),
                displacementKey: `${state.displacementKey}|${original.id}:${outwardDistance},${lateralOffset},${rotation}`,
                outwardDistances: [...state.outwardDistances, outwardDistance],
              });
            }
          }
        }
      }
      const uniqueStates = new Map<string, ConsumerPlacementState>();
      for (const state of next.sort((left, right) => {
        const leftBounds = measureBounds(left.devices);
        const rightBounds = measureBounds(right.devices);
        return leftBounds.width * leftBounds.height - rightBounds.width * rightBounds.height
          || measureEnclosedVoidCells(left.devices) - measureEnclosedVoidCells(right.devices)
          || left.movement - right.movement
          || left.displacementKey.localeCompare(right.displacementKey);
      })) {
        const signature = packingSignature({
          devices: state.devices,
          usedWidth: 0,
          usedHeight: 0,
          equipmentArea: 0,
        });
        if (!uniqueStates.has(signature)) uniqueStates.set(signature, state);
      }
      // Partition by the complete per-device displacement vector. A plain
      // global beam repeatedly collapsed to (0,0,0), which recreated the old
      // bank move in disguise and discarded the required independent repairs.
      const statesByPattern = new Map<string, ConsumerPlacementState[]>();
      for (const state of uniqueStates.values()) {
        const pattern = state.outwardDistances.join(",");
        const entries = statesByPattern.get(pattern) ?? [];
        if (entries.length < 3) entries.push(state);
        statesByPattern.set(pattern, entries);
      }
      beam = [...statesByPattern.values()].flat().slice(0, 256);
      if (beam.length === 0) break;
    }
    const rootRotations = options.allowRotate ? [0, 90, 180, 270] as const : [root.rotation] as const;
    for (const state of beam) {
      const placedConsumers = state.devices.filter((device) => consumerIds.has(device.id));
      const placedConsumerCenter = averageCenter(placedConsumers);
      const placedParallelCenter = averageCenter(parallelDevices);
      for (const rotation of rootRotations) {
        const swaps = rotation === 90 || rotation === 270;
        const width = swaps ? rootRequest.definition.footprint.height : rootRequest.definition.footprint.width;
        const height = swaps ? rootRequest.definition.footprint.width : rootRequest.definition.footprint.height;
        const corridorStart = horizontalBanks
          ? Math.min(placedConsumerCenter.x, placedParallelCenter.x)
          : Math.min(placedConsumerCenter.y, placedParallelCenter.y);
        const corridorEnd = horizontalBanks
          ? Math.max(placedConsumerCenter.x, placedParallelCenter.x)
          : Math.max(placedConsumerCenter.y, placedParallelCenter.y);
        const minimumCross = Math.max(0, Math.floor(corridorStart) - (horizontalBanks ? width : height));
        const maximumCross = Math.min(
          (horizontalBanks ? options.limitWidth - width : options.limitHeight - height),
          Math.ceil(corridorEnd),
        );
        for (let cross = minimumCross; cross <= maximumCross; cross += 1) {
          for (let frontage = frontageStart; frontage + (horizontalBanks ? height : width) <= frontageEnd; frontage += 1) {
            const x = horizontalBanks ? cross : frontage;
            const y = horizontalBanks ? frontage : cross;
            const movedRoot: HeadlessPlacedDevice = {
              ...root,
              position: { x, y },
              rotation,
              width,
              height,
            };
            if (state.devices.some((device) => rectanglesOverlap(device, movedRoot))) continue;
            const devices = [...state.devices, movedRoot];
            const affectedIds = new Set([
              root.id,
              ...consumerIds,
              ...parallelDevices.map((device) => device.id),
            ]);
            const portScore = measureExactPortFeasibility(
              devices,
              options.requests,
              flowEdges,
              options.limitWidth,
              options.limitHeight,
              affectedIds,
            );
            if (portScore === null) continue;
            const bounds = measureBounds(devices);
            const betweenPenalty = horizontalBanks
              ? Number(!(movedRoot.position.x >= Math.min(
                  ...placedConsumers.map((device) => device.position.x + device.width),
                ) && movedRoot.position.x + movedRoot.width <= Math.min(
                  ...parallelDevices.map((device) => device.position.x),
                )))
              : Number(!(movedRoot.position.y >= Math.min(
                  ...placedConsumers.map((device) => device.position.y + device.height),
                ) && movedRoot.position.y + movedRoot.height <= Math.min(
                  ...parallelDevices.map((device) => device.position.y),
                )));
            generated.push({
              packing: {
                devices,
                usedWidth: bounds.width,
                usedHeight: bounds.height,
                equipmentArea: options.packing.equipmentArea,
                debugLabel: `warehouse-supply-cluster:frontage:independent-insert:${root.id}`
                  + `:${state.displacementKey}:${x},${y},${rotation}`,
              },
              score: [
                betweenPenalty,
                bounds.width * bounds.height,
                measureEnclosedVoidCells(devices),
                portScore,
                state.movement,
                y,
                x,
                rotation,
              ],
              movementPattern: state.outwardDistances.join(","),
            });
          }
        }
      }
    }
  }
  const ordered = generated.sort((left, right) => compareScore(left.score, right.score));
  const bestByMovementPattern = new Map<string, typeof ordered[number]>();
  for (const candidate of ordered) {
    if (!bestByMovementPattern.has(candidate.movementPattern)) {
      bestByMovementPattern.set(candidate.movementPattern, candidate);
    }
  }
  const unique = new Map<string, PackingResult>();
  // First route one representative of every independent displacement vector.
  // Prefer small moves, but prefer vectors that actually open the corridor over
  // the unchanged incumbent.
  for (const candidate of [...bestByMovementPattern.values()].sort((left, right) => {
    const leftDistances = left.movementPattern.split(",").map(Number);
    const rightDistances = right.movementPattern.split(",").map(Number);
    const leftMoved = leftDistances.filter((distance) => distance > 0).length;
    const rightMoved = rightDistances.filter((distance) => distance > 0).length;
    return Number(leftMoved === 0) - Number(rightMoved === 0)
      || leftDistances.reduce((sum, distance) => sum + distance, 0)
        - rightDistances.reduce((sum, distance) => sum + distance, 0)
      || compareScore(left.score, right.score);
  })) {
    unique.set(packingSignature(candidate.packing), candidate.packing);
    if (unique.size >= 40) break;
  }
  for (const candidate of ordered) {
    unique.set(packingSignature(candidate.packing), candidate.packing);
    if (unique.size >= 48) break;
  }
  if (process.env["INDUSTRIAL_PLANNER_TRACE_FRONTAGE_CANDIDATES"] === "1") {
    console.error(`[frontage-independent-insert] roots=${roots.length} generated=${generated.length} accepted=${unique.size}`);
  }
  return [...unique.values()];
}

/**
 * Opens a routing spine for an overflowing fan-out device by moving the two
 * equipment banks on either side away from one another. This is a bounded
 * destroy/repair move: warehouse buses and ports stay fixed, while the fan-out
 * device, its consumers, and the consumers' other producers move together.
 */
function _createFrontageFanoutSpineNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): PackingResult[] {
  const unloaders = options.packing.devices.filter((device) => device.kind === "warehouse-port");
  if (unloaders.length < 2) return [];
  const unloaderBounds = {
    minX: Math.min(...unloaders.map((device) => device.position.x)),
    minY: Math.min(...unloaders.map((device) => device.position.y)),
    maxX: Math.max(...unloaders.map((device) => device.position.x + device.width)),
    maxY: Math.max(...unloaders.map((device) => device.position.y + device.height)),
  };
  const verticalFrontage = unloaderBounds.maxY - unloaderBounds.minY
    >= unloaderBounds.maxX - unloaderBounds.minX;
  const frontageStart = verticalFrontage ? unloaderBounds.minY : unloaderBounds.minX;
  const frontageEnd = verticalFrontage ? unloaderBounds.maxY : unloaderBounds.maxX;
  const currentPackingBounds = measureBounds(options.packing.devices);
  const compactEnvelopeSearch = options.limitWidth - currentPackingBounds.width <= 8
    && options.limitHeight - currentPackingBounds.height <= 8;
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const deviceById = new Map(options.packing.devices.map((device) => [device.id, device]));
  const flowEdges = createCpSatFlowEdges(
    options.requests.filter((request) => request.kind === "production" || request.kind === "storage"),
    options.registry,
  );
  const overflowingFanouts = options.packing.devices.filter((device) => {
    const request = requestById.get(device.id);
    if (device.kind !== "production" || request === undefined) return false;
    const end = verticalFrontage
      ? device.position.y + device.height
      : device.position.x + device.width;
    return end > frontageEnd && hasMultiConsumerOutput(request, options.requests);
  });
  const generated: Array<{ readonly packing: PackingResult; readonly score: readonly number[] }> = [];
  let shiftedBankCount = 0;
  let geometricCandidateCount = 0;
  let portRejectedCount = 0;
  for (const root of overflowingFanouts) {
    const rootRequest = requestById.get(root.id)!;
    const outputItems = new Set(rootRequest.outputs.keys());
    const consumerRequests = options.requests.filter((request) =>
      request.id !== root.id && [...request.inputs.keys()].some((itemId) => outputItems.has(itemId)));
    const consumerIds = new Set(consumerRequests.map((request) => request.id));
    const consumerDevices = consumerRequests.flatMap((request) => {
      const device = deviceById.get(request.id);
      return device === undefined ? [] : [device];
    });
    if (consumerDevices.length === 0) continue;
    const consumerInputItems = new Set(consumerRequests.flatMap((request) => [...request.inputs.keys()]));
    const consumerOutputItems = new Set(consumerRequests.flatMap((request) => [...request.outputs.keys()]));
    const downstreamStorageIds = new Set(options.requests
      .filter((request) => request.kind === "storage"
        && [...request.inputs.keys()].some((itemId) => consumerOutputItems.has(itemId)))
      .map((request) => request.id));
    const parallelRequests = options.requests.filter((request) =>
      request.id !== root.id
      && !consumerIds.has(request.id)
      && [...request.outputs.keys()].some((itemId) => consumerInputItems.has(itemId)));
    const parallelDevices = parallelRequests.flatMap((request) => {
      const device = deviceById.get(request.id);
      return device === undefined || device.kind !== "production" ? [] : [device];
    });
    if (parallelDevices.length === 0) continue;
    const averageCenter = (devices: readonly HeadlessPlacedDevice[]) => ({
      x: devices.reduce((sum, device) => sum + device.position.x + device.width / 2, 0) / devices.length,
      y: devices.reduce((sum, device) => sum + device.position.y + device.height / 2, 0) / devices.length,
    });
    const consumerCenter = averageCenter(consumerDevices);
    const parallelCenter = averageCenter(parallelDevices);
    const horizontalBanks = Math.abs(consumerCenter.x - parallelCenter.x)
      >= Math.abs(consumerCenter.y - parallelCenter.y);
    const unitConsumerDelta = horizontalBanks
      ? { x: consumerCenter.x < parallelCenter.x ? -1 : 1, y: 0 }
      : { x: 0, y: consumerCenter.y < parallelCenter.y ? -1 : 1 };
    const warehouseFedIds = new Set(options.requests
      .filter((request) => request.kind === "warehouse-port" && request.warehouseConsumerId !== undefined)
      .map((request) => request.warehouseConsumerId!));
    const movableParallelDevices = parallelDevices.filter((device) => !warehouseFedIds.has(device.id));
    // A warehouse-fed producer cannot move into its adjacent unloader because
    // that would occupy the input port's exterior cell. If the producer bank
    // is anchored, open one corridor column per outgoing lane, with a bounded
    // neighborhood width to keep this repair finite.
    const rootFanoutLaneCount = flowEdges
      .filter((edge) => edge.sourceId === root.id && consumerIds.has(edge.targetId))
      .reduce((sum, edge) => sum + edge.laneCount, 0);
    const consumerShift = movableParallelDevices.length === 0 && compactEnvelopeSearch
      ? Math.max(1, Math.min(4, rootFanoutLaneCount))
      : 1;
    const consumerDelta = {
      x: unitConsumerDelta.x * consumerShift,
      y: unitConsumerDelta.y * consumerShift,
    };
    const producerDelta = { x: -unitConsumerDelta.x, y: -unitConsumerDelta.y };
    const shiftedParallelIds = new Set(movableParallelDevices.map((device) => device.id));
    const shiftedIds = new Set([...consumerIds, ...shiftedParallelIds]);
    const shifted = options.packing.devices.map((device): HeadlessPlacedDevice => {
      if (consumerIds.has(device.id)) {
        return { ...device, position: {
          x: device.position.x + consumerDelta.x,
          y: device.position.y + consumerDelta.y,
        } };
      }
      if (shiftedParallelIds.has(device.id)) {
        return { ...device, position: {
          x: device.position.x + producerDelta.x,
          y: device.position.y + producerDelta.y,
        } };
      }
      return device;
    });
    const shiftedWithoutRoot = shifted.filter((device) => device.id !== root.id);
    const fixedShiftedBank = compactEnvelopeSearch
      ? shiftedWithoutRoot.filter((device) => !downstreamStorageIds.has(device.id))
      : shiftedWithoutRoot;
    const movableStorageDevices = compactEnvelopeSearch
      ? shiftedWithoutRoot.filter((device) => downstreamStorageIds.has(device.id))
      : [];
    if (shiftedWithoutRoot.some((device) =>
      shiftedIds.has(device.id) && (
        device.position.x < 0
        || device.position.y < 0
        || device.position.x + device.width > options.limitWidth
        || device.position.y + device.height > options.limitHeight
      ))) continue;
    if (!hasProductionClearance(fixedShiftedBank, 0)) continue;
    // More than one target storage would require a combinatorial placement
    // product. Keep this neighborhood bounded rather than multiplying all
    // storage placement combinations.
    if (movableStorageDevices.length > 1) continue;
    shiftedBankCount += 1;
    const rotations = options.allowRotate ? [0, 90, 180, 270] as const : [0] as const;
    for (const rotation of rotations) {
      const swaps = rotation === 90 || rotation === 270;
      const width = swaps ? rootRequest.definition.footprint.height : rootRequest.definition.footprint.width;
      const height = swaps ? rootRequest.definition.footprint.width : rootRequest.definition.footprint.height;
      const consumerMinimumX = Math.min(...consumerDevices.map((device) =>
        device.position.x + consumerDelta.x));
      const consumerMaximumX = Math.max(...consumerDevices.map((device) =>
        device.position.x + consumerDelta.x + device.width));
      const consumerMinimumY = Math.min(...consumerDevices.map((device) =>
        device.position.y + consumerDelta.y));
      const consumerMaximumY = Math.max(...consumerDevices.map((device) =>
        device.position.y + consumerDelta.y + device.height));
      if (horizontalBanks) {
        const x = consumerCenter.x < parallelCenter.x
          ? consumerMaximumX + 1
          : consumerMinimumX - width - 1;
        for (let y = frontageStart; y + height <= frontageEnd; y += 1) {
          addCandidate(x, y);
        }
      } else {
        const y = consumerCenter.y < parallelCenter.y
          ? consumerMaximumY + 1
          : consumerMinimumY - height - 1;
        for (let x = frontageStart; x + width <= frontageEnd; x += 1) {
          addCandidate(x, y);
        }
      }

      function addCandidate(x: number, y: number): void {
        const movedRoot: HeadlessPlacedDevice = {
          ...root,
          position: { x, y },
          rotation,
          width,
          height,
        };
        if (x < 0 || y < 0 || x + width > options.limitWidth || y + height > options.limitHeight) return;
        const storageRotations = options.allowRotate && downstreamStorageIds.size > 0
          ? [0, 90, 180, 270] as const
          : [null] as const;
        for (const storageRotation of storageRotations) {
          const storageDevice = movableStorageDevices[0];
          const storagePlacements: HeadlessPlacedDevice[] = [];
          if (storageDevice !== undefined) {
            const request = requestById.get(storageDevice.id);
            if (request === undefined) continue;
            const resolvedStorageRotation = storageRotation ?? storageDevice.rotation;
            const swapsStorage = storageRotation === 90 || storageRotation === 270;
            const storageWidth = swapsStorage
              ? request.definition.footprint.height
              : request.definition.footprint.width;
            const storageHeight = swapsStorage
              ? request.definition.footprint.width
              : request.definition.footprint.height;
            const occupiedSearchWidth = Math.max(
              movedRoot.position.x + movedRoot.width,
              ...fixedShiftedBank.map((device) => device.position.x + device.width),
            );
            const occupiedSearchHeight = Math.max(
              movedRoot.position.y + movedRoot.height,
              ...fixedShiftedBank.map((device) => device.position.y + device.height),
            );
            const storageSearchWidth = verticalFrontage
              ? Math.min(options.limitWidth, occupiedSearchWidth)
              : options.limitWidth;
            const storageSearchHeight = verticalFrontage
              ? options.limitHeight
              : Math.min(options.limitHeight, occupiedSearchHeight);
            const placementPool: Array<{
              readonly device: HeadlessPlacedDevice;
              readonly score: readonly number[];
            }> = [];
            for (let storageY = 0; storageY + storageHeight <= storageSearchHeight; storageY += 1) {
              for (let storageX = 0; storageX + storageWidth <= storageSearchWidth; storageX += 1) {
                const frontageCoordinate = verticalFrontage ? storageY : storageX;
                const frontageSize = verticalFrontage ? storageHeight : storageWidth;
                if (frontageCoordinate < frontageStart
                  || frontageCoordinate + frontageSize > frontageEnd) continue;
                const placedStorage: HeadlessPlacedDevice = {
                  ...storageDevice,
                  position: { x: storageX, y: storageY },
                  rotation: resolvedStorageRotation,
                  width: storageWidth,
                  height: storageHeight,
                };
                if (rectanglesOverlap(placedStorage, movedRoot)
                  || fixedShiftedBank.some((device) => rectanglesOverlap(placedStorage, device))) continue;
                const center = deviceCenter(placedStorage);
                placementPool.push({
                  device: placedStorage,
                  score: [
                    consumerDevices.reduce((sum, device) => {
                      const consumer = deviceCenter(device);
                      return sum + Math.abs(center.x - consumer.x) + Math.abs(center.y - consumer.y);
                    }, 0),
                    Math.abs(storageX - storageDevice.position.x)
                      + Math.abs(storageY - storageDevice.position.y),
                    storageY,
                    storageX,
                  ],
                });
              }
            }
            for (const placement of placementPool
              .sort((left, right) => compareScore(left.score, right.score))
              .slice(0, 12)) {
              storagePlacements.push(placement.device);
            }
          }
          const placementOptions = storageDevice === undefined
            ? [null] as const
            : storagePlacements;
          for (const placedStorage of placementOptions) {
            const bankDevices = placedStorage === null
              ? fixedShiftedBank
              : [...fixedShiftedBank, placedStorage];
            if (bankDevices.some((device) => rectanglesOverlap(movedRoot, device))) continue;
            geometricCandidateCount += 1;
            const devices = [...bankDevices, movedRoot];
            const requiredIds = new Set([
              root.id,
              ...consumerIds,
              ...parallelDevices.map((device) => device.id),
              ...downstreamStorageIds,
            ]);
            const portScore = measureExactPortFeasibility(
              devices,
              options.requests,
              flowEdges,
              options.limitWidth,
              options.limitHeight,
              requiredIds,
            );
            if (portScore === null) {
              portRejectedCount += 1;
              continue;
            }
            const bounds = measureBounds(devices);
            generated.push({
              packing: {
                devices,
                usedWidth: bounds.width,
                usedHeight: bounds.height,
                equipmentArea: options.packing.equipmentArea,
                debugLabel: `warehouse-supply-cluster:frontage:spine:${root.id}:storage-${String(storageRotation)}`
                  + `:store-${placedStorage?.position.x ?? "none"},${placedStorage?.position.y ?? "none"}`
                  + `:${x},${y},${rotation}`,
              },
              score: [
                bounds.width * bounds.height,
                portScore ?? Number.MAX_SAFE_INTEGER,
                measureEnclosedVoidCells(devices),
                Math.abs(y - root.position.y) + Math.abs(x - root.position.x),
                storageRotation ?? 0,
                rotation,
                y,
                x,
              ],
            });
          }
        }
      }
    }
  }
  const ordered = generated.sort((left, right) => compareScore(left.score, right.score));
  const unique = new Map<string, PackingResult>();
  for (const candidate of ordered.slice(0, 12)) {
    unique.set(packingSignature(candidate.packing), candidate.packing);
  }
  // Preserve the deepest legal insertion for every orientation. The ordinary
  // top-ranked beam can otherwise discard a lower insertion that exposes more
  // independent output tracks.
  const insertionStorageBucketSize = Math.max(1, Math.ceil(options.limitWidth / 2));
  for (const rotation of [0, 90, 180, 270] as const) {
    for (let storageBucket = 0; storageBucket < 2; storageBucket += 1) {
      const candidate = ordered.find((entry) => {
        const label = entry.packing.debugLabel ?? "";
        const rootMatch = label.match(/:(-?\d+),(-?\d+),(0|90|180|270)$/);
        const storageMatch = label.match(/:store-(-?\d+),(-?\d+):/);
        if (rootMatch === null || storageMatch === null || Number(rootMatch[3]) !== rotation) {
          return false;
        }
        const rootY = Number(rootMatch[2]);
        const maximumY = ordered.reduce((maximum, other) => {
          const otherMatch = (other.packing.debugLabel ?? "")
            .match(/:(-?\d+),(-?\d+),(0|90|180|270)$/);
          return otherMatch !== null && Number(otherMatch[3]) === rotation
            ? Math.max(maximum, Number(otherMatch[2]))
            : maximum;
        }, Number.NEGATIVE_INFINITY);
        return rootY === maximumY
          && Math.floor(Number(storageMatch[1]) / insertionStorageBucketSize) === storageBucket;
      });
      if (candidate !== undefined) unique.set(packingSignature(candidate.packing), candidate.packing);
    }
  }
  for (const rotation of [0, 90, 180, 270] as const) {
    for (let yBucket = 0; yBucket < 3; yBucket += 1) {
      const candidate = ordered.find((entry) => {
        const label = entry.packing.debugLabel ?? "";
        const match = label.match(/:(-?\d+),(-?\d+),(0|90|180|270)$/);
        return match !== null
          && Number(match[3]) === rotation
          && Math.floor((Number(match[2]) - frontageStart)
            / Math.max(1, Math.ceil((frontageEnd - frontageStart) / 3))) === yBucket;
      });
      if (candidate !== undefined) unique.set(packingSignature(candidate.packing), candidate.packing);
    }
  }
  const storageHorizontalBucketSize = Math.max(1, Math.ceil(options.limitWidth / 2));
  for (const rotation of [0, 90, 180, 270] as const) {
    for (let rootBucket = 0; rootBucket < 3; rootBucket += 1) {
      for (let storageBucket = 0; storageBucket < 2; storageBucket += 1) {
        const candidate = ordered.find((entry) => {
          const label = entry.packing.debugLabel ?? "";
          const rootMatch = label.match(/:(-?\d+),(-?\d+),(0|90|180|270)$/);
          const storageMatch = label.match(/:store-(-?\d+),(-?\d+):/);
          return rootMatch !== null
            && storageMatch !== null
            && Number(rootMatch[3]) === rotation
            && Math.floor((Number(rootMatch[2]) - frontageStart)
              / Math.max(1, Math.ceil((frontageEnd - frontageStart) / 3))) === rootBucket
            && Math.floor(Number(storageMatch[1]) / storageHorizontalBucketSize) === storageBucket;
        });
        if (candidate !== undefined) {
          unique.set(packingSignature(candidate.packing), candidate.packing);
        }
      }
    }
  }
  // Add the remaining port-feasible candidates after the explicit spatial
  // buckets. Map insertion order keeps the diverse representatives ahead of
  // the final bounded routing sample.
  for (const candidate of ordered) {
    unique.set(packingSignature(candidate.packing), candidate.packing);
  }
  if (process.env["INDUSTRIAL_PLANNER_TRACE_FRONTAGE_CANDIDATES"] === "1") {
    console.error(
      `[frontage-spine-generation] banks=${shiftedBankCount} `
      + `geometric=${geometricCandidateCount} portRejected=${portRejectedCount} `
      + `accepted=${unique.size}`,
    );
  }
  return [...unique.values()].slice(0, compactEnvelopeSearch ? 48 : 24);
}

function createFrontageConstrainedWarehouseNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): PackingResult[] {
  const unloaders = options.packing.devices.filter((device) => device.kind === "warehouse-port");
  if (unloaders.length < 2) return [];
  const unloaderBounds = {
    minX: Math.min(...unloaders.map((device) => device.position.x)),
    minY: Math.min(...unloaders.map((device) => device.position.y)),
    maxX: Math.max(...unloaders.map((device) => device.position.x + device.width)),
    maxY: Math.max(...unloaders.map((device) => device.position.y + device.height)),
  };
  const verticalFrontage = unloaderBounds.maxY - unloaderBounds.minY
    >= unloaderBounds.maxX - unloaderBounds.minX;
  const frontageStart = verticalFrontage ? unloaderBounds.minY : unloaderBounds.minX;
  const frontageEnd = verticalFrontage ? unloaderBounds.maxY : unloaderBounds.maxX;
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const flowEdges = createCpSatFlowEdges(
    options.requests.filter((request) => request.kind === "production" || request.kind === "storage"),
    options.registry,
  );
  const movable = options.packing.devices.filter((device) => {
    const request = requestById.get(device.id);
    if (device.kind !== "production" || request === undefined) return false;
    const end = verticalFrontage
      ? device.position.y + device.height
      : device.position.x + device.width;
    return end > frontageEnd && hasMultiConsumerOutput(request, options.requests);
  });
  const candidates: Array<{ readonly packing: PackingResult; readonly score: readonly number[] }> = [];
  for (const original of movable) {
    const request = requestById.get(original.id)!;
    const otherDevices = options.packing.devices.filter((device) => device.id !== original.id);
    const rotations = options.allowRotate ? [0, 90, 180, 270] as const : [0] as const;
    for (const rotation of rotations) {
      const swaps = rotation === 90 || rotation === 270;
      const width = swaps ? request.definition.footprint.height : request.definition.footprint.width;
      const height = swaps ? request.definition.footprint.width : request.definition.footprint.height;
      const maximumX = Math.min(
        options.limitWidth - width,
        verticalFrontage ? options.limitWidth - width : frontageEnd - width,
      );
      const maximumY = Math.min(
        options.limitHeight - height,
        verticalFrontage ? frontageEnd - height : options.limitHeight - height,
      );
      for (let y = verticalFrontage ? frontageStart : 0; y <= maximumY; y += 1) {
        for (let x = verticalFrontage ? 0 : frontageStart; x <= maximumX; x += 1) {
          const moved: HeadlessPlacedDevice = {
            ...original,
            position: { x, y },
            rotation,
            width,
            height,
          };
          if (otherDevices.some((device) => rectanglesOverlap(moved, device))) continue;
          const devices = [...otherDevices, moved];
          const portScore = measureExactPortFeasibility(
            devices,
            options.requests,
            flowEdges,
            options.limitWidth,
            options.limitHeight,
            new Set([original.id]),
          );
          if (portScore === null) continue;
          const flowScore = measureFlowPlacementScore(
            request,
            { x, y, width, height, rotation },
            otherDevices,
            requestById,
            options.registry,
          );
          const bounds = measureBounds(devices);
          const packing: PackingResult = {
            devices,
            usedWidth: bounds.width,
            usedHeight: bounds.height,
            equipmentArea: options.packing.equipmentArea,
            debugLabel: `warehouse-supply-cluster:frontage:${original.id}:${x},${y},${rotation}`,
          };
          candidates.push({
            packing,
            score: [
              bounds.width * bounds.height,
              measureEnclosedVoidCells(devices),
              flowScore[0],
              portScore,
              flowScore[1],
              Math.abs(x - original.position.x) + Math.abs(y - original.position.y),
              rotation,
              y,
              x,
            ],
          });
        }
      }
    }
  }
  const ordered = candidates.sort((left, right) => compareScore(left.score, right.score));
  const selected = new Map<string, PackingResult>();
  for (const candidate of ordered.slice(0, 8)) {
    selected.set(packingSignature(candidate.packing), candidate.packing);
  }
  // Hole minimization alone tends to place a fan-out machine in a visually
  // compact pocket whose ports face a wall. Preserve a second, graph-oriented
  // beam so candidates adjacent to their consumers survive until real routing.
  const flowOrdered = [...candidates].sort((left, right) => compareScore(
    [left.score[2]!, left.score[3]!, left.score[0]!, left.score[1]!],
    [right.score[2]!, right.score[3]!, right.score[0]!, right.score[1]!],
  ));
  for (const candidate of flowOrdered.slice(0, 8)) {
    selected.set(packingSignature(candidate.packing), candidate.packing);
  }
  const movableIds = new Set(movable.map((device) => device.id));
  const horizontalBucketSize = Math.max(1, Math.ceil(options.packing.usedWidth / 3));
  const verticalBucketSize = Math.max(1, Math.ceil((frontageEnd - frontageStart) / 3));
  for (const rotation of [0, 90, 180, 270] as const) {
    for (let bucket = 0; bucket < 3; bucket += 1) {
      const candidate = ordered.find((entry) => {
        const moved = entry.packing.devices.find((device) => movableIds.has(device.id));
        return moved?.rotation === rotation
          && Math.floor(moved.position.x / horizontalBucketSize) === bucket;
      });
      if (candidate !== undefined) selected.set(packingSignature(candidate.packing), candidate.packing);
    }
    for (let xBucket = 0; xBucket < 3; xBucket += 1) {
      for (let yBucket = 0; yBucket < 3; yBucket += 1) {
        const candidate = ordered.find((entry) => {
          const moved = entry.packing.devices.find((device) => movableIds.has(device.id));
          return moved?.rotation === rotation
            && Math.floor(moved.position.x / horizontalBucketSize) === xBucket
            && Math.floor((moved.position.y - frontageStart) / verticalBucketSize) === yBucket;
        });
        if (candidate !== undefined) selected.set(packingSignature(candidate.packing), candidate.packing);
      }
    }
  }
  for (const rotation of [0, 90, 180, 270] as const) {
    const candidate = ordered.find((entry) =>
      entry.packing.devices.find((device) => movableIds.has(device.id))?.rotation === rotation);
    if (candidate !== undefined) selected.set(packingSignature(candidate.packing), candidate.packing);
  }
  if (process.env["INDUSTRIAL_PLANNER_TRACE_FRONTAGE_CANDIDATES"] === "1") {
    console.error([...selected.values()].map((packing) => packing.debugLabel).join("\n"));
  }
  return [...selected.values()];
}


function packInTerminalClusters(
  requests: readonly DeviceRequest[],
  limitWidth: number,
  limitHeight: number,
  allowRotate: boolean,
  routingClearance: number,
): PackingResult | null {
  const terminals = requests.filter((request) => !requests.some((consumer) =>
    consumer.id !== request.id
    && [...request.outputs.keys()].some((itemId) => consumer.inputs.has(itemId))));
  if (terminals.length < 2) return null;
  const terminalOrientation = new Map(terminals.map((terminal) =>
    [terminal.id, resolveNorthboundOrientation(terminal, allowRotate)]));
  const directProducersByItem = new Map<string, DeviceRequest[]>();
  for (const terminal of terminals) {
    for (const itemId of terminal.inputs.keys()) {
      if (directProducersByItem.has(itemId)) continue;
      directProducersByItem.set(itemId, requests.filter((producer) =>
        producer.id !== terminal.id && producer.outputs.has(itemId)));
    }
  }
  const dedicatedGroups = [...directProducersByItem.values()]
    .filter((producers) => producers.length >= terminals.length);
  const dedicatedByTerminal = terminals.map((): DeviceRequest[] => []);
  for (const producers of dedicatedGroups) {
    producers.forEach((producer, index) => dedicatedByTerminal[index % terminals.length]!.push(producer));
  }
  const assignedIds = new Set([...terminals, ...dedicatedByTerminal.flat()].map((request) => request.id));
  const shared = [...directProducersByItem.values()].flat()
    .filter((producer, index, all) => !assignedIds.has(producer.id)
      && all.findIndex((candidate) => candidate.id === producer.id) === index);
  shared.forEach((request) => assignedIds.add(request.id));
  const remaining = requests.filter((request) => !assignedIds.has(request.id));
  const horizontalGap = 0;
  const portCorridor = 1;
  const clusterWidths = terminals.map((terminal, index) => {
    const terminalWidth = terminalOrientation.get(terminal.id)!.width;
    const producerWidth = dedicatedByTerminal[index]!.reduce((sum, producer, producerIndex) =>
      sum + resolveNorthboundOrientation(producer, allowRotate).width
        + Number(producerIndex > 0) * horizontalGap, 0);
    return Math.max(terminalWidth, producerWidth);
  });
  const totalWidth = clusterWidths.reduce((sum, width) => sum + width, 0)
    + Math.max(0, terminals.length - 1) * horizontalGap;
  if (totalWidth + routingClearance * 2 > limitWidth) return null;
  const devices: HeadlessPlacedDevice[] = [];
  let equipmentArea = 0;
  let x = routingClearance;
  const terminalY = routingClearance;
  let terminalHeight = 0;
  terminals.forEach((terminal, index) => {
    const orientation = terminalOrientation.get(terminal.id)!;
    const deviceX = x + Math.floor((clusterWidths[index]! - orientation.width) / 2);
    devices.push(toProductionDevice(terminal, deviceX, terminalY, orientation));
    equipmentArea += orientation.width * orientation.height;
    terminalHeight = Math.max(terminalHeight, orientation.height);
    x += clusterWidths[index]! + horizontalGap;
  });
  const dedicatedY = terminalY + terminalHeight + portCorridor;
  x = routingClearance;
  let dedicatedHeight = 0;
  dedicatedByTerminal.forEach((producers, index) => {
    const producerWidth = producers.reduce((sum, producer, producerIndex) =>
      sum + resolveNorthboundOrientation(producer, allowRotate).width
        + Number(producerIndex > 0) * horizontalGap, 0);
    let producerX = x + Math.floor((clusterWidths[index]! - producerWidth) / 2);
    for (const producer of producers) {
      const orientation = resolveNorthboundOrientation(producer, allowRotate);
      devices.push(toProductionDevice(producer, producerX, dedicatedY, orientation));
      equipmentArea += orientation.width * orientation.height;
      dedicatedHeight = Math.max(dedicatedHeight, orientation.height);
      producerX += orientation.width + horizontalGap;
    }
    x += clusterWidths[index]! + horizontalGap;
  });
  let y = dedicatedY + dedicatedHeight + portCorridor;
  for (const row of [shared, remaining]) {
    if (row.length === 0) continue;
    const orientations = row.map((request) => resolveNorthboundOrientation(request, allowRotate));
    const rowWidth = orientations.reduce((sum, orientation, index) =>
      sum + orientation.width + Number(index > 0) * horizontalGap, 0);
    let rowX = routingClearance + Math.max(0, Math.floor((totalWidth - rowWidth) / 2));
    let rowHeight = 0;
    row.forEach((request, index) => {
      const orientation = orientations[index]!;
      devices.push(toProductionDevice(request, rowX, y, orientation));
      equipmentArea += orientation.width * orientation.height;
      rowHeight = Math.max(rowHeight, orientation.height);
      rowX += orientation.width + horizontalGap;
    });
    y += rowHeight + portCorridor;
  }
  const bounds = measureBounds(devices);
  if (bounds.width + routingClearance > limitWidth || bounds.height + routingClearance > limitHeight) return null;
  return {
    devices,
    usedWidth: bounds.width + routingClearance,
    usedHeight: bounds.height + routingClearance,
    equipmentArea,
  };
}

function toProductionDevice(
  request: DeviceRequest,
  x: number,
  y: number,
  orientation: { readonly width: number; readonly height: number; readonly rotation: GridRotation },
): HeadlessPlacedDevice {
  return {
    id: request.id,
    definitionId: request.definition.id,
    kind: request.kind,
    recipeId: request.recipeId,
    position: { x, y },
    ...orientation,
  };
}

function packInFlowLayers(
  requests: readonly DeviceRequest[],
  limitWidth: number,
  limitHeight: number,
  allowRotate: boolean,
  routingClearance: number,
  deviceClearance: {
    readonly horizontal: number;
    readonly vertical: number;
  },
): PackingResult | null {
  const consumersByRequestId = new Map<string, DeviceRequest[]>();
  for (const producer of requests) {
    consumersByRequestId.set(producer.id, requests.filter((consumer) =>
      consumer.id !== producer.id
      && [...producer.outputs.keys()].some((itemId) => consumer.inputs.has(itemId))));
  }
  const memo = new Map<string, number>();
  const resolveLayer = (request: DeviceRequest, visiting: Set<string>): number => {
    const cached = memo.get(request.id);
    if (cached !== undefined) return cached;
    if (visiting.has(request.id)) return 0;
    const nextVisiting = new Set(visiting).add(request.id);
    const consumers = consumersByRequestId.get(request.id) ?? [];
    const layer = consumers.length === 0
      ? 0
      : 1 + Math.max(...consumers.map((consumer) => resolveLayer(consumer, nextVisiting)));
    memo.set(request.id, layer);
    return layer;
  };
  const layers = new Map<number, DeviceRequest[]>();
  for (const request of requests) {
    const layer = resolveLayer(request, new Set());
    const devices = layers.get(layer) ?? [];
    devices.push(request);
    layers.set(layer, devices);
  }
  const placed: HeadlessPlacedDevice[] = [];
  let y = routingClearance;
  let equipmentArea = 0;
  for (const layer of [...layers.keys()].sort((left, right) => left - right)) {
    const row = layers.get(layer)!.sort((left, right) => left.id.localeCompare(right.id));
    let x = routingClearance;
    let rowHeight = 0;
    for (const request of row) {
      const orientation = resolveNorthboundOrientation(request, allowRotate);
      if (x + orientation.width + routingClearance > limitWidth) return null;
      placed.push({
        id: request.id,
        definitionId: request.definition.id,
        kind: request.kind,
        recipeId: request.recipeId,
        position: { x, y },
        ...orientation,
      });
    x += orientation.width + deviceClearance.horizontal;
      rowHeight = Math.max(rowHeight, orientation.height);
      equipmentArea += orientation.width * orientation.height;
    }
    y += rowHeight + deviceClearance.vertical;
    if (y + routingClearance > limitHeight) return null;
  }
  const bounds = measureBounds(placed);
  return {
    devices: placed,
    usedWidth: bounds.width + routingClearance,
    usedHeight: bounds.height + routingClearance,
    equipmentArea,
  };
}

function resolveNorthboundOrientation(
  request: DeviceRequest,
  allowRotate: boolean,
): { readonly width: number; readonly height: number; readonly rotation: GridRotation } {
  const base = request.definition.footprint;
  const rotations: readonly GridRotation[] = allowRotate ? [0, 90, 180, 270] : [0];
  const rotation = rotations.find((candidate) =>
    resolvePortEdge(request, "output", candidate) === "NORTH"
    && resolvePortEdge(request, "input", candidate) === "SOUTH") ?? rotations[0]!;
  return rotation === 90 || rotation === 270
    ? { width: base.height, height: base.width, rotation }
    : { width: base.width, height: base.height, rotation };
}

function buildOrderings(
  requests: readonly DeviceRequest[],
  searchIterations: number,
  searchSeed: number,
): DeviceRequest[][] {
  const area = (request: DeviceRequest) => request.definition.footprint.width * request.definition.footprint.height;
  const longest = (request: DeviceRequest) => Math.max(request.definition.footprint.width, request.definition.footprint.height);
  const shortest = (request: DeviceRequest) => Math.min(request.definition.footprint.width, request.definition.footprint.height);
  const comparators = [
    (left: DeviceRequest, right: DeviceRequest) => area(right) - area(left),
    (left: DeviceRequest, right: DeviceRequest) => longest(right) - longest(left) || area(right) - area(left),
    (left: DeviceRequest, right: DeviceRequest) => shortest(right) - shortest(left) || area(right) - area(left),
    (left: DeviceRequest, right: DeviceRequest) => right.definition.footprint.height - left.definition.footprint.height,
    (left: DeviceRequest, right: DeviceRequest) => right.definition.footprint.width - left.definition.footprint.width,
  ];
  const unique = new Map<string, DeviceRequest[]>();
  const flowOrdering = buildUpstreamToDownstreamOrdering(requests, area);
  unique.set(flowOrdering.map((item) => item.id).join("|"), flowOrdering);
  const dependencyOrdering = buildDependencyOrdering(requests, area);
  unique.set(dependencyOrdering.map((item) => item.id).join("|"), dependencyOrdering);
  for (const comparator of comparators) {
    const ordered = [...requests].sort((left, right) => comparator(left, right) || left.id.localeCompare(right.id));
    unique.set(ordered.map((item) => item.id).join("|"), ordered);
  }
  const random = createDeterministicRandom(searchSeed);
  let current = [...(unique.values().next().value ?? requests)];
  for (let iteration = 0; iteration < searchIterations; iteration += 1) {
    if (iteration % 5 === 0) {
      const seeds = [...unique.values()];
      current = [...(seeds[iteration % Math.max(1, seeds.length)] ?? requests)];
    }
    current = mutateOrdering(current, random, iteration);
    unique.set(current.map((item) => item.id).join("|"), [...current]);
  }
  return [...unique.values()];
}

function buildUpstreamToDownstreamOrdering(
  requests: readonly DeviceRequest[],
  area: (request: DeviceRequest) => number,
): DeviceRequest[] {
  const remaining = new Map(requests.map((request) => [request.id, request]));
  const placedIds = new Set<string>();
  const producersByItem = new Map<string, DeviceRequest[]>();
  for (const request of requests) {
    for (const itemId of request.outputs.keys()) {
      const producers = producersByItem.get(itemId) ?? [];
      producers.push(request);
      producersByItem.set(itemId, producers);
    }
  }
  const ordered: DeviceRequest[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((request) =>
      [...request.inputs.keys()].every((itemId) =>
        (producersByItem.get(itemId) ?? []).every((producer) => placedIds.has(producer.id))));
    // A production cycle has no topological head. Break it deterministically;
    // subsequent devices in the cycle then become ready and stay adjacent.
    const candidates = ready.length > 0 ? ready : [...remaining.values()];
    const next = candidates.sort((left, right) =>
      area(right) - area(left) || left.id.localeCompare(right.id))[0]!;
    ordered.push(next);
    placedIds.add(next.id);
    remaining.delete(next.id);
  }
  return ordered;
}

function buildDependencyOrdering(
  requests: readonly DeviceRequest[],
  area: (request: DeviceRequest) => number,
): DeviceRequest[] {
  const remaining = new Map(requests.map((request) => [request.id, request]));
  const ordered: DeviceRequest[] = [];
  const first = [...requests].sort((left, right) =>
    area(right) - area(left) || left.id.localeCompare(right.id))[0];
  if (first === undefined) return ordered;
  ordered.push(first);
  remaining.delete(first.id);
  while (remaining.size > 0) {
    const next = [...remaining.values()].sort((left, right) => {
      const leftConnections = countMaterialConnections(left, ordered);
      const rightConnections = countMaterialConnections(right, ordered);
      return rightConnections - leftConnections
        || area(right) - area(left)
        || left.id.localeCompare(right.id);
    })[0]!;
    ordered.push(next);
    remaining.delete(next.id);
  }
  return ordered;
}

function countMaterialConnections(
  candidate: DeviceRequest,
  placed: readonly DeviceRequest[],
): number {
  let count = 0;
  for (const device of placed) {
    for (const itemId of candidate.inputs.keys()) {
      if (device.outputs.has(itemId)) count += 1;
    }
    for (const itemId of candidate.outputs.keys()) {
      if (device.inputs.has(itemId)) count += 1;
    }
  }
  return count;
}

function packInOrder(
  requests: readonly DeviceRequest[],
  registry: RegistryContract,
  limitWidth: number,
  limitHeight: number,
  allowRotate: boolean,
  routingClearance: number,
  deviceClearance: number,
  placementVariant: number,
): PackingResult | null {
  const occupied = new Uint8Array(limitWidth * limitHeight);
  const devices: HeadlessPlacedDevice[] = [];
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  let usedWidth = 0;
  let usedHeight = 0;
  let equipmentArea = 0;

  for (const request of requests) {
    const base = request.definition.footprint;
    const orientations = allowRotate
      ? [
          { width: base.width, height: base.height, rotation: 0 as const },
          { width: base.height, height: base.width, rotation: 90 as const },
          { width: base.width, height: base.height, rotation: 180 as const },
          { width: base.height, height: base.width, rotation: 270 as const },
        ]
      : [{ width: base.width, height: base.height, rotation: 0 as const }];
    let choice: HeadlessPlacedDevice | null = null;
    let choiceScore: readonly number[] | null = null;
    for (const orientation of orientations) {
      const maximumX = limitWidth - routingClearance - orientation.width;
      const maximumY = limitHeight - routingClearance - orientation.height;
      for (let y = routingClearance; y <= maximumY; y += 1) {
        for (let x = routingClearance; x <= maximumX; x += 1) {
          // Explore several geometric gaps, including touching devices. Port
          // resolution and A* ultimately reject candidates that block a required
          // input/output, so unused sides do not need a permanent routing halo.
          const clearanceX = Math.max(0, x - deviceClearance);
          const clearanceY = Math.max(0, y - deviceClearance);
          const clearanceRight = Math.min(limitWidth, x + orientation.width + deviceClearance);
          const clearanceBottom = Math.min(limitHeight, y + orientation.height + deviceClearance);
          if (!isFree(
            occupied,
            limitWidth,
            clearanceX,
            clearanceY,
            clearanceRight - clearanceX,
            clearanceBottom - clearanceY,
          )) {
            continue;
          }
          const nextWidth = Math.max(usedWidth, x + orientation.width + routingClearance);
          const nextHeight = Math.max(usedHeight, y + orientation.height + routingClearance);
          const area = nextWidth * nextHeight;
          const longestSide = Math.max(nextWidth, nextHeight);
          const flowScore = placementVariant === 3
            ? measureFlowPlacementScore(request, { x, y, ...orientation }, devices, requestsById, registry)
            : [0, 0];
          const score = placementVariant === 1
            ? [longestSide, area, nextHeight, nextWidth, y, x]
            : placementVariant === 2
              ? [nextHeight, area, longestSide, nextWidth, y, x]
              : placementVariant === 3
                ? [area, ...flowScore, longestSide, nextHeight, nextWidth, y, x]
                : [area, longestSide, nextHeight, nextWidth, y, x];
          if (choiceScore === null || compareScore(score, choiceScore) < 0) {
            choiceScore = score;
            choice = {
              id: request.id,
              definitionId: request.definition.id,
              kind: request.kind,
              recipeId: request.recipeId,
              position: { x, y },
              rotation: orientation.rotation,
              width: orientation.width,
              height: orientation.height,
            };
          }
        }
      }
    }
    if (choice === null) {
      return null;
    }
    occupy(
      occupied,
      limitWidth,
      choice.position.x,
      choice.position.y,
      choice.width,
      choice.height,
    );
    devices.push(choice);
    usedWidth = Math.max(usedWidth, choice.position.x + choice.width + routingClearance);
    usedHeight = Math.max(usedHeight, choice.position.y + choice.height + routingClearance);
    equipmentArea += choice.width * choice.height;
  }
  return { devices, usedWidth, usedHeight, equipmentArea };
}

function measureFlowPlacementScore(
  request: DeviceRequest,
  candidate: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly rotation: GridRotation;
  },
  devices: readonly HeadlessPlacedDevice[],
  requestsById: ReadonlyMap<string, DeviceRequest>,
  registry: RegistryContract,
): readonly [number, number] {
  let directionPenalty = 0;
  let distance = 0;
  for (const device of devices) {
    const placed = requestsById.get(device.id);
    if (placed === undefined) continue;
    const placedFeedsCandidate = measureDirectedFlowLaneCount(placed, request, registry);
    const candidateFeedsPlaced = measureDirectedFlowLaneCount(request, placed, registry);
    if (placedFeedsCandidate === 0 && candidateFeedsPlaced === 0) continue;
    const horizontalGap = Math.max(
      0,
      candidate.x - (device.position.x + device.width),
      device.position.x - (candidate.x + candidate.width),
    );
    const verticalGap = Math.max(
      0,
      candidate.y - (device.position.y + device.height),
      device.position.y - (candidate.y + candidate.height),
    );
    distance += (horizontalGap + verticalGap) * (placedFeedsCandidate + candidateFeedsPlaced);
    const candidateCenter = {
      x: candidate.x + candidate.width / 2,
      y: candidate.y + candidate.height / 2,
    };
    const placedCenter = {
      x: device.position.x + device.width / 2,
      y: device.position.y + device.height / 2,
    };
    if (placedFeedsCandidate > 0) {
      directionPenalty += placedFeedsCandidate * measurePortDirectionPenalty(
        resolvePortEdge(placed, "output", device.rotation),
        candidateCenter.x - placedCenter.x,
        candidateCenter.y - placedCenter.y,
      );
      directionPenalty += placedFeedsCandidate * measurePortDirectionPenalty(
        resolvePortEdge(request, "input", candidate.rotation),
        placedCenter.x - candidateCenter.x,
        placedCenter.y - candidateCenter.y,
      );
    }
    if (candidateFeedsPlaced > 0) {
      directionPenalty += candidateFeedsPlaced * measurePortDirectionPenalty(
        resolvePortEdge(request, "output", candidate.rotation),
        placedCenter.x - candidateCenter.x,
        placedCenter.y - candidateCenter.y,
      );
      directionPenalty += candidateFeedsPlaced * measurePortDirectionPenalty(
        resolvePortEdge(placed, "input", device.rotation),
        candidateCenter.x - placedCenter.x,
        candidateCenter.y - placedCenter.y,
      );
    }
  }
  directionPenalty += measureCandidatePortCorridorPenalty(
    request,
    candidate,
    devices,
    requestsById,
    registry,
  );
  return [directionPenalty, distance];
}

function measureDirectedFlowLaneCount(
  producer: DeviceRequest,
  consumer: DeviceRequest,
  registry: RegistryContract,
): number {
  let lanes = 0;
  for (const [itemId, outputPerMinute] of producer.outputs) {
    const inputPerMinute = consumer.inputs.get(itemId) ?? 0;
    if (inputPerMinute <= 0.000001) continue;
    lanes += resolveRequiredLogisticsLaneCount(
      Math.min(outputPerMinute, inputPerMinute),
      resolveItemLogisticsKind(itemId, registry),
    );
  }
  return lanes;
}

function measureCandidatePortCorridorPenalty(
  request: DeviceRequest,
  candidate: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly rotation: GridRotation;
  },
  devices: readonly HeadlessPlacedDevice[],
  requestsById: ReadonlyMap<string, DeviceRequest>,
  registry: RegistryContract,
): number {
  const entity: WorldEntity = {
    id: `score:${request.id}`,
    definitionId: request.definition.id,
    position: { x: candidate.x, y: candidate.y },
    rotation: candidate.rotation,
    config: request.config,
    tags: [],
  };
  const isOccupied = (point: GridPoint): boolean => devices.some((device) =>
    point.x >= device.position.x && point.x < device.position.x + device.width
    && point.y >= device.position.y && point.y < device.position.y + device.height);
  let penalty = 0;
  for (const direction of ["input", "output"] as const) {
    for (const kind of ["belt", "pipe"] as const) {
      const required = devices.reduce((sum, device) => {
        const placed = requestsById.get(device.id);
        if (placed === undefined) return sum;
        const producer = direction === "input" ? placed : request;
        const consumer = direction === "input" ? request : placed;
        let lanes = 0;
        for (const [itemId, outputPerMinute] of producer.outputs) {
          if (resolveItemLogisticsKind(itemId, registry) !== kind) continue;
          const inputPerMinute = consumer.inputs.get(itemId) ?? 0;
          if (inputPerMinute <= 0.000001) continue;
          lanes += resolveRequiredLogisticsLaneCount(
            Math.min(outputPerMinute, inputPerMinute),
            kind,
          );
        }
        return sum + lanes;
      }, 0);
      if (required === 0) continue;
      const accesses = resolveDevicePortEndpoints({
        entity,
        definition: request.definition,
        kind,
        direction,
        pointerGridPoint: entity.position,
      }).filter((endpoint) => !isOccupied(endpoint.outsideGridPoint))
        .map((endpoint) => {
          const point = endpoint.outsideGridPoint;
          const escapeOptions = [
            { x: point.x - 1, y: point.y },
            { x: point.x + 1, y: point.y },
            { x: point.x, y: point.y - 1 },
            { x: point.x, y: point.y + 1 },
          ].filter((neighbor) => neighbor.x >= 0 && neighbor.y >= 0 && !isOccupied(neighbor)).length;
          return { key: gridKey(point), escapeOptions };
        });
      const unique = [...new Map(accesses.map((access) => [access.key, access])).values()]
        .sort((left, right) => right.escapeOptions - left.escapeOptions);
      penalty += Math.max(0, required - unique.length) * 1_000;
      penalty += unique.slice(0, required)
        .reduce((sum, access) => sum + Math.max(0, 2 - access.escapeOptions) * 8, 0);
    }
  }
  return penalty;
}

function resolvePortEdge(
  request: DeviceRequest,
  direction: "input" | "output",
  rotation: GridRotation,
): GridEdge | null {
  const port = request.definition.portGroups
    .find((group) => group.kind === "item" && (group.direction === direction || group.direction === "bidirectional"))
    ?.ports[0];
  return port === undefined ? null : rotateGridEdge(port.edge, rotation);
}

function oppositeGridEdge(edge: GridEdge): GridEdge {
  switch (edge) {
    case "NORTH": return "SOUTH";
    case "EAST": return "WEST";
    case "SOUTH": return "NORTH";
    case "WEST": return "EAST";
  }
}

function areRectanglesEdgeAdjacent(
  left: HeadlessPlacedDevice,
  right: HeadlessPlacedDevice,
): boolean {
  const overlapsX = left.position.x < right.position.x + right.width
    && left.position.x + left.width > right.position.x;
  const overlapsY = left.position.y < right.position.y + right.height
    && left.position.y + left.height > right.position.y;
  return (overlapsX && (
    left.position.y === right.position.y + right.height
    || left.position.y + left.height === right.position.y
  )) || (overlapsY && (
    left.position.x === right.position.x + right.width
    || left.position.x + left.width === right.position.x
  ));
}

function isRectangleAdjacentOnEdge(
  device: HeadlessPlacedDevice,
  candidate: HeadlessPlacedDevice,
  edge: GridEdge,
): boolean {
  const overlapsX = device.position.x < candidate.position.x + candidate.width
    && device.position.x + device.width > candidate.position.x;
  const overlapsY = device.position.y < candidate.position.y + candidate.height
    && device.position.y + device.height > candidate.position.y;
  switch (edge) {
    case "NORTH":
      return device.position.y === candidate.position.y + candidate.height && overlapsX;
    case "EAST":
      return device.position.x + device.width === candidate.position.x && overlapsY;
    case "SOUTH":
      return device.position.y + device.height === candidate.position.y && overlapsX;
    case "WEST":
      return device.position.x === candidate.position.x + candidate.width && overlapsY;
  }
}

/**
 * Mirror the editor's warehouse-hub placement rule inside headless search.
 * Every bus segment must be edge-connected to the source through other valid
 * segments, and every port must touch that connected bus on the side opposite
 * its physical item port.
 */
function hasValidWarehouseHubAdjacency(
  devices: readonly HeadlessPlacedDevice[],
  requests: readonly DeviceRequest[],
): boolean {
  const busSource = devices.find((device) => device.id === "warehouse-bus-source");
  const busSegments = devices.filter((device) =>
    device.kind === "warehouse-bus" && device.id !== "warehouse-bus-source");
  const warehousePorts = devices.filter((device) => device.kind === "warehouse-port");
  if (busSource === undefined) {
    return busSegments.length === 0 && warehousePorts.length === 0;
  }

  const connectedSegmentIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const segment of busSegments) {
      if (connectedSegmentIds.has(segment.id)) continue;
      const connectsToSource = areRectanglesEdgeAdjacent(segment, busSource);
      const connectsToSegment = busSegments.some((candidate) =>
        connectedSegmentIds.has(candidate.id)
        && areRectanglesEdgeAdjacent(segment, candidate));
      if (!connectsToSource && !connectsToSegment) continue;
      connectedSegmentIds.add(segment.id);
      changed = true;
    }
  }
  if (connectedSegmentIds.size !== busSegments.length) return false;

  const requestById = new Map(requests.map((request) => [request.id, request]));
  const connectedBus = [
    busSource,
    ...busSegments.filter((segment) => connectedSegmentIds.has(segment.id)),
  ];
  return warehousePorts.every((port) => {
    const request = requestById.get(port.id);
    const basePortEdge = request?.definition.portGroups[0]?.ports[0]?.edge;
    if (basePortEdge === undefined) return false;
    const requiredBusEdge = oppositeGridEdge(rotateGridEdge(basePortEdge, port.rotation));
    return connectedBus.some((candidate) =>
      isRectangleAdjacentOnEdge(port, candidate, requiredBusEdge));
  });
}

function resolvePortFacingRotation(
  request: DeviceRequest | undefined,
  direction: "input" | "output",
  desiredEdge: GridEdge,
): GridRotation | null {
  if (request === undefined) return null;
  return ([0, 90, 180, 270] as const).find((rotation) =>
    resolvePortEdge(request, direction, rotation) === desiredEdge) ?? null;
}

function measurePortDirectionPenalty(edge: GridEdge | null, deltaX: number, deltaY: number): number {
  if (edge === null) return 0;
  switch (edge) {
    case "NORTH": return Math.max(0, deltaY);
    case "EAST": return Math.max(0, -deltaX);
    case "SOUTH": return Math.max(0, -deltaY);
    case "WEST": return Math.max(0, deltaX);
  }
}

function createRouteFailureBacktrackingNeighbors(options: {
  readonly packing: PackingResult;
  readonly evidence: RouteFailureEvidence;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly enableCpSat: boolean;
  readonly targetedOnly?: boolean;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): PackingNeighborSet {
  const unloaders = options.packing.devices.filter((device) => device.kind === "warehouse-port");
  if (unloaders.length === 0) {
    return {
      packings: [],
      clusterGenerated: 0,
      clusterCheapRejected: 0,
      globalRebuildGenerated: 0,
      partialRebuildGenerated: 0,
      globalRebuildCpSatElapsedMs: 0,
      objectiveHotspotDeviceIds: [],
    };
  }
  const frontageBounds = {
    minX: Math.min(...unloaders.map((device) => device.position.x)),
    minY: Math.min(...unloaders.map((device) => device.position.y)),
    maxX: Math.max(...unloaders.map((device) => device.position.x + device.width)),
    maxY: Math.max(...unloaders.map((device) => device.position.y + device.height)),
  };
  const verticalFrontage = frontageBounds.maxY - frontageBounds.minY
    >= frontageBounds.maxX - frontageBounds.minX;
  const blockerFrequency = new Map<string, number>();
  for (const blocker of options.evidence.frontierBlockers) {
    if (blocker.ownerDeviceId === null) continue;
    blockerFrequency.set(blocker.ownerDeviceId, (blockerFrequency.get(blocker.ownerDeviceId) ?? 0) + 1);
  }
  for (const id of [options.evidence.sourceDeviceId, options.evidence.targetDeviceId]) {
    if (id !== null) blockerFrequency.set(id, (blockerFrequency.get(id) ?? 0) + 1);
  }
  const movableIds = [...blockerFrequency]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([id]) => id)
    .filter((id) => {
      const device = options.packing.devices.find((candidate) => candidate.id === id);
      return device?.kind === "production" || device?.kind === "storage";
    })
    .slice(0, 6);
  const cpSatLayouts = new Map<string, PackingResult>();
  const placeableRequests = options.requests.filter((request) =>
    (request.kind === "production" || request.kind === "storage")
    && options.packing.devices.some((device) => device.id === request.id));
  const requestById = new Map(placeableRequests.map((request) => [request.id, request]));
  const incumbentById = new Map(options.packing.devices.map((device) => [device.id, device]));
  const certifiedPoseCut = createRouteFailurePoseCut(options.packing, options.evidence);
  const certifiedCapacityCut = createRouteFailureCapacityCut(options.packing, options.evidence);
  const cpSatMovableIds = new Set([
    options.evidence.sourceDeviceId,
    options.evidence.targetDeviceId,
    ...movableIds.slice(0, 4),
  ].filter((id): id is string => id !== null && requestById.has(id)));
  if (certifiedPoseCut.length > 0
    && !certifiedPoseCut.some((placement) => cpSatMovableIds.has(placement.id))) {
    const certifiedMovable = certifiedPoseCut.find((placement) => requestById.has(placement.id));
    if (certifiedMovable !== undefined) cpSatMovableIds.add(certifiedMovable.id);
  }
  const cpSatLimitWidth = verticalFrontage ? options.limitWidth : frontageBounds.maxX;
  const cpSatLimitHeight = verticalFrontage ? frontageBounds.maxY : options.limitHeight;
  const fixedPlaceableInside = placeableRequests.every((request) => {
    if (cpSatMovableIds.has(request.id)) return true;
    const device = incumbentById.get(request.id)!;
    return device.position.x >= 0 && device.position.y >= 0
      && device.position.x + device.width <= cpSatLimitWidth
      && device.position.y + device.height <= cpSatLimitHeight;
  });
  let generatedCount = 0;
  if (options.targetedOnly !== true
    && options.enableCpSat
    && cpSatMovableIds.size >= (certifiedPoseCut.length > 0 ? 1 : 2)
    && fixedPlaceableInside) {
    const flowEdges = createCpSatFlowEdges(placeableRequests, options.registry);
    const cpSatResult = solveCpSatLayouts({
      devices: placeableRequests.map((request) => {
        const incumbent = incumbentById.get(request.id)!;
        return {
          id: request.id,
          width: request.definition.footprint.width,
          height: request.definition.footprint.height,
          hintPlacement: {
            x: incumbent.position.x,
            y: incumbent.position.y,
            rotation: incumbent.rotation,
          },
          fixedPlacement: cpSatMovableIds.has(request.id) ? undefined : {
            x: incumbent.position.x,
            y: incumbent.position.y,
            rotation: incumbent.rotation,
          },
          portRequirements: cpSatMovableIds.has(request.id)
            ? createCpSatPortRequirements(request, flowEdges)
            : undefined,
        };
      }),
      fixedObstacles: options.packing.devices
        .filter((device) => !requestById.has(device.id))
        .filter((device) => device.position.x < cpSatLimitWidth && device.position.y < cpSatLimitHeight)
        .map((device) => ({
          id: device.id,
          x: device.position.x,
          y: device.position.y,
          width: device.width,
          height: device.height,
        })),
      edges: flowEdges,
      clusters: [],
      limitWidth: cpSatLimitWidth,
      limitHeight: cpSatLimitHeight,
      routingClearance: 0,
      allowRotate: options.allowRotate,
      maxSeconds: 1,
      candidateCount: 8,
      seed: normalizeSearchSeed(hashString(
        `${packingSignature(options.packing)}:${routeFailureEvidenceKey(options.evidence)}`,
      )),
      ...(certifiedPoseCut.length === 0 ? {} : { forbiddenLayouts: [certifiedPoseCut] }),
      ...(certifiedCapacityCut === null ? {} : { capacityCuts: [certifiedCapacityCut] }),
      objectiveWeights: DEFAULT_CP_SAT_OBJECTIVE_WEIGHTS,
    });
    if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTE_FAILURE_LNS"] === "1") {
      console.error(
        `[route-failure-cpsat] movable=${[...cpSatMovableIds].sort().join(",")} `
        + `cut=${certifiedPoseCut.length} `
        + `capacityCut=${String(certifiedCapacityCut !== null)} `
        + `status=${cpSatResult.status} layouts=${cpSatResult.layouts.length}`,
      );
    }
    generatedCount += cpSatResult.layouts.length;
    for (const layout of cpSatResult.layouts) {
      const placementById = new Map(layout.map((placement) => [placement.id, placement]));
      if (placementById.size !== placeableRequests.length) continue;
      const devices = options.packing.devices.map((device): HeadlessPlacedDevice => {
        const placement = placementById.get(device.id);
        const request = requestById.get(device.id);
        return placement === undefined || request === undefined
          ? device
          : toProductionDevice(request, placement.x, placement.y, placement);
      });
      if (!hasProductionClearance(devices, 0)) continue;
      const packing = createMovedPacking(options.packing, devices, 0);
      const candidate: PackingResult = { ...packing, debugLabel: "route-failure-cpsat" };
      cpSatLayouts.set(packingSignature(candidate), candidate);
    }
  }
  const failureFlowEdges = createCpSatFlowEdges(placeableRequests, options.registry);
  const largeNeighborhoodLayouts = new Map<string, {
    readonly packing: PackingResult;
    readonly rootDeviceId: string;
    readonly score: readonly number[];
  }>();
  const failedEndpointIds = [options.evidence.targetDeviceId, options.evidence.sourceDeviceId]
    .filter((id): id is string => id !== null)
    .filter((id, index, all) => all.indexOf(id) === index)
    .filter((id) => {
      const device = options.packing.devices.find((candidate) => candidate.id === id);
      return device?.kind === "production" || device?.kind === "storage";
    });
  for (const rootDeviceId of options.targetedOnly === true ? [] : failedEndpointIds) {
    const rootRequest = options.requests.find((request) => request.id === rootDeviceId);
    const connectedDeviceIds = new Set(options.requests.filter((request) => {
      if (request.id === rootDeviceId || rootRequest === undefined) return false;
      const rootFeedsRequest = [...rootRequest.outputs.keys()].some((itemId) => request.inputs.has(itemId));
      const requestFeedsRoot = [...request.outputs.keys()].some((itemId) => rootRequest.inputs.has(itemId));
      return rootFeedsRequest || requestFeedsRoot;
    }).map((request) => request.id));
    const connectedDevices = options.packing.devices.filter((device) => connectedDeviceIds.has(device.id));
    const failureSlots = detectSlots({
      devices: options.packing.devices,
      logisticsDevices: [],
      targetDeviceId: rootDeviceId,
      limitWidth: verticalFrontage ? options.limitWidth : frontageBounds.maxX,
      limitHeight: verticalFrontage ? frontageBounds.maxY : options.limitHeight,
      allowRotate: options.allowRotate,
      maxPotentialBlockers: 4,
    });
    const scoreFailureSlot = (slot: Slot): readonly number[] => {
      const center = { x: slot.position.x + slot.width / 2, y: slot.position.y + slot.height / 2 };
      const graphDistance = connectedDevices.reduce((sum, device) =>
        sum + manhattan(center, deviceCenter(device)), 0);
      return [
        slot.blockingDeviceIds.length,
        graphDistance,
        -slot.score.portAccessibility,
        -slot.score.boundaryReductionPotential,
        slot.position.y,
        slot.position.x,
        slot.rotation,
      ];
    };
    const graphOrderedSlots = [...failureSlots].sort((left, right) =>
      compareScore(scoreFailureSlot(left), scoreFailureSlot(right)));
    const selectedSlots = new Map<string, Slot>();
    const keepSlot = (slot: Slot | undefined) => {
      if (slot !== undefined) selectedSlots.set(slot.id, slot);
    };
    graphOrderedSlots.slice(0, 24).forEach(keepSlot);
    for (const rotation of [0, 90, 180, 270] as const) {
      for (let bucket = 0; bucket < 3; bucket += 1) {
        keepSlot(graphOrderedSlots.find((slot) => slot.rotation === rotation
          && Math.floor(slot.position.y / Math.max(1, Math.ceil(frontageBounds.maxY / 3))) === bucket));
      }
    }
    const search = searchEjectionChains({
      devices: options.packing.devices,
      logisticsDevices: [],
      rootDeviceId,
      limitWidth: verticalFrontage ? options.limitWidth : frontageBounds.maxX,
      limitHeight: verticalFrontage ? frontageBounds.maxY : options.limitHeight,
      allowRotate: options.allowRotate,
      slots: [...selectedSlots.values()],
      config: {
        maxDepth: 7,
        beamWidth: 32,
        maxStates: 768,
        maxTranslation: 12,
        timeBudgetMs: 600,
        maxPotentialBlockers: 4,
      },
    });
    if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTE_FAILURE_LNS"] === "1") {
      console.error(
        `[route-failure-ejection] root=${rootDeviceId} slots=${selectedSlots.size} `
        + `explored=${search.exploredStates} generated=${search.generatedStates} `
        + `layouts=${search.layouts.length} stopped=${search.stoppedBy}`,
      );
    }
    generatedCount += search.generatedStates;
    for (const devices of search.layouts) {
      const allMovableInsideFrontage = devices.filter(isEjectionMovable).every((device) => {
        const deviceStart = verticalFrontage ? device.position.y : device.position.x;
        const deviceEnd = deviceStart + (verticalFrontage ? device.height : device.width);
        const frontageStart = verticalFrontage ? frontageBounds.minY : frontageBounds.minX;
        const frontageEnd = verticalFrontage ? frontageBounds.maxY : frontageBounds.maxX;
        return deviceStart >= frontageStart && deviceEnd <= frontageEnd;
      });
      if (!allMovableInsideFrontage) continue;
      const packing = createMovedPacking(options.packing, devices, 0);
      const candidate: PackingResult = {
        ...packing,
        debugLabel: `route-failure-lns:${rootDeviceId}`,
      };
      const portScore = measureExactPortFeasibility(
        devices,
        options.requests,
        failureFlowEdges,
        options.limitWidth,
        options.limitHeight,
        new Set([rootDeviceId, ...connectedDeviceIds]),
      );
      if (portScore === null) continue;
      const movedById = new Map(devices.map((device) => [device.id, device]));
      const movedRoot = movedById.get(rootDeviceId)!;
      const graphDistance = [...connectedDeviceIds].reduce((sum, id) => {
        const connected = movedById.get(id);
        return connected === undefined ? sum : sum + manhattan(deviceCenter(movedRoot), deviceCenter(connected));
      }, 0);
      const movement = devices.reduce((sum, device) => {
        const incumbent = incumbentById.get(device.id);
        if (incumbent === undefined) return sum;
        return sum + Math.abs(device.position.x - incumbent.position.x)
          + Math.abs(device.position.y - incumbent.position.y)
          + Number(device.rotation !== incumbent.rotation);
      }, 0);
      largeNeighborhoodLayouts.set(packingSignature(candidate), {
        packing: candidate,
        rootDeviceId,
        score: [
          portScore,
          measureAcyclicFlowDirectionPenalty(
            devices,
            new Map(options.requests.map((request) => [request.id, request])),
          ),
          graphDistance,
          measureEnclosedVoidCells(devices),
          movement,
          packing.usedWidth * packing.usedHeight,
        ],
      });
    }
  }
  const generated: Array<{
    readonly packing: PackingResult;
    readonly blockerId: string;
    readonly score: readonly number[];
  }> = [];
  for (const blockerId of movableIds) {
    const original = options.packing.devices.find((device) => device.id === blockerId)!;
    const rotationDeltas = options.allowRotate ? [0, 90, 180, 270] as const : [0] as const;
    for (const rotationDelta of rotationDeltas) {
      const swaps = rotationDelta === 90 || rotationDelta === 270;
      const width = swaps ? original.height : original.width;
      const height = swaps ? original.width : original.height;
      const maximumX = verticalFrontage
        ? options.limitWidth - width
        : Math.min(options.limitWidth - width, frontageBounds.maxX - width);
      const maximumY = verticalFrontage
        ? Math.min(options.limitHeight - height, frontageBounds.maxY - height)
        : options.limitHeight - height;
      const minimumX = verticalFrontage ? 0 : frontageBounds.minX;
      const minimumY = verticalFrontage ? frontageBounds.minY : 0;
      for (let y = minimumY; y <= maximumY; y += 1) {
        for (let x = minimumX; x <= maximumX; x += 1) {
          if (x === original.position.x && y === original.position.y && rotationDelta === 0) continue;
          if (options.targetedOnly === true
            && Math.abs(x - original.position.x) + Math.abs(y - original.position.y) > 3) continue;
          generatedCount += 1;
          const moved: HeadlessPlacedDevice = {
            ...original,
            position: { x, y },
            rotation: ((original.rotation + rotationDelta) % 360) as GridRotation,
            width,
            height,
          };
          const devices = options.packing.devices.map((device) =>
            device.id === blockerId ? moved : device);
          if (!hasProductionClearance(devices, 0)) continue;
          const requiredPortIds = new Set([
            blockerId,
            options.evidence.sourceDeviceId,
            options.evidence.targetDeviceId,
          ].filter((id): id is string => id !== null));
          if (measureExactPortFeasibility(
            devices,
            options.requests,
            failureFlowEdges,
            options.limitWidth,
            options.limitHeight,
            requiredPortIds,
          ) === null) continue;
          const base = createMovedPacking(options.packing, devices, 0);
          generated.push({
            blockerId,
            packing: {
              ...base,
              debugLabel: `route-failure-backtrack:${blockerId}:${x},${y},${moved.rotation}`,
            },
            score: [
              Math.abs(x - original.position.x) + Math.abs(y - original.position.y),
              measureEnclosedVoidCells(devices),
              base.usedWidth * base.usedHeight,
              rotationDelta === 0 ? 0 : 1,
              y,
              x,
            ],
          });
        }
      }
    }
  }
  const ordered = generated.sort((left, right) => compareScore(left.score, right.score));
  const selected = new Map<string, PackingResult>();
  for (const blockerId of movableIds) {
    for (const candidate of ordered.filter((entry) => entry.blockerId === blockerId).slice(0, 4)) {
      selected.set(packingSignature(candidate.packing), candidate.packing);
    }
  }
  for (const candidate of ordered) {
    if (selected.size >= 48) break;
    selected.set(packingSignature(candidate.packing), candidate.packing);
  }
  const combined = new Map<string, PackingResult>();
  for (const packing of [...cpSatLayouts.values()].sort(comparePacking).slice(0, 8)) {
    combined.set(packingSignature(packing), packing);
  }
  for (const [signature, packing] of selected) {
    if (combined.size >= 48) break;
    combined.set(signature, packing);
  }
  const orderedLargeNeighborhoods = [...largeNeighborhoodLayouts.values()]
    .sort((left, right) => compareScore(left.score, right.score));
  const selectedLargeNeighborhoods = new Map<string, PackingResult>();
  const keepLargeNeighborhood = (candidate: typeof orderedLargeNeighborhoods[number] | undefined) => {
    if (candidate !== undefined) {
      selectedLargeNeighborhoods.set(packingSignature(candidate.packing), candidate.packing);
    }
  };
  for (const rootDeviceId of failedEndpointIds) {
    for (const candidate of orderedLargeNeighborhoods
      .filter((entry) => entry.rootDeviceId === rootDeviceId).slice(0, 4)) {
      keepLargeNeighborhood(candidate);
    }
    for (const rotation of [0, 90, 180, 270] as const) {
      for (let xBucket = 0; xBucket < 3; xBucket += 1) {
        for (let yBucket = 0; yBucket < 3; yBucket += 1) {
          keepLargeNeighborhood(orderedLargeNeighborhoods.find((entry) => {
            if (entry.rootDeviceId !== rootDeviceId) return false;
            const root = entry.packing.devices.find((device) => device.id === rootDeviceId);
            return root?.rotation === rotation
              && Math.floor(root.position.x / Math.max(1, Math.ceil(cpSatLimitWidth / 3))) === xBucket
              && Math.floor(root.position.y / Math.max(1, Math.ceil(cpSatLimitHeight / 3))) === yBucket;
          }));
        }
      }
    }
  }
  for (const candidate of orderedLargeNeighborhoods) {
    if (selectedLargeNeighborhoods.size >= 24) break;
    keepLargeNeighborhood(candidate);
  }
  for (const [signature, packing] of selectedLargeNeighborhoods) {
    if (combined.size >= 72) break;
    combined.set(signature, packing);
  }
  return {
    packings: [...combined.values()],
    clusterGenerated: generatedCount,
    clusterCheapRejected: generatedCount - selected.size,
    globalRebuildGenerated: 0,
    partialRebuildGenerated: 0,
    globalRebuildCpSatElapsedMs: 0,
    objectiveHotspotDeviceIds: [],
  };
}

/**
 * Return equipment-free cut coordinates whose routed cells are straight
 * segments perpendicular to the cut. Horizontal cuts require vertical belts;
 * vertical cuts require horizontal belts.
 */
export function findCompressibleStraightBeltCuts(options: {
  readonly axis: CompactionAxis;
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly connections: readonly {
    readonly points: readonly GridPoint[];
  }[];
}): number[] {
  const candidateCoordinates = new Set<number>();
  const nonStraightCoordinates = new Set<number>();
  const directPortBridgeCoordinates = new Set<number>();
  const coordinateOfPoint = (point: GridPoint): number =>
    options.axis === "horizontal" ? point.y : point.x;
  for (const connection of options.connections) {
    // When both outside port cells coincide, the complete connection is one
    // logistics cell. Deleting its row or column would separate the two
    // devices rather than shorten a corridor.
    if (connection.points.length === 1) {
      directPortBridgeCoordinates.add(coordinateOfPoint(connection.points[0]!));
    }
    for (let index = 0; index < connection.points.length; index += 1) {
      const point = connection.points[index]!;
      const previous = connection.points[index - 1];
      const next = connection.points[index + 1];
      const isPerpendicularStraight = previous !== undefined
        && next !== undefined
        && (options.axis === "horizontal"
          ? previous.x === point.x
            && next.x === point.x
            && (previous.y - point.y) * (next.y - point.y) < 0
          : previous.y === point.y
            && next.y === point.y
            && (previous.x - point.x) * (next.x - point.x) < 0);
      if (isPerpendicularStraight) {
        candidateCoordinates.add(coordinateOfPoint(point));
      } else {
        nonStraightCoordinates.add(coordinateOfPoint(point));
      }
    }
  }
  const equipmentCoordinates = new Set<number>();
  for (const device of options.devices) {
    if (device.kind === "belt" || device.kind === "pipe" || device.kind === "power") continue;
    const start = options.axis === "horizontal" ? device.position.y : device.position.x;
    const size = options.axis === "horizontal" ? device.height : device.width;
    for (let coordinate = start; coordinate < start + size; coordinate += 1) {
      equipmentCoordinates.add(coordinate);
    }
  }
  return [...candidateCoordinates]
    .filter((coordinate) =>
      coordinate > 0
      && !nonStraightCoordinates.has(coordinate)
      && !directPortBridgeCoordinates.has(coordinate)
      && !equipmentCoordinates.has(coordinate)
      && options.devices.some((device) =>
        (device.kind === "production" || device.kind === "storage")
        && (options.axis === "horizontal"
          ? device.position.y
          : device.position.x) > coordinate))
    .sort((left, right) => left - right);
}

/** Backward-compatible horizontal-row view of the axis-generic detector. */
export function findCompressibleStraightBeltRows(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly connections: readonly {
    readonly points: readonly GridPoint[];
  }[];
}): number[] {
  return findCompressibleStraightBeltCuts({ ...options, axis: "horizontal" });
}

/**
 * Collapse one pure-straight routing row at a time. The move is derived from
 * the already routed layout rather than from recipe identity, and remains only
 * a candidate until the shortened layout passes complete routing and power
 * validation.
 */
function createStraightBeltRowCollapseNeighbors(options: {
  readonly packing: PackingResult;
  readonly routing: RoutingResult;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
}): { readonly packings: readonly PackingResult[]; readonly generated: number } {
  const selected = new Map<string, PackingResult>();
  let generated = 0;
  const keepCollapsedCuts = (axis: CompactionAxis, coordinates: readonly number[]): void => {
    const devices = collapseDevicesAcrossStraightBeltCuts({
      axis,
      devices: options.packing.devices,
      coordinates,
      limitWidth: options.limitWidth,
      limitHeight: options.limitHeight,
    });
    if (devices === null) return;
    const baselineBounds = measureFactoryFootprintBounds(options.packing.devices);
    const nextBounds = measureFactoryFootprintBounds(devices);
    const axisSpanImproved = axis === "horizontal"
      ? nextBounds.height < baselineBounds.height
      : nextBounds.width < baselineBounds.width;
    // A line clear is an external-rectangle compaction primitive. If fixed
    // infrastructure still determines the same span, routing this candidate
    // merely duplicates ordinary coordinate movement at much higher cost.
    if (!axisSpanImproved) return;
    const movedIds = new Set(options.packing.devices
      .filter((device, index) =>
        device.position.x !== devices[index]!.position.x
        || device.position.y !== devices[index]!.position.y)
      .map((device) => device.id));
    if (movedIds.size === 0) return;
    generated += 1;
    const moved = createMovedPacking(
      options.packing,
      devices,
      options.routingClearance,
    );
    const candidate: PackingResult = {
      ...moved,
      debugLabel:
        `local-terminal-cluster:straight-${axis === "horizontal" ? "row" : "column"}-collapse:`
        + `${coordinates.join(",")}:${movedIds.size}`,
    };
    selected.set(packingSignature(candidate), candidate);
  };
  const provenCollapses = createProvenStraightBeltCutCollapses({
    devices: options.packing.devices,
    connections: options.routing.connections,
    limitWidth: options.limitWidth,
    limitHeight: options.limitHeight,
  });
  for (const collapse of provenCollapses) {
    generated += 1;
    const moved = createMovedPacking(
      options.packing,
      collapse.devices,
      options.routingClearance,
    );
    const candidate: PackingResult = {
      ...moved,
      debugLabel:
        `local-terminal-cluster:straight-${collapse.axis === "horizontal" ? "row" : "column"}-collapse:`
        + `${collapse.coordinate}:${collapse.movedDeviceIds.size}`,
      evaluationKey:
        `proven-straight-cut:${collapse.axis}:${collapse.coordinate}:${packingSignature(moved)}`,
      preservationRoutingSeed: {
        ...options.routing,
        connections: collapse.connections,
      },
      preservationForcedRipUpConnectionIds: collapse.invalidConnectionIds,
    };
    selected.set(candidate.evaluationKey!, candidate);
  }
  for (const axis of ["horizontal", "vertical"] as const) {
    const compressibleCoordinates = findCompressibleStraightBeltCuts({
      axis,
      devices: options.packing.devices,
      connections: options.routing.connections,
    });
    // A Tetris clear removes every currently complete line on one axis in one
    // transition. Mixed-axis clearing remains two validated local moves so
    // translating one suffix cannot invalidate the proof for the other axis.
    if (compressibleCoordinates.length > 1) {
      keepCollapsedCuts(axis, compressibleCoordinates);
    }
  }
  return {
    packings: [...selected.values()].sort(compareLocalPacking),
    generated,
  };
}

/**
 * Materialize every single straight-cut contraction as an exact route seed.
 *
 * The route on the far side of the cut moves with its production/storage
 * suffix. A perpendicular straight cell at the cut disappears, so no port
 * choice or connection order changes. The returned invalid set is normally
 * empty; retaining it makes overlapping/corrupted input safe by forcing only
 * those paths through the bounded repair fallback.
 */
export function createProvenStraightBeltCutCollapses(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly connections: readonly RoutedConnection[];
  readonly limitWidth: number;
  readonly limitHeight: number;
}): ProvenStraightBeltCutCollapse[] {
  const baselineBounds = measureFactoryFootprintBounds(options.devices);
  const result: ProvenStraightBeltCutCollapse[] = [];
  for (const axis of ["horizontal", "vertical"] as const) {
    const coordinates = findCompressibleStraightBeltCuts({
      axis,
      devices: options.devices,
      connections: options.connections,
    });
    for (const coordinate of coordinates) {
      const devices = collapseDevicesAcrossStraightBeltCuts({
        axis,
        devices: options.devices,
        coordinates: [coordinate],
        limitWidth: options.limitWidth,
        limitHeight: options.limitHeight,
      });
      if (devices === null) continue;
      const nextBounds = measureFactoryFootprintBounds(devices);
      const axisSpanImproved = axis === "horizontal"
        ? nextBounds.height < baselineBounds.height
        : nextBounds.width < baselineBounds.width;
      if (!axisSpanImproved) continue;
      const movedDeviceIds = new Set(options.devices
        .filter((device, index) =>
          device.position.x !== devices[index]!.position.x
          || device.position.y !== devices[index]!.position.y)
        .map((device) => device.id));
      if (movedDeviceIds.size === 0) continue;
      const contracted = contractRoutedConnectionsAcrossAxisCut({
        axis,
        connections: options.connections,
        devices,
        movedDeviceIds,
        cutCoordinate: coordinate,
        distance: 1,
        limitWidth: options.limitWidth,
        limitHeight: options.limitHeight,
      });
      result.push({
        axis,
        coordinate,
        devices,
        connections: contracted.connections,
        movedDeviceIds,
        invalidConnectionIds: contracted.invalidConnectionIds,
      });
    }
  }
  return result.sort((left, right) => {
    const leftBounds = measureFactoryFootprintBounds(left.devices);
    const rightBounds = measureFactoryFootprintBounds(right.devices);
    return leftBounds.width * leftBounds.height - rightBounds.width * rightBounds.height
      || left.invalidConnectionIds.size - right.invalidConnectionIds.size
      || Number(left.axis === "vertical") - Number(right.axis === "vertical")
      || left.coordinate - right.coordinate;
  });
}

/**
 * Remove several already-verified straight-belt cuts on one axis. Each
 * movable device shifts toward the origin by the number of cleared
 * coordinates before its leading edge; warehouse infrastructure and power
 * are not part of this equipment move.
 */
export function collapseDevicesAcrossStraightBeltCuts(options: {
  readonly axis: CompactionAxis;
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly coordinates: readonly number[];
  readonly limitWidth: number;
  readonly limitHeight: number;
}): readonly HeadlessPlacedDevice[] | null {
  const coordinates = [...new Set(options.coordinates)]
    .filter((coordinate) => Number.isInteger(coordinate) && coordinate > 0)
    .sort((left, right) => left - right);
  if (coordinates.length === 0) return null;
  const translated = options.devices.map((device): HeadlessPlacedDevice => {
    if (device.kind !== "production" && device.kind !== "storage") return device;
    const leadingEdge = options.axis === "horizontal"
      ? device.position.y
      : device.position.x;
    const clearedBefore = coordinates.filter((coordinate) =>
      coordinate < leadingEdge).length;
    return clearedBefore === 0
      ? device
      : {
          ...device,
          position: {
            x: device.position.x - (options.axis === "vertical" ? clearedBefore : 0),
            y: device.position.y - (options.axis === "horizontal" ? clearedBefore : 0),
          },
        };
  });
  const outsideLimit = translated.some((device) =>
    device.position.x < 0
    || device.position.y < 0
    || device.position.x + device.width > options.limitWidth
    || device.position.y + device.height > options.limitHeight);
  return outsideLimit || !hasProductionClearance(translated, 0) ? null : translated;
}

/** Backward-compatible horizontal-row wrapper. */
export function collapseDevicesAcrossStraightBeltRows(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly rows: readonly number[];
  readonly limitWidth: number;
  readonly limitHeight: number;
}): readonly HeadlessPlacedDevice[] | null {
  return collapseDevicesAcrossStraightBeltCuts({
    axis: "horizontal",
    devices: options.devices,
    coordinates: options.rows,
    limitWidth: options.limitWidth,
    limitHeight: options.limitHeight,
  });
}

export interface SpeculativeHorizontalCutCompaction {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly cutRow: number;
  readonly distance: number;
  readonly movedDeviceIds: readonly string[];
}

export interface SpeculativeAxisCutCompaction {
  readonly axis: CompactionAxis;
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly cutCoordinate: number;
  readonly distance: number;
  readonly movedDeviceIds: readonly string[];
}

/**
 * Try a bounded Tetris clear before the routing line is already straight.
 * Every production/storage device after an equipment-free cut moves as one
 * rigid suffix toward the origin. Complete routing later decides whether turns
 * and crossings can be reorganized to make the speculative clear real.
 */
export function createSpeculativeAxisCutCompactions(options: {
  readonly axis: CompactionAxis;
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly routedConnections: readonly {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
    readonly points: readonly GridPoint[];
  }[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly maximumDistance?: number;
}): SpeculativeAxisCutCompaction[] {
  const movableDevices = options.devices.filter((device) =>
    device.kind === "production" || device.kind === "storage");
  if (movableDevices.length < 2) return [];
  const baselineBounds = measureFactoryFootprintBounds(options.devices);
  const baselineSpan = options.axis === "horizontal"
    ? baselineBounds.height
    : baselineBounds.width;
  const limit = options.axis === "horizontal" ? options.limitHeight : options.limitWidth;
  const maximumDistance = Math.max(
    1,
    Math.min(3, Math.floor(options.maximumDistance ?? 3)),
  );
  const selected = new Map<string, SpeculativeAxisCutCompaction>();
  for (let cutCoordinate = 1; cutCoordinate < limit - 1; cutCoordinate += 1) {
    if (options.devices.some((device) =>
      (options.axis === "horizontal" ? device.position.y : device.position.x) <= cutCoordinate
      && (options.axis === "horizontal"
        ? device.position.y + device.height
        : device.position.x + device.width) > cutCoordinate)) continue;
    const movedDeviceIds = movableDevices
      .filter((device) =>
        (options.axis === "horizontal" ? device.position.y : device.position.x) > cutCoordinate)
      .map((device) => device.id)
      .sort();
    if (movedDeviceIds.length === 0 || movedDeviceIds.length === movableDevices.length) continue;
    const movedIds = new Set(movedDeviceIds);
    const separatesDirectPortBridge = options.routedConnections.some((connection) =>
      connection.points.length === 1
      && connection.sourceDeviceId !== null
      && connection.targetDeviceId !== null
      && movedIds.has(connection.sourceDeviceId) !== movedIds.has(connection.targetDeviceId));
    if (separatesDirectPortBridge) continue;
    for (let distance = 1; distance <= maximumDistance; distance += 1) {
      const devices = translateRigidDeviceCluster({
        devices: options.devices,
        deviceIds: movedIds,
        deltaX: options.axis === "vertical" ? -distance : 0,
        deltaY: options.axis === "horizontal" ? -distance : 0,
        limitWidth: options.limitWidth,
        limitHeight: options.limitHeight,
      });
      if (devices === null) break;
      const bounds = measureFactoryFootprintBounds(devices);
      const span = options.axis === "horizontal" ? bounds.height : bounds.width;
      if (span >= baselineSpan) continue;
      const signature = `${movedDeviceIds.join("\u0000")}:${distance}`;
      selected.set(signature, {
        axis: options.axis,
        devices,
        cutCoordinate,
        distance,
        movedDeviceIds,
      });
    }
  }
  return [...selected.values()].sort((left, right) =>
    (options.axis === "horizontal"
      ? measureFactoryFootprintBounds(left.devices).height
        - measureFactoryFootprintBounds(right.devices).height
      : measureFactoryFootprintBounds(left.devices).width
        - measureFactoryFootprintBounds(right.devices).width)
    || right.movedDeviceIds.length - left.movedDeviceIds.length
    || right.distance - left.distance
    || left.cutCoordinate - right.cutCoordinate);
}

/** Backward-compatible horizontal-cut wrapper. */
export function createSpeculativeHorizontalCutCompactions(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly routedConnections: readonly {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
    readonly points: readonly GridPoint[];
  }[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly maximumDistance?: number;
}): SpeculativeHorizontalCutCompaction[] {
  return createSpeculativeAxisCutCompactions({
    ...options,
    axis: "horizontal",
  }).map(({ devices, cutCoordinate, distance, movedDeviceIds }) => ({
    devices,
    cutRow: cutCoordinate,
    distance,
    movedDeviceIds,
  }));
}

/**
 * Preserve both suffix diversity and every meaningful movement distance.
 * Sampling only the first/last candidate of a suffix silently drops the
 * intermediate two-row clear when one row is too small and three are
 * unroutable. Equivalent cut rows are deduplicated by moved IDs and distance.
 */
export function selectSpeculativeAxisCutCompactionBeam(
  compactions: readonly SpeculativeAxisCutCompaction[],
  maximum = 8,
): SpeculativeAxisCutCompaction[] {
  const limit = Math.max(0, Math.trunc(maximum));
  if (limit === 0) return [];
  const candidatesBySuffix = new Map<string, Map<number, SpeculativeAxisCutCompaction>>();
  const spanOf = (compaction: SpeculativeAxisCutCompaction): number => {
    const bounds = measureFactoryFootprintBounds(compaction.devices);
    return compaction.axis === "horizontal" ? bounds.height : bounds.width;
  };
  for (const compaction of compactions) {
    const suffix = `${compaction.axis}:${compaction.movedDeviceIds.join("\u0000")}`;
    const byDistance = candidatesBySuffix.get(suffix) ?? new Map();
    const incumbent = byDistance.get(compaction.distance);
    if (incumbent === undefined
      || spanOf(compaction) < spanOf(incumbent)
      || (
        spanOf(compaction) === spanOf(incumbent)
        && compaction.cutCoordinate < incumbent.cutCoordinate
      )) {
      byDistance.set(compaction.distance, compaction);
    }
    candidatesBySuffix.set(suffix, byDistance);
  }
  const suffixes = [...candidatesBySuffix.entries()]
    .map(([signature, byDistance]) => ({
      signature,
      axis: byDistance.values().next().value?.axis ?? "horizontal",
      movedCount: byDistance.values().next().value?.movedDeviceIds.length ?? 0,
      queue: [...byDistance.values()].sort((left, right) =>
        right.distance - left.distance
        || spanOf(left) - spanOf(right)
        || left.cutCoordinate - right.cutCoordinate),
    }));
  const movedCounts = suffixes.map((suffix) => suffix.movedCount)
    .sort((left, right) => left - right);
  const medianMovedCount = movedCounts[Math.floor((movedCounts.length - 1) / 2)] ?? 0;
  suffixes.sort((left, right) =>
    Math.abs(left.movedCount - medianMovedCount)
      - Math.abs(right.movedCount - medianMovedCount)
    || left.movedCount - right.movedCount
    || left.signature.localeCompare(right.signature));
  const axisDiverseSuffixes = (["horizontal", "vertical"] as const)
    .map((axis) => suffixes.filter((suffix) => suffix.axis === axis));
  const roundRobinSuffixes = Array.from(
    { length: Math.max(...axisDiverseSuffixes.map((entries) => entries.length), 0) },
    (_, index) => axisDiverseSuffixes.flatMap((entries) => entries[index] ?? []),
  ).flat();
  const selected: SpeculativeAxisCutCompaction[] = [];
  for (let queueIndex = 0; selected.length < limit; queueIndex += 1) {
    let appended = false;
    for (const suffix of roundRobinSuffixes) {
      const candidate = suffix.queue[queueIndex];
      if (candidate === undefined) continue;
      selected.push(candidate);
      appended = true;
      if (selected.length >= limit) break;
    }
    if (!appended) break;
  }
  return selected;
}

/** Backward-compatible horizontal-cut beam wrapper. */
export function selectSpeculativeHorizontalCutCompactionBeam(
  compactions: readonly SpeculativeHorizontalCutCompaction[],
  maximum = 8,
): SpeculativeHorizontalCutCompaction[] {
  return selectSpeculativeAxisCutCompactionBeam(
    compactions.map((compaction) => ({
      axis: "horizontal",
      devices: compaction.devices,
      cutCoordinate: compaction.cutRow,
      distance: compaction.distance,
      movedDeviceIds: compaction.movedDeviceIds,
    })),
    maximum,
  ).map(({ devices, cutCoordinate, distance, movedDeviceIds }) => ({
    devices,
    cutRow: cutCoordinate,
    distance,
    movedDeviceIds,
  }));
}

/**
 * Fold existing routes through a removed axis-aligned band before invoking
 * A*. Turns may remain on either side of the band; only coordinates after the
 * cut are projected toward it. Routes wholly inside the moved suffix translate
 * rigidly. Invalid or newly conflicting routes become an exact rip-up set.
 */
export function contractRoutedConnectionsAcrossAxisCut(options: {
  readonly axis: CompactionAxis;
  readonly connections: readonly RoutedConnection[];
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly movedDeviceIds: ReadonlySet<string>;
  readonly cutCoordinate: number;
  readonly distance: number;
  readonly limitWidth: number;
  readonly limitHeight: number;
}): {
  readonly connections: readonly RoutedConnection[];
  readonly invalidConnectionIds: ReadonlySet<string>;
} {
  const distance = Math.max(1, Math.trunc(options.distance));
  const translatePoint = (point: GridPoint): GridPoint => ({
    x: point.x - (options.axis === "vertical" ? distance : 0),
    y: point.y - (options.axis === "horizontal" ? distance : 0),
  });
  const contractPoint = (point: GridPoint): GridPoint => {
    const coordinate = options.axis === "horizontal" ? point.y : point.x;
    if (coordinate <= options.cutCoordinate) return point;
    const contractedCoordinate = Math.max(
      options.cutCoordinate,
      coordinate - distance,
    );
    return options.axis === "horizontal"
      ? { x: point.x, y: contractedCoordinate }
      : { x: contractedCoordinate, y: point.y };
  };
  const connections = options.connections.map((connection): RoutedConnection => {
    const sourceMoved = connection.sourceDeviceId !== null
      && options.movedDeviceIds.has(connection.sourceDeviceId);
    const targetMoved = connection.targetDeviceId !== null
      && options.movedDeviceIds.has(connection.targetDeviceId);
    const points = connection.points.map((point): GridPoint =>
      sourceMoved && targetMoved
        ? translatePoint(point)
        : sourceMoved || targetMoved
        ? contractPoint(point)
        : point);
    const deduplicated = points.filter((point, index) =>
      index === 0 || gridKey(point) !== gridKey(points[index - 1]!));
    return { ...connection, points: deduplicated };
  });
  const invalidConnectionIds = new Set<string>();
  const blocked = new Set<string>();
  for (const device of options.devices) {
    addRectangleCells(
      blocked,
      device.position.x,
      device.position.y,
      device.width,
      device.height,
    );
  }
  const occupationByCell = new Map<string, Array<{
    readonly connectionId: string;
    readonly kind: LogisticsKind;
    readonly axis: "horizontal" | "vertical" | null;
  }>>();
  const pointAxis = (
    points: readonly GridPoint[],
    index: number,
  ): "horizontal" | "vertical" | null => {
    const point = points[index]!;
    const neighbors = [points[index - 1], points[index + 1]]
      .filter((neighbor): neighbor is GridPoint => neighbor !== undefined);
    if (neighbors.length === 0) return null;
    const horizontal = neighbors.every((neighbor) => neighbor.y === point.y);
    const vertical = neighbors.every((neighbor) => neighbor.x === point.x);
    return horizontal ? "horizontal" : vertical ? "vertical" : null;
  };
  for (const connection of connections) {
    const seenCells = new Set<string>();
    for (const [index, point] of connection.points.entries()) {
      const key = gridKey(point);
      if (
        point.x < 0
        || point.y < 0
        || point.x >= options.limitWidth
        || point.y >= options.limitHeight
        || blocked.has(key)
        || seenCells.has(key)
      ) {
        invalidConnectionIds.add(connection.id);
      }
      seenCells.add(key);
      const previous = connection.points[index - 1];
      if (previous !== undefined && manhattan(previous, point) !== 1) {
        invalidConnectionIds.add(connection.id);
      }
      occupationByCell.set(key, [
        ...(occupationByCell.get(key) ?? []),
        {
          connectionId: connection.id,
          kind: connection.kind,
          axis: pointAxis(connection.points, index),
        },
      ]);
    }
  }
  for (const occupations of occupationByCell.values()) {
    if (occupations.length <= 1) continue;
    const validCrossing = occupations.length === 2
      && occupations[0]!.kind === occupations[1]!.kind
      && occupations[0]!.axis !== null
      && occupations[1]!.axis !== null
      && occupations[0]!.axis !== occupations[1]!.axis;
    if (!validCrossing) {
      occupations.forEach((occupation) =>
        invalidConnectionIds.add(occupation.connectionId));
    }
  }
  return { connections, invalidConnectionIds };
}

/** Backward-compatible horizontal-cut wrapper. */
export function contractRoutedConnectionsAcrossHorizontalCut(options: {
  readonly connections: readonly RoutedConnection[];
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly movedDeviceIds: ReadonlySet<string>;
  readonly cutRow: number;
  readonly distance: number;
  readonly limitWidth: number;
  readonly limitHeight: number;
}): {
  readonly connections: readonly RoutedConnection[];
  readonly invalidConnectionIds: ReadonlySet<string>;
} {
  return contractRoutedConnectionsAcrossAxisCut({
    axis: "horizontal",
    connections: options.connections,
    devices: options.devices,
    movedDeviceIds: options.movedDeviceIds,
    cutCoordinate: options.cutRow,
    distance: options.distance,
    limitWidth: options.limitWidth,
    limitHeight: options.limitHeight,
  });
}

export interface UpstreamRowMovementCandidate {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly operation: "single-device" | "rigid-row";
  readonly rowDeviceIds: readonly string[];
  readonly movedDeviceIds: readonly string[];
  readonly rowMinY: number;
  readonly rowMaxY: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly rotation: GridRotation;
}

export interface SameRowTerminalPlacement {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly terminalDeviceId: string;
  readonly rowDeviceIds: readonly string[];
  readonly shiftedRowDeviceIds: readonly string[];
  readonly rowDeviceOffsets: readonly {
    readonly deviceId: string;
    readonly deltaX: number;
    readonly deltaY: number;
  }[];
  readonly side: "left" | "right";
  readonly alignment: "top" | "middle" | "bottom";
  readonly rotation: GridRotation;
  readonly rotationChanged: boolean;
}

export interface LayerInterlockWidthFeasibility {
  readonly feasible: boolean;
  readonly frontageWidth: number;
  readonly terminalLayerWidth: number;
  readonly insertedLayerWidth: number;
  readonly requiredRoutingColumns: number;
  readonly requiredWidth: number;
  readonly residualWidth: number;
  readonly reason: "feasible" | "terminal-layer-saturates-frontage" | "insufficient-frontage";
}

/**
 * Necessary width proof for inserting upstream equipment into a terminal band.
 *
 * Widths are projections onto the warehouse-unloader frontage axis. The proof
 * is intentionally independent of recipes, entity IDs, and absolute
 * coordinates: every device in the terminal cohort and inserted row consumes
 * its projected width, while each simultaneous row-to-terminal material edge
 * reserves one routing column. Passing this lower bound does not guarantee a
 * route; failing it proves that this layer-interlock family cannot fit.
 */
export function assessLayerInterlockWidthFeasibility(options: {
  readonly frontageWidth: number;
  readonly terminalLayerDeviceWidths: readonly number[];
  readonly insertedLayerDeviceWidths: readonly number[];
  readonly requiredRoutingColumns: number;
}): LayerInterlockWidthFeasibility {
  const frontageWidth = Math.max(0, Math.floor(options.frontageWidth));
  const normalizeWidths = (widths: readonly number[]): number => widths.reduce(
    (sum, width) => sum + Math.max(0, Math.ceil(width)),
    0,
  );
  const terminalLayerWidth = normalizeWidths(options.terminalLayerDeviceWidths);
  const insertedLayerWidth = normalizeWidths(options.insertedLayerDeviceWidths);
  const requiredRoutingColumns = Math.max(0, Math.ceil(options.requiredRoutingColumns));
  const requiredWidth = terminalLayerWidth + insertedLayerWidth + requiredRoutingColumns;
  const residualWidth = frontageWidth - requiredWidth;
  const feasible = requiredWidth <= frontageWidth;
  return {
    feasible,
    frontageWidth,
    terminalLayerWidth,
    insertedLayerWidth,
    requiredRoutingColumns,
    requiredWidth,
    residualWidth,
    reason: feasible
      ? "feasible"
      : terminalLayerWidth >= frontageWidth
        ? "terminal-layer-saturates-frontage"
        : "insufficient-frontage",
  };
}

/**
 * Place one terminal beside a physical upstream row with a one-cell port lane.
 * The row is defined geometrically by its supplied device IDs; no recipe,
 * machine name, or orientation is assumed.
 */
export function createSameRowTerminalPlacements(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly terminalDeviceId: string;
  readonly rowDeviceIds: readonly string[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): SameRowTerminalPlacement[] {
  const terminal = options.devices.find((device) => device.id === options.terminalDeviceId);
  const rowDeviceIds = [...new Set(options.rowDeviceIds)].sort();
  const rowIds = new Set(rowDeviceIds);
  const originalRow = options.devices
    .filter((device) => rowIds.has(device.id))
    .sort((left, right) => left.position.x - right.position.x || left.id.localeCompare(right.id));
  if (terminal === undefined || originalRow.length === 0 || rowIds.has(terminal.id)) return [];
  const originalRowById = new Map(originalRow.map((device) => [device.id, device]));
  const resolveRowDeviceOffsets = (
    devices: readonly HeadlessPlacedDevice[],
  ): SameRowTerminalPlacement["rowDeviceOffsets"] => devices
    .filter((device) => rowIds.has(device.id))
    .flatMap((device) => {
      const original = originalRowById.get(device.id);
      if (original === undefined) return [];
      const deltaX = device.position.x - original.position.x;
      const deltaY = device.position.y - original.position.y;
      return deltaX === 0 && deltaY === 0
        ? []
        : [{ deviceId: device.id, deltaX, deltaY }];
    })
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  const rowVariants: Array<{
    readonly devices: readonly HeadlessPlacedDevice[];
    readonly shiftedRowDeviceIds: readonly string[];
    readonly rowDeviceOffsets: SameRowTerminalPlacement["rowDeviceOffsets"];
  }> = [{ devices: options.devices, shiftedRowDeviceIds: [], rowDeviceOffsets: [] }];
  // Insert one routing column at every touching/overlapping row boundary. A
  // right shift of the suffix is the frontage-preserving Tetris move; the
  // mirrored prefix shift is retained when the row has free space on its left.
  for (let splitIndex = 0; splitIndex < originalRow.length - 1; splitIndex += 1) {
    const left = originalRow[splitIndex]!;
    const right = originalRow[splitIndex + 1]!;
    if (right.position.x - (left.position.x + left.width) >= 1) continue;
    for (const direction of ["suffix-right", "prefix-left"] as const) {
      const shiftedIds = new Set((direction === "suffix-right"
        ? originalRow.slice(splitIndex + 1)
        : originalRow.slice(0, splitIndex + 1)).map((device) => device.id));
      const devices = options.devices.map((device): HeadlessPlacedDevice =>
        shiftedIds.has(device.id)
          ? {
              ...device,
              position: {
                x: device.position.x + (direction === "suffix-right" ? 1 : -1),
                y: device.position.y,
              },
            }
          : device);
      if (devices.some((device) =>
        shiftedIds.has(device.id)
        && (
          device.position.x < 0
          || device.position.x + device.width > options.limitWidth
        )) || !hasProductionClearance(devices, 0)) continue;
      const rowDeviceOffsets = resolveRowDeviceOffsets(devices);
      rowVariants.push({
        devices,
        shiftedRowDeviceIds: rowDeviceOffsets.map((offset) => offset.deviceId),
        rowDeviceOffsets,
      });
    }
  }
  // A terminal row can contain unlike-width machines. Lowering one member by
  // one or two cells creates a bounded Tetris pocket without permuting the
  // material graph. The two-cell case is large enough for a 2x2 auxiliary
  // device (for example a power diffuser), while retaining every horizontal
  // corridor variant generated above.
  for (const rowVariant of [...rowVariants]) {
    for (const rowDeviceId of rowDeviceIds) {
      for (
        let deltaY = 1;
        deltaY <= GLOBAL_LAYER_INTERLOCK_POLICY.maximumTerminalRowStagger;
        deltaY += 1
      ) {
        const devices = rowVariant.devices.map((device): HeadlessPlacedDevice =>
          device.id === rowDeviceId
            ? { ...device, position: { x: device.position.x, y: device.position.y + deltaY } }
            : device);
        const moved = devices.find((device) => device.id === rowDeviceId);
        if (
          moved === undefined
          || moved.position.y + moved.height > options.limitHeight
          // The terminal is repositioned after the row variant is built. Its
          // stale pose must not reject an otherwise valid joint move.
          || !hasProductionClearance(
            devices.filter((device) => device.id !== terminal.id),
            0,
          )
        ) continue;
        const rowDeviceOffsets = resolveRowDeviceOffsets(devices);
        rowVariants.push({
          devices,
          shiftedRowDeviceIds: rowDeviceOffsets.map((offset) => offset.deviceId),
          rowDeviceOffsets,
        });
      }
    }
  }
  const rotations: readonly GridRotation[] = options.allowRotate
    ? [0, 90, 180, 270]
    : [terminal.rotation];
  const selected = new Map<string, SameRowTerminalPlacement>();
  for (const rowVariant of rowVariants) {
    const row = rowVariant.devices.filter((device) => rowIds.has(device.id));
    const rowMinimumX = Math.min(...row.map((device) => device.position.x));
    const rowMaximumX = Math.max(...row.map((device) => device.position.x + device.width));
    const rowMinimumY = Math.min(...row.map((device) => device.position.y));
    const rowMaximumY = Math.max(...row.map((device) => device.position.y + device.height));
    for (const rotation of rotations) {
      const swapsFootprint = (rotation - terminal.rotation + 360) % 180 !== 0;
      const width = swapsFootprint ? terminal.height : terminal.width;
      const height = swapsFootprint ? terminal.width : terminal.height;
      const yCandidates = [
        { alignment: "top" as const, y: rowMinimumY },
        {
          alignment: "middle" as const,
          y: Math.floor((rowMinimumY + rowMaximumY - height) / 2),
        },
        { alignment: "bottom" as const, y: rowMaximumY - height },
      ].filter((candidate, index, candidates) =>
        candidates.findIndex((other) => other.y === candidate.y) === index);
      for (const side of ["left", "right"] as const) {
        // One free column is the smallest useful side-facing port corridor: the
        // outside cells of both devices can share it without entering a footprint.
        const x = side === "right" ? rowMaximumX + 1 : rowMinimumX - width - 1;
        for (const { alignment, y } of yCandidates) {
          const movedTerminal: HeadlessPlacedDevice = {
            ...terminal,
            position: { x, y },
            rotation,
            width,
            height,
          };
          if (
            x < 0
            || y < 0
            || x + width > options.limitWidth
            || y + height > options.limitHeight
          ) continue;
          const devices = rowVariant.devices.map((device) =>
            device.id === terminal.id ? movedTerminal : device);
          if (!hasProductionClearance(devices, 0)) continue;
          const candidate: SameRowTerminalPlacement = {
            devices,
            terminalDeviceId: terminal.id,
            rowDeviceIds,
            shiftedRowDeviceIds: rowVariant.shiftedRowDeviceIds,
            rowDeviceOffsets: rowVariant.rowDeviceOffsets,
            side,
            alignment,
            rotation,
            rotationChanged: rotation !== terminal.rotation,
          };
          selected.set(
            `${terminal.id}@${x},${y},${rotation}:${rowDeviceIds.join(",")}:`
              + rowVariant.rowDeviceOffsets.map((offset) =>
                `${offset.deviceId}@${offset.deltaX},${offset.deltaY}`).join(","),
            candidate,
          );
        }
      }
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.rowDeviceIds.join("\u0000").localeCompare(right.rowDeviceIds.join("\u0000"))
    || left.side.localeCompare(right.side)
    || left.rotation - right.rotation
    || left.shiftedRowDeviceIds.join("\u0000")
      .localeCompare(right.shiftedRowDeviceIds.join("\u0000"))
    || left.rowDeviceOffsets.map((offset) =>
      `${offset.deviceId}@${offset.deltaX},${offset.deltaY}`).join("\u0000")
      .localeCompare(right.rowDeviceOffsets.map((offset) =>
        `${offset.deviceId}@${offset.deltaX},${offset.deltaY}`).join("\u0000"))
    || left.alignment.localeCompare(right.alignment));
}

export interface TerminalRowInterlockCandidate extends SameRowTerminalPlacement {
  readonly storageDeviceId: string | null;
  readonly movedDeviceIds: readonly string[];
  readonly widthFeasibility?: LayerInterlockWidthFeasibility;
}

interface GlobalLayerInterlockCandidateSet {
  readonly candidates: readonly TerminalRowInterlockCandidate[];
  readonly widthRejected: number;
}

function createGlobalLayerInterlockCandidates(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly requests: readonly DeviceRequest[];
  readonly routedConnections: readonly {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): GlobalLayerInterlockCandidateSet {
  const deviceById = new Map(options.devices.map((device) => [device.id, device]));
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const selected = new Map<string, TerminalRowInterlockCandidate>();
  const unloaders = options.devices.filter((device) => device.kind === "warehouse-port");
  const frontageBounds = unloaders.length === 0
    ? { minX: 0, minY: 0, maxX: options.limitWidth, maxY: 0 }
    : {
        minX: Math.min(...unloaders.map((device) => device.position.x)),
        minY: Math.min(...unloaders.map((device) => device.position.y)),
        maxX: Math.max(...unloaders.map((device) => device.position.x + device.width)),
        maxY: Math.max(...unloaders.map((device) => device.position.y + device.height)),
      };
  const verticalFrontage = frontageBounds.maxY - frontageBounds.minY
    >= frontageBounds.maxX - frontageBounds.minX;
  const frontageWidth = verticalFrontage
    ? frontageBounds.maxY - frontageBounds.minY
    : frontageBounds.maxX - frontageBounds.minX;
  const projectedWidth = (device: HeadlessPlacedDevice): number =>
    verticalFrontage ? device.height : device.width;
  let widthRejected = 0;
  const groupIntoPhysicalRows = (
    devices: readonly HeadlessPlacedDevice[],
  ): readonly (readonly HeadlessPlacedDevice[])[] => {
    const remaining = new Map(devices.map((device) => [device.id, device]));
    const rows: HeadlessPlacedDevice[][] = [];
    while (remaining.size > 0) {
      const first = [...remaining.values()].sort((left, right) =>
        left.position.y - right.position.y || left.position.x - right.position.x)[0]!;
      remaining.delete(first.id);
      const row = [first];
      for (let cursor = 0; cursor < row.length; cursor += 1) {
        const member = row[cursor]!;
        for (const candidate of [...remaining.values()]) {
          if (
            member.position.y < candidate.position.y + candidate.height
            && member.position.y + member.height > candidate.position.y
          ) {
            remaining.delete(candidate.id);
            row.push(candidate);
          }
        }
      }
      rows.push(row.sort((left, right) => left.position.x - right.position.x));
    }
    return rows;
  };
  for (const terminal of options.devices.filter((device) => device.kind === "production")) {
    const storageDeviceIds = [...new Set(options.routedConnections
      .filter((connection) => connection.sourceDeviceId === terminal.id)
      .map((connection) => connection.targetDeviceId)
      .filter((deviceId): deviceId is string =>
        deviceId !== null && deviceById.get(deviceId)?.kind === "storage"))]
      .sort();
    if (storageDeviceIds.length === 0) continue;
    const storageIds = new Set(storageDeviceIds);
    const terminalLayerDeviceIds = new Set(options.routedConnections
      .filter((connection) =>
        connection.sourceDeviceId !== null
        && connection.targetDeviceId !== null
        && storageIds.has(connection.targetDeviceId)
        && deviceById.get(connection.sourceDeviceId)?.kind === "production")
      .map((connection) => connection.sourceDeviceId!));
    terminalLayerDeviceIds.add(terminal.id);
    const terminalLayerDevices = [...terminalLayerDeviceIds]
      .flatMap((deviceId) => {
        const device = deviceById.get(deviceId);
        return device === undefined ? [] : [device];
      });
    const directProducers = [...new Set(options.routedConnections
      .filter((connection) => connection.targetDeviceId === terminal.id)
      .map((connection) => connection.sourceDeviceId)
      .filter((deviceId): deviceId is string =>
        deviceId !== null && deviceById.get(deviceId)?.kind === "production"))]
      .map((deviceId) => deviceById.get(deviceId)!)
      .sort((left, right) => left.position.y - right.position.y
        || left.position.x - right.position.x);
    if (directProducers.length === 0) continue;
    for (const row of groupIntoPhysicalRows(directProducers)) {
      const rowDeviceIds = row.map((device) => device.id).sort();
      const rowIds = new Set(rowDeviceIds);
      const requiredRoutingColumns = Math.max(1, options.routedConnections.filter((connection) =>
        connection.sourceDeviceId !== null
        && connection.targetDeviceId !== null
        && rowIds.has(connection.sourceDeviceId)
        && terminalLayerDeviceIds.has(connection.targetDeviceId)).length);
      const widthFeasibility = assessLayerInterlockWidthFeasibility({
        frontageWidth,
        terminalLayerDeviceWidths: terminalLayerDevices.map(projectedWidth),
        insertedLayerDeviceWidths: row.map(projectedWidth),
        requiredRoutingColumns,
      });
      if (!widthFeasibility.feasible) {
        widthRejected += 1;
        continue;
      }
      const placements = createSameRowTerminalPlacements({
        devices: options.devices,
        terminalDeviceId: terminal.id,
        rowDeviceIds,
        limitWidth: options.limitWidth,
        limitHeight: options.limitHeight,
        allowRotate: options.allowRotate,
      });
      for (const placement of placements) {
        const placedTerminal = placement.devices.find((device) => device.id === terminal.id)!;
        const terminalOnly: TerminalRowInterlockCandidate = {
          ...placement,
          storageDeviceId: null,
          movedDeviceIds: [terminal.id, ...placement.shiftedRowDeviceIds],
          widthFeasibility,
        };
        if (measureFrontageOverflowCells(terminalOnly.devices) > 0) continue;
        selected.set(packingSignature({
          devices: terminalOnly.devices,
          usedWidth: 0,
          usedHeight: 0,
          equipmentArea: 0,
        }), terminalOnly);
        const terminalRequest = requestById.get(terminal.id);
        const outputEdge = terminalRequest === undefined
          ? null
          : resolvePortEdge(terminalRequest, "output", placedTerminal.rotation);
        if (outputEdge === null) continue;
        for (const storageDeviceId of storageDeviceIds) {
          const storage = deviceById.get(storageDeviceId);
          const storageRequest = requestById.get(storageDeviceId);
          if (storage === undefined || storageRequest === undefined) continue;
          const desiredInputEdge = oppositeGridEdge(outputEdge);
          const storageRotation = options.allowRotate
            ? resolvePortFacingRotation(storageRequest, "input", desiredInputEdge)
            : resolvePortEdge(storageRequest, "input", storage.rotation) === desiredInputEdge
              ? storage.rotation
              : null;
          if (storageRotation === null) continue;
          const swapsStorage = (storageRotation - storage.rotation + 360) % 180 !== 0;
          const storageWidth = swapsStorage ? storage.height : storage.width;
          const storageHeight = swapsStorage ? storage.width : storage.height;
          const alignments = outputEdge === "EAST" || outputEdge === "WEST"
            ? [
                { x: 0, y: placedTerminal.position.y },
                {
                  x: 0,
                  y: Math.floor(
                    placedTerminal.position.y
                    + (placedTerminal.height - storageHeight) / 2,
                  ),
                },
                {
                  x: 0,
                  y: placedTerminal.position.y + placedTerminal.height - storageHeight,
                },
              ]
            : [
                { x: placedTerminal.position.x, y: 0 },
                {
                  x: Math.floor(
                    placedTerminal.position.x
                    + (placedTerminal.width - storageWidth) / 2,
                  ),
                  y: 0,
                },
                {
                  x: placedTerminal.position.x + placedTerminal.width - storageWidth,
                  y: 0,
                },
              ];
          for (const alignment of alignments.filter((candidate, index, candidates) =>
            candidates.findIndex((other) =>
              other.x === candidate.x && other.y === candidate.y) === index)) {
            const position = outputEdge === "EAST"
              ? { x: placedTerminal.position.x + placedTerminal.width + 1, y: alignment.y }
              : outputEdge === "WEST"
                ? { x: placedTerminal.position.x - storageWidth - 1, y: alignment.y }
                : outputEdge === "SOUTH"
                  ? { x: alignment.x, y: placedTerminal.position.y + placedTerminal.height + 1 }
                  : { x: alignment.x, y: placedTerminal.position.y - storageHeight - 1 };
            const movedStorage: HeadlessPlacedDevice = {
              ...storage,
              position,
              rotation: storageRotation,
              width: storageWidth,
              height: storageHeight,
            };
            if (
              position.x < 0
              || position.y < 0
              || position.x + storageWidth > options.limitWidth
              || position.y + storageHeight > options.limitHeight
            ) continue;
            const devices = placement.devices.map((device) =>
              device.id === storage.id ? movedStorage : device);
            if (!hasProductionClearance(devices, 0)) continue;
            const candidate: TerminalRowInterlockCandidate = {
              ...placement,
              devices,
              storageDeviceId: storage.id,
              movedDeviceIds: [terminal.id, storage.id, ...placement.shiftedRowDeviceIds],
              widthFeasibility,
            };
            if (measureFrontageOverflowCells(candidate.devices) > 0) continue;
            selected.set(packingSignature({
              devices,
              usedWidth: 0,
              usedHeight: 0,
              equipmentArea: 0,
            }), candidate);
          }
        }
      }
    }
  }
  return { candidates: [...selected.values()], widthRejected };
}

export function selectTerminalRowInterlockBeam(options: {
  readonly candidates: readonly TerminalRowInterlockCandidate[];
  readonly routedConnections: readonly {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }[];
  readonly maximum: number;
}): TerminalRowInterlockCandidate[] {
  if (options.maximum <= 0) return [];
  const connectionDistance = (candidate: TerminalRowInterlockCandidate): number => {
    const deviceById = new Map(candidate.devices.map((device) => [device.id, device]));
    return options.routedConnections.reduce((sum, connection) => {
      if (connection.sourceDeviceId === null || connection.targetDeviceId === null) return sum;
      const source = deviceById.get(connection.sourceDeviceId);
      const target = deviceById.get(connection.targetDeviceId);
      return source === undefined || target === undefined
        ? sum
        : sum + manhattan(deviceCenter(source), deviceCenter(target));
    }, 0);
  };
  const compareProxy = (
    left: TerminalRowInterlockCandidate,
    right: TerminalRowInterlockCandidate,
  ): number =>
    measureDeviceBoundingAreaLowerBound(left.devices)
      - measureDeviceBoundingAreaLowerBound(right.devices)
    || connectionDistance(left) - connectionDistance(right)
    || Number(left.storageDeviceId === null) - Number(right.storageDeviceId === null)
    || left.terminalDeviceId.localeCompare(right.terminalDeviceId)
    || left.rowDeviceIds.join("\u0000").localeCompare(right.rowDeviceIds.join("\u0000"))
    || left.rotation - right.rotation;
  const candidatesByTerminal = new Map<string, TerminalRowInterlockCandidate[]>();
  for (const candidate of options.candidates) {
    candidatesByTerminal.set(candidate.terminalDeviceId, [
      ...(candidatesByTerminal.get(candidate.terminalDeviceId) ?? []),
      candidate,
    ]);
  }
  const perTerminalMaximum = Math.max(
    1,
    Math.ceil(options.maximum / Math.max(1, candidatesByTerminal.size)),
  );
  const selected: TerminalRowInterlockCandidate[] = [];
  for (const terminalId of [...candidatesByTerminal.keys()].sort()) {
    const familyBest = new Map<string, TerminalRowInterlockCandidate>();
    for (const candidate of candidatesByTerminal.get(terminalId) ?? []) {
      const family = `${candidate.rowDeviceIds.join(",")}:${candidate.side}:`
        + `${candidate.rotation}:${candidate.storageDeviceId ?? "none"}:`
        + candidate.rowDeviceOffsets.map((offset) =>
          `${offset.deviceId}@${offset.deltaX},${offset.deltaY}`).join(",");
      const current = familyBest.get(family);
      if (current === undefined || compareProxy(candidate, current) < 0) {
        familyBest.set(family, candidate);
      }
    }
    selected.push(...[...familyBest.values()].sort(compareProxy).slice(0, perTerminalMaximum));
  }
  // A one-cell corridor inserted inside the upstream row has a specific
  // top-aligned witness: it aligns the unrotated terminal frontage with the
  // row above. Do not collapse it into a vertically shifted proxy family.
  const staggeredSideCoordinate = (candidate: TerminalRowInterlockCandidate): number => {
    const staggeredDevices = candidate.rowDeviceOffsets
      .filter((offset) =>
        offset.deltaY === GLOBAL_LAYER_INTERLOCK_POLICY.maximumTerminalRowStagger)
      .flatMap((offset) => {
        const device = candidate.devices.find((item) => item.id === offset.deviceId);
        return device === undefined ? [] : [device];
      });
    if (staggeredDevices.length === 0) return Number.POSITIVE_INFINITY;
    return candidate.side === "right"
      ? -Math.max(...staggeredDevices.map((device) => device.position.x + device.width))
      : Math.min(...staggeredDevices.map((device) => device.position.x));
  };
  const powerPocketCandidates = options.candidates
    .filter((candidate) =>
      candidate.side === "right"
      && candidate.alignment === "top"
      && !candidate.rotationChanged
      && candidate.rowDeviceOffsets.some((offset) =>
        offset.deltaY === GLOBAL_LAYER_INTERLOCK_POLICY.maximumTerminalRowStagger))
    // Prefer staggering the row member next to the terminal. This preserves a
    // contiguous 2x2 pocket at the interlock seam instead of creating an
    // isolated notch behind a sibling device.
    .sort((left, right) =>
      staggeredSideCoordinate(left) - staggeredSideCoordinate(right)
      || compareProxy(left, right));
  const powerPocketCandidatesByRow = new Map<string, TerminalRowInterlockCandidate[]>();
  for (const candidate of powerPocketCandidates) {
    const key = `${candidate.terminalDeviceId}:${candidate.rowDeviceIds.join(",")}`;
    powerPocketCandidatesByRow.set(key, [
      ...(powerPocketCandidatesByRow.get(key) ?? []),
      candidate,
    ]);
  }
  const powerPocketReserved = [...powerPocketCandidatesByRow.keys()]
    .sort()
    .flatMap((key) => (powerPocketCandidatesByRow.get(key) ?? []).slice(0, 2));
  const reserved = options.candidates
    .filter((candidate) =>
      candidate.side === "right"
      && candidate.alignment === "top"
      && !candidate.rotationChanged
      && candidate.shiftedRowDeviceIds.length > 0)
    .sort(compareProxy);
  const merged = new Map<string, TerminalRowInterlockCandidate>();
  for (const candidate of powerPocketReserved.slice(0, 8)) {
    merged.set(packingSignature({
      devices: candidate.devices,
      usedWidth: 0,
      usedHeight: 0,
      equipmentArea: 0,
    }), candidate);
  }
  for (const candidate of reserved.slice(0, 4)) {
    merged.set(packingSignature({
      devices: candidate.devices,
      usedWidth: 0,
      usedHeight: 0,
      equipmentArea: 0,
    }), candidate);
  }
  for (const candidate of selected.sort(compareProxy)) {
    if (merged.size >= options.maximum) break;
    merged.set(packingSignature({
      devices: candidate.devices,
      usedWidth: 0,
      usedHeight: 0,
      equipmentArea: 0,
    }), candidate);
  }
  return [...merged.values()].slice(0, options.maximum);
}

export interface EdgeStorageMovementCandidate {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly storageDeviceId: string;
  readonly producerDeviceIds: readonly string[];
  readonly deltaX: number;
  readonly deltaY: number;
  readonly rotation: GridRotation;
}

/**
 * Build a bounded one-cell pose neighborhood for terminal storage devices.
 *
 * Storage participates in the routed outline and therefore cannot remain a
 * permanent anchor after its producer moves. Translation, rotation, and their
 * combinations are enumerated together because a useful input-facing pose can
 * be infeasible until the storage also leaves its old row or column. Repeated
 * fixed-point rounds provide longer translations without allowing an
 * unverified jump across equipment or logistics corridors.
 */
export function createEdgeStorageMovementCandidates(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly routedConnections: readonly {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
}): EdgeStorageMovementCandidate[] {
  const deviceById = new Map(options.devices.map((device) => [device.id, device]));
  const translations = [-1, 0, 1].flatMap((deltaY) =>
    [-1, 0, 1].map((deltaX) => ({ deltaX, deltaY })));
  const selected = new Map<string, EdgeStorageMovementCandidate>();
  for (const storage of options.devices.filter((device) => device.kind === "storage")) {
    const producerDeviceIds = [...new Set(options.routedConnections
      .filter((connection) => connection.targetDeviceId === storage.id)
      .map((connection) => connection.sourceDeviceId)
      .filter((deviceId): deviceId is string =>
        deviceId !== null && deviceById.get(deviceId)?.kind === "production"))]
      .sort();
    if (producerDeviceIds.length === 0) continue;
    const rotations: readonly GridRotation[] = options.allowRotate
      ? [0, 90, 180, 270]
      : [storage.rotation];
    for (const rotation of rotations) {
      const swapsFootprint = (rotation - storage.rotation + 360) % 180 !== 0;
      const width = swapsFootprint ? storage.height : storage.width;
      const height = swapsFootprint ? storage.width : storage.height;
      for (const { deltaX, deltaY } of translations) {
        if (deltaX === 0 && deltaY === 0 && rotation === storage.rotation) continue;
        const movedStorage: HeadlessPlacedDevice = {
          ...storage,
          position: {
            x: storage.position.x + deltaX,
            y: storage.position.y + deltaY,
          },
          rotation,
          width,
          height,
        };
        if (
          movedStorage.position.x < 0
          || movedStorage.position.y < 0
          || movedStorage.position.x + movedStorage.width > options.limitWidth
          || movedStorage.position.y + movedStorage.height > options.limitHeight
        ) continue;
        const devices = options.devices.map((device) =>
          device.id === storage.id ? movedStorage : device);
        if (!hasProductionClearance(devices, 0)) continue;
        const candidate: EdgeStorageMovementCandidate = {
          devices,
          storageDeviceId: storage.id,
          producerDeviceIds,
          deltaX,
          deltaY,
          rotation,
        };
        selected.set(
          `${storage.id}@${movedStorage.position.x},${movedStorage.position.y},${rotation}`,
          candidate,
        );
      }
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.storageDeviceId.localeCompare(right.storageDeviceId)
    || Math.abs(left.deltaX) + Math.abs(left.deltaY)
      - Math.abs(right.deltaX) - Math.abs(right.deltaY)
    || left.rotation - right.rotation
    || left.deltaY - right.deltaY
    || left.deltaX - right.deltaX);
}

/** Select a diverse, geometry-ranked storage pose beam for full rerouting. */
export function selectEdgeStorageMovementBeam(options: {
  readonly candidates: readonly EdgeStorageMovementCandidate[];
  readonly maximum: number;
}): EdgeStorageMovementCandidate[] {
  if (options.maximum <= 0) return [];
  const candidatesByStorage = new Map<string, EdgeStorageMovementCandidate[]>();
  for (const candidate of options.candidates) {
    candidatesByStorage.set(candidate.storageDeviceId, [
      ...(candidatesByStorage.get(candidate.storageDeviceId) ?? []),
      candidate,
    ]);
  }
  const compareProxy = (
    left: EdgeStorageMovementCandidate,
    right: EdgeStorageMovementCandidate,
  ): number => {
    const producerDistance = (candidate: EdgeStorageMovementCandidate): number => {
      const deviceById = new Map(candidate.devices.map((device) => [device.id, device]));
      const storage = deviceById.get(candidate.storageDeviceId)!;
      return candidate.producerDeviceIds.reduce((sum, producerId) => {
        const producer = deviceById.get(producerId);
        return producer === undefined
          ? sum
          : sum + manhattan(deviceCenter(storage), deviceCenter(producer));
      }, 0);
    };
    return measureDeviceBoundingAreaLowerBound(left.devices)
      - measureDeviceBoundingAreaLowerBound(right.devices)
      || producerDistance(left) - producerDistance(right)
      || Math.abs(left.deltaX) + Math.abs(left.deltaY)
        - Math.abs(right.deltaX) - Math.abs(right.deltaY)
      || left.rotation - right.rotation
      || left.deltaY - right.deltaY
      || left.deltaX - right.deltaX;
  };
  const storageIds = [...candidatesByStorage.keys()].sort();
  const perStorageMaximum = Math.max(
    1,
    Math.ceil(options.maximum / Math.max(1, storageIds.length)),
  );
  const selected: EdgeStorageMovementCandidate[] = [];
  for (const storageId of storageIds) {
    const familyBest = new Map<string, EdgeStorageMovementCandidate>();
    for (const candidate of candidatesByStorage.get(storageId) ?? []) {
      const family = `${candidate.rotation}:`
        + `${Math.sign(candidate.deltaX)},${Math.sign(candidate.deltaY)}`;
      const current = familyBest.get(family);
      if (current === undefined || compareProxy(candidate, current) < 0) {
        familyBest.set(family, candidate);
      }
    }
    selected.push(...[...familyBest.values()]
      .sort(compareProxy)
      .slice(0, perStorageMaximum));
  }
  return selected.sort(compareProxy).slice(0, options.maximum);
}

/**
 * Build post-routing equipment moves for upstream physical rows.
 *
 * Devices belong to one row when their vertical footprints overlap, including
 * transitively. Consequently a shorter device can use every legal y position
 * inside a neighbouring taller-device band. Production rows that feed another
 * production row are included. A singleton production terminal that receives
 * internal material and feeds storage may also move vertically by one cell;
 * repeated convergence rounds safely contract several straight approach cells
 * without moving the storage anchor or jumping across an unverified corridor.
 */
export function createUpstreamRowMovementCandidates(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly routedConnections: readonly {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
  readonly maximumHorizontalDistance?: number;
}): UpstreamRowMovementCandidate[] {
  const productionDevices = options.devices.filter((device) => device.kind === "production");
  if (productionDevices.length < 2) return [];
  const parent = productionDevices.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let leftIndex = 0; leftIndex < productionDevices.length; leftIndex += 1) {
    const left = productionDevices[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < productionDevices.length; rightIndex += 1) {
      const right = productionDevices[rightIndex]!;
      if (
        left.position.y < right.position.y + right.height
        && left.position.y + left.height > right.position.y
      ) {
        union(leftIndex, rightIndex);
      }
    }
  }
  const rowsByRoot = new Map<number, HeadlessPlacedDevice[]>();
  for (const [index, device] of productionDevices.entries()) {
    const root = find(index);
    rowsByRoot.set(root, [...(rowsByRoot.get(root) ?? []), device]);
  }
  const deviceById = new Map(options.devices.map((device) => [device.id, device]));
  const maximumHorizontalDistance = Math.max(
    1,
    Math.min(4, Math.floor(options.maximumHorizontalDistance ?? 3)),
  );
  const selected = new Map<string, UpstreamRowMovementCandidate>();
  const addCandidate = (candidate: UpstreamRowMovementCandidate): void => {
    const signature = candidate.devices
      .filter((device) => candidate.movedDeviceIds.includes(device.id))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((device) =>
        `${device.id}@${device.position.x},${device.position.y},${device.rotation}`)
      .join("|");
    selected.set(signature, candidate);
  };
  const rows = [...rowsByRoot.values()]
    .filter((row) => row.length >= 1)
    .sort((left, right) =>
      Math.min(...left.map((device) => device.position.y))
      - Math.min(...right.map((device) => device.position.y))
      || Math.min(...left.map((device) => device.position.x))
      - Math.min(...right.map((device) => device.position.x)));
  for (const row of rows) {
    const rowDeviceIds = row.map((device) => device.id).sort();
    const rowIds = new Set(rowDeviceIds);
    const feedsAnotherProductionRow = options.routedConnections.some((connection) => {
      if (connection.sourceDeviceId === null
        || connection.targetDeviceId === null
        || !rowIds.has(connection.sourceDeviceId)
        || rowIds.has(connection.targetDeviceId)) return false;
      return deviceById.get(connection.targetDeviceId)?.kind === "production";
    });
    const singletonTerminalProducer = row.length === 1
      && options.routedConnections.some((connection) =>
        connection.sourceDeviceId !== null
        && connection.targetDeviceId !== null
        && !rowIds.has(connection.sourceDeviceId)
        && rowIds.has(connection.targetDeviceId)
        && deviceById.get(connection.sourceDeviceId)?.kind === "production")
      && options.routedConnections.some((connection) =>
        connection.sourceDeviceId !== null
        && connection.targetDeviceId !== null
        && rowIds.has(connection.sourceDeviceId)
        && !rowIds.has(connection.targetDeviceId)
        && deviceById.get(connection.targetDeviceId)?.kind === "storage");
    if (!feedsAnotherProductionRow && !singletonTerminalProducer) continue;
    const rowMinY = Math.min(...row.map((device) => device.position.y));
    const rowMaxY = Math.max(...row.map((device) => device.position.y + device.height));
    for (const direction of [-1, 1] as const) {
      for (let distance = 1; distance <= maximumHorizontalDistance; distance += 1) {
        const deltaX = direction * distance;
        const devices = translateRigidDeviceCluster({
          devices: options.devices,
          deviceIds: rowIds,
          deltaX,
          deltaY: 0,
          limitWidth: options.limitWidth,
          limitHeight: options.limitHeight,
        });
        if (devices === null) break;
        addCandidate({
          devices,
          operation: "rigid-row",
          rowDeviceIds,
          movedDeviceIds: rowDeviceIds,
          rowMinY,
          rowMaxY,
          deltaX,
          deltaY: 0,
          rotation: 0,
        });
      }
    }
    if (singletonTerminalProducer) {
      for (const deltaY of [-1, 1] as const) {
        const devices = translateRigidDeviceCluster({
          devices: options.devices,
          deviceIds: rowIds,
          deltaX: 0,
          deltaY,
          limitWidth: options.limitWidth,
          limitHeight: options.limitHeight,
        });
        if (devices === null) continue;
        addCandidate({
          devices,
          operation: "rigid-row",
          rowDeviceIds,
          movedDeviceIds: rowDeviceIds,
          rowMinY,
          rowMaxY,
          deltaX: 0,
          deltaY,
          rotation: 0,
        });
      }
    }
    for (const original of row) {
      const rotationDeltas = options.allowRotate
        ? [0, 90, 180, 270] as const
        : [0] as const;
      for (const rotationDelta of rotationDeltas) {
        const swapsFootprint = rotationDelta === 90 || rotationDelta === 270;
        const width = swapsFootprint ? original.height : original.width;
        const height = swapsFootprint ? original.width : original.height;
        if (height > rowMaxY - rowMinY) continue;
        const rotation = ((original.rotation + rotationDelta) % 360) as GridRotation;
        for (let y = rowMinY; y <= rowMaxY - height; y += 1) {
          for (
            let deltaX = -maximumHorizontalDistance;
            deltaX <= maximumHorizontalDistance;
            deltaX += 1
          ) {
            if (
              deltaX === 0
              && y === original.position.y
              && rotationDelta === 0
            ) continue;
            const movedDevice: HeadlessPlacedDevice = {
              ...original,
              position: {
                x: original.position.x + deltaX,
                y,
              },
              rotation,
              width,
              height,
            };
            if (
              movedDevice.position.x < 0
              || movedDevice.position.y < 0
              || movedDevice.position.x + movedDevice.width > options.limitWidth
              || movedDevice.position.y + movedDevice.height > options.limitHeight
            ) continue;
            const devices = options.devices.map((device) =>
              device.id === original.id ? movedDevice : device);
            if (!hasProductionClearance(devices, 0)) continue;
            addCandidate({
              devices,
              operation: "single-device",
              rowDeviceIds,
              movedDeviceIds: [original.id],
              rowMinY,
              rowMaxY,
              deltaX,
              deltaY: y - original.position.y,
              rotation,
            });
          }
        }
      }
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.rowMinY - right.rowMinY
    || left.operation.localeCompare(right.operation)
    || left.movedDeviceIds.join("\u0000").localeCompare(right.movedDeviceIds.join("\u0000"))
    || Math.abs(left.deltaX) - Math.abs(right.deltaX)
    || Math.abs(left.deltaY) - Math.abs(right.deltaY)
    || left.rotation - right.rotation);
}

export function selectUpstreamRowMovementBeam(options: {
  readonly candidates: readonly UpstreamRowMovementCandidate[];
  readonly routedConnections: readonly {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
    readonly points: readonly GridPoint[];
  }[];
  readonly maximum: number;
}): UpstreamRowMovementCandidate[] {
  if (options.maximum <= 0) return [];
  const candidatesByRow = new Map<string, UpstreamRowMovementCandidate[]>();
  for (const candidate of options.candidates) {
    const key = candidate.rowDeviceIds.join("\u0000");
    candidatesByRow.set(key, [...(candidatesByRow.get(key) ?? []), candidate]);
  }
  const routeBurden = (rowIds: ReadonlySet<string>): number =>
    options.routedConnections.reduce((sum, connection) => {
      const incident = (connection.sourceDeviceId !== null && rowIds.has(connection.sourceDeviceId))
        || (connection.targetDeviceId !== null && rowIds.has(connection.targetDeviceId));
      if (!incident || connection.points.length === 0) return sum;
      const first = connection.points[0]!;
      const last = connection.points.at(-1)!;
      const minimum = manhattan(first, last);
      return sum + connection.points.length + Math.max(0, connection.points.length - 1 - minimum) * 4;
    }, 0);
  const orderedRows = [...candidatesByRow.entries()]
    .map(([key, candidates]) => {
      const sample = candidates[0]!;
      const devices = sample.devices.filter((device) => sample.rowDeviceIds.includes(device.id));
      return {
        key,
        candidates,
        heightSpread: Math.max(...devices.map((device) => device.height))
          - Math.min(...devices.map((device) => device.height)),
        reciprocalConnectionCount: (() => {
          const rowIds = new Set(sample.rowDeviceIds);
          const directedPairs = new Set(options.routedConnections
            .filter((connection) =>
              connection.sourceDeviceId !== null
              && connection.targetDeviceId !== null
              && rowIds.has(connection.sourceDeviceId)
              && rowIds.has(connection.targetDeviceId))
            .map((connection) =>
              `${connection.sourceDeviceId}\u0000${connection.targetDeviceId}`));
          let reciprocal = 0;
          for (const pair of directedPairs) {
            const [sourceId, targetId] = pair.split("\u0000");
            if (sourceId! < targetId!
              && directedPairs.has(`${targetId}\u0000${sourceId}`)) reciprocal += 1;
          }
          return reciprocal;
        })(),
        routeBurden: routeBurden(new Set(sample.rowDeviceIds)),
      };
    })
    .sort((left, right) =>
      right.heightSpread - left.heightSpread
      || right.reciprocalConnectionCount - left.reciprocalConnectionCount
      || right.routeBurden - left.routeBurden
      || left.key.localeCompare(right.key))
    .slice(0, 2);
  const connectionDistance = (candidate: UpstreamRowMovementCandidate): number => {
    const deviceById = new Map(candidate.devices.map((device) => [device.id, device]));
    return options.routedConnections.reduce((sum, connection) => {
      if (connection.sourceDeviceId === null || connection.targetDeviceId === null) return sum;
      const source = deviceById.get(connection.sourceDeviceId);
      const target = deviceById.get(connection.targetDeviceId);
      return source === undefined || target === undefined
        ? sum
        : sum + manhattan(deviceCenter(source), deviceCenter(target));
    }, 0);
  };
  const compareProxy = (
    left: UpstreamRowMovementCandidate,
    right: UpstreamRowMovementCandidate,
  ): number =>
    connectionDistance(left) - connectionDistance(right)
    || Math.abs(left.deltaX) + Math.abs(left.deltaY)
      - Math.abs(right.deltaX) - Math.abs(right.deltaY)
    || left.rotation - right.rotation
    || left.movedDeviceIds.join("\u0000").localeCompare(right.movedDeviceIds.join("\u0000"));
  const selected = new Map<string, UpstreamRowMovementCandidate>();
  const perRowMaximum = Math.max(1, Math.ceil(options.maximum / Math.max(1, orderedRows.length)));
  for (const row of orderedRows) {
    const familyBest = new Map<string, UpstreamRowMovementCandidate>();
    for (const candidate of row.candidates) {
      const family = candidate.operation === "rigid-row"
        ? `row:${Math.sign(candidate.deltaX)},${Math.sign(candidate.deltaY)}`
        : `device:${candidate.movedDeviceIds[0]}:rotation:${candidate.rotation}`;
      const current = familyBest.get(family);
      if (current === undefined || compareProxy(candidate, current) < 0) {
        familyBest.set(family, candidate);
      }
    }
    const rowCandidates = [...familyBest.values()].sort((left, right) =>
      Number(left.operation !== "rigid-row") - Number(right.operation !== "rigid-row")
      || Math.min(...left.devices
        .filter((device) => left.movedDeviceIds.includes(device.id))
        .map((device) => device.height))
      - Math.min(...right.devices
        .filter((device) => right.movedDeviceIds.includes(device.id))
        .map((device) => device.height))
      || compareProxy(left, right));
    for (const candidate of rowCandidates.slice(0, perRowMaximum)) {
      const signature = candidate.devices
        .filter((device) => candidate.movedDeviceIds.includes(device.id))
        .map((device) => `${device.id}@${device.position.x},${device.position.y},${device.rotation}`)
        .join("|");
      selected.set(signature, candidate);
    }
  }
  return [...selected.values()].slice(0, options.maximum);
}

function createPackingNeighbors(
  packing: PackingResult,
  limitWidth: number,
  limitHeight: number,
  routingClearance: number,
  requests: readonly DeviceRequest[],
  registry: RegistryContract,
  allowRotate: boolean,
  routing: RoutingResult,
  localOnly: boolean,
  cpSat: {
    readonly maxSeconds: number;
    readonly candidateCount: number;
    readonly seed: number;
    readonly enableGlobalRebuild: boolean;
    readonly forbiddenLayouts: readonly (readonly CpSatLayoutPlacement[])[];
    readonly capacityCuts: readonly CpSatLayoutCapacityCut[];
  } | null,
): PackingNeighborSet {
  const traceStartedAt = Date.now();
  let traceCheckpoint = traceStartedAt;
  const routedLogistics = routing.devices;
  const routedConnections = routing.connections;
  const traceStage = (stage: string): void => {
    if (process.env["INDUSTRIAL_PLANNER_TRACE_SEARCH_PROGRESS"] !== "1") return;
    const now = Date.now();
    console.error(`[packing-neighbors:${stage}] stageMs=${now - traceCheckpoint} totalMs=${now - traceStartedAt}`);
    traceCheckpoint = now;
  };
  const result = new Map<string, PackingResult>();
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  const baselineDirectionPenalty = measureAcyclicFlowDirectionPenalty(packing.devices, requestsById);
  const directions = [
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 1 },
  ] as const;
  for (let deviceIndex = 0; deviceIndex < packing.devices.length; deviceIndex += 1) {
    const device = packing.devices[deviceIndex]!;
    if (device.kind !== "production" && device.kind !== "storage") continue;
    for (const direction of directions) {
      const legalMoves: PackingResult[] = [];
      const maximumDistance = localOnly ? 3 : direction.x === 0 ? limitHeight : limitWidth;
      for (let distance = 1; distance <= maximumDistance; distance += 1) {
        const devices = packing.devices.map((device, index): HeadlessPlacedDevice => index === deviceIndex
          ? {
              ...device,
              position: {
                x: device.position.x + direction.x * distance,
                y: device.position.y + direction.y * distance,
              },
            }
          : device);
        const moved = devices[deviceIndex]!;
        if (
          moved.position.x < routingClearance
          || moved.position.y < routingClearance
          || moved.position.x + moved.width + routingClearance > limitWidth
          || moved.position.y + moved.height + routingClearance > limitHeight
          || !hasProductionClearance(devices, 0)
        ) break;
        const neighbor = createMovedPacking(packing, devices, routingClearance);
        legalMoves.push({
          ...neighbor,
          debugLabel: `local-${device.kind}:translate:${device.id}:${direction.x},${direction.y}:${distance}`,
        });
      }
      const selectedMoves = new Map<string, PackingResult>();
      for (const neighbor of [
        ...legalMoves.sort(comparePacking).slice(0, 4),
        legalMoves[0],
        legalMoves.at(-1),
      ]) {
        if (neighbor === undefined) continue;
        selectedMoves.set(packingSignature(neighbor), neighbor);
      }
      selectedMoves.forEach((neighbor, signature) => result.set(signature, neighbor));
    }
    for (const rotationDelta of [90, 180, 270] as const) {
      const rotation = ((device.rotation + rotationDelta) % 360) as GridRotation;
      const swapsFootprint = rotationDelta === 90 || rotationDelta === 270;
      const devices = packing.devices.map((item, index): HeadlessPlacedDevice => index === deviceIndex
        ? {
            ...item,
            rotation,
            width: swapsFootprint ? item.height : item.width,
            height: swapsFootprint ? item.width : item.height,
          }
        : item);
      const rotated = devices[deviceIndex]!;
      if (
        rotated.position.x + rotated.width + routingClearance > limitWidth
        || rotated.position.y + rotated.height + routingClearance > limitHeight
        || !hasProductionClearance(devices, 0)
      ) {
        continue;
      }
      const usedWidth = devices.reduce(
        (maximum, item) => Math.max(maximum, item.position.x + item.width + routingClearance),
        0,
      );
      const usedHeight = devices.reduce(
        (maximum, item) => Math.max(maximum, item.position.y + item.height + routingClearance),
        0,
      );
      const neighbor: PackingResult = {
        devices,
        usedWidth,
        usedHeight,
        equipmentArea: packing.equipmentArea,
        debugLabel: `local-${device.kind}:rotate:${device.id}:${rotation}`,
      };
      result.set(packingSignature(neighbor), neighbor);
    }
  }
  traceStage("single-device");
  const sccInternalRearrangements = createSccInternalRearrangementNeighbors({
    packing,
    requests,
    registry,
    routedConnections,
    limitWidth,
    limitHeight,
    routingClearance,
  });
  for (const neighbor of sccInternalRearrangements.packings) {
    result.set(packingSignature(neighbor), neighbor);
  }
  traceStage("scc-internal-rearrangement");
  const straightLineCollapses = createStraightBeltRowCollapseNeighbors({
    packing,
    routing,
    limitWidth,
    limitHeight,
    routingClearance,
  });
  for (const neighbor of straightLineCollapses.packings) {
    result.set(packingSignature(neighbor), neighbor);
  }
  traceStage("straight-line-collapse");
  const terminalClusterTranslations = createTerminalClusterTranslationNeighbors({
    packing,
    requests,
    limitWidth,
    limitHeight,
    routingClearance,
    allowRotate,
  });
  for (const neighbor of terminalClusterTranslations.packings) {
    result.set(packingSignature(neighbor), neighbor);
  }
  traceStage("terminal-cluster-translation");
  const sccClusterTranslations = createSccClusterTranslationNeighbors({
    packing,
    requests,
    limitWidth,
    limitHeight,
    routingClearance,
  });
  for (const neighbor of sccClusterTranslations.packings) {
    result.set(packingSignature(neighbor), neighbor);
  }
  traceStage("scc-cluster-translation");
  if (localOnly) {
    return {
      packings: [...result.values()].sort(compareLocalPacking),
      clusterGenerated: result.size
        + Math.max(0, sccInternalRearrangements.generated
          - sccInternalRearrangements.packings.length)
        + Math.max(0, straightLineCollapses.generated
          - straightLineCollapses.packings.length)
        + Math.max(0, terminalClusterTranslations.generated
          - terminalClusterTranslations.packings.length)
        + Math.max(0, sccClusterTranslations.generated
          - sccClusterTranslations.packings.length),
      clusterCheapRejected: Math.max(
        0,
        sccInternalRearrangements.generated - sccInternalRearrangements.packings.length,
      ) + Math.max(
        0,
        straightLineCollapses.generated - straightLineCollapses.packings.length,
      ) + Math.max(
        0,
        terminalClusterTranslations.generated - terminalClusterTranslations.packings.length,
      ) + Math.max(
        0,
        sccClusterTranslations.generated - sccClusterTranslations.packings.length,
      ),
      globalRebuildGenerated: 0,
      partialRebuildGenerated: 0,
      globalRebuildCpSatElapsedMs: 0,
      objectiveHotspotDeviceIds: [],
    };
  }
  for (const neighbor of createFanoutRelocationNeighbors(
    packing,
    limitWidth,
    limitHeight,
    routingClearance,
    requests,
    requestsById,
    registry,
  )) result.set(packingSignature(neighbor), neighbor);
  traceStage("fanout-relocation");
  for (const neighbor of createStorageFanoutJointNeighbors(
    packing,
    limitWidth,
    limitHeight,
    routingClearance,
    requests,
    requestsById,
    registry,
  )) result.set(packingSignature(neighbor), neighbor);
  traceStage("storage-fanout");
  let clusterGenerated = sccInternalRearrangements.generated
    + straightLineCollapses.generated
    + terminalClusterTranslations.generated
    + sccClusterTranslations.generated;
  let clusterCheapRejected = Math.max(
    0,
    sccInternalRearrangements.generated - sccInternalRearrangements.packings.length,
  ) + Math.max(
    0,
    straightLineCollapses.generated - straightLineCollapses.packings.length,
  ) + Math.max(
    0,
    terminalClusterTranslations.generated - terminalClusterTranslations.packings.length,
  ) + Math.max(
    0,
    sccClusterTranslations.generated - sccClusterTranslations.packings.length,
  );
  let globalRebuildGenerated = 0;
  let partialRebuildGenerated = 0;
  let globalRebuildCpSatElapsedMs = 0;
  let objectiveHotspotDeviceIds: readonly string[] = [];
  const coupledTranslations = createCoupledFlowTranslationNeighbors({
    packing,
    requests,
    registry,
    limitWidth,
    limitHeight,
    routingClearance,
  });
  clusterGenerated += coupledTranslations.generated;
  clusterCheapRejected += coupledTranslations.generated - coupledTranslations.packings.length;
  for (const neighbor of coupledTranslations.packings) {
    result.set(packingSignature(neighbor), neighbor);
  }
  traceStage("coupled-translation");
  const boundaryBacktracks = createBoundaryBacktrackingNeighbors({
    packing,
    limitWidth,
    limitHeight,
    routingClearance,
  });
  clusterGenerated += boundaryBacktracks.generated;
  clusterCheapRejected += boundaryBacktracks.generated - boundaryBacktracks.packings.length;
  for (const neighbor of boundaryBacktracks.packings) {
    result.set(packingSignature(neighbor), neighbor);
  }
  traceStage("boundary-backtrack");
  const slotEjections = createSlotEjectionNeighbors({
    packing,
    routedLogistics,
    limitWidth,
    limitHeight,
    routingClearance,
    allowRotate,
  });
  clusterGenerated += slotEjections.generated;
  clusterCheapRejected += slotEjections.generated - slotEjections.packings.length;
  for (const neighbor of slotEjections.packings) {
    result.set(packingSignature(neighbor), neighbor);
  }
  traceStage("slot-ejection");
  if (cpSat !== null) {
    const clusterRepairs = createCpSatClusterRepairNeighbors({
      packing,
      requests,
      registry,
      limitWidth,
      limitHeight,
      routingClearance,
      allowRotate,
      ...cpSat,
    });
    clusterGenerated += clusterRepairs.generated;
    clusterCheapRejected += clusterRepairs.generated - clusterRepairs.packings.length;
    for (const neighbor of clusterRepairs.packings) {
      result.set(packingSignature(neighbor), neighbor);
    }
    if (cpSat.enableGlobalRebuild) {
      const globalRebuilds = createCpSatGlobalRebuildNeighbors({
        packing,
        requests,
        registry,
        limitWidth,
        limitHeight,
        routingClearance,
        allowRotate,
        maxSeconds: cpSat.maxSeconds,
        candidateCount: cpSat.candidateCount,
        seed: cpSat.seed,
        routedConnections,
        forbiddenLayouts: cpSat.forbiddenLayouts,
        capacityCuts: cpSat.capacityCuts,
      });
      globalRebuildGenerated += globalRebuilds.generated;
      partialRebuildGenerated += globalRebuilds.partialGenerated;
      globalRebuildCpSatElapsedMs += globalRebuilds.elapsedMs;
      objectiveHotspotDeviceIds = globalRebuilds.hotspotDeviceIds;
      clusterGenerated += globalRebuilds.generated;
      clusterCheapRejected += globalRebuilds.generated - globalRebuilds.packings.length;
      for (const neighbor of globalRebuilds.packings) {
        result.set(packingSignature(neighbor), neighbor);
      }
      traceStage("global-rebuild");
    }
  }
  const productionIndexes = packing.devices
    .map((device, index) => device.kind === "production" ? index : -1)
    .filter((index) => index >= 0);
  for (let leftOffset = 0; leftOffset < productionIndexes.length; leftOffset += 1) {
    const leftIndex = productionIndexes[leftOffset]!;
    const left = packing.devices[leftIndex]!;
    const leftRequest = requestsById.get(left.id);
    if (leftRequest === undefined) continue;
    for (let rightOffset = leftOffset + 1; rightOffset < productionIndexes.length; rightOffset += 1) {
      const rightIndex = productionIndexes[rightOffset]!;
      const right = packing.devices[rightIndex]!;
      const rightRequest = requestsById.get(right.id);
      if (
        rightRequest === undefined
        || left.width !== right.width
        || left.height !== right.height
        || !hasBidirectionalMaterialFlow(leftRequest, rightRequest)
      ) continue;
      const leftRotations = new Set<GridRotation>([
        left.rotation,
        ((left.rotation + 180) % 360) as GridRotation,
      ]);
      const rightRotations = new Set<GridRotation>([
        right.rotation,
        ((right.rotation + 180) % 360) as GridRotation,
      ]);
      for (const leftRotation of leftRotations) {
        for (const rightRotation of rightRotations) {
          const devices = packing.devices.map((device, index): HeadlessPlacedDevice => {
            if (index === leftIndex) {
              return { ...device, position: { ...right.position }, rotation: leftRotation };
            }
            if (index === rightIndex) {
              return { ...device, position: { ...left.position }, rotation: rightRotation };
            }
            return device;
          });
          if (
            !hasProductionClearance(devices, 0)
            || measureAcyclicFlowDirectionPenalty(devices, requestsById) > baselineDirectionPenalty
          ) continue;
          const neighbor = createMovedPacking(packing, devices, routingClearance);
          result.set(packingSignature(neighbor), neighbor);
        }
      }
    }
  }
  return {
    packings: [...result.values()].sort(comparePacking),
    clusterGenerated,
    clusterCheapRejected,
    globalRebuildGenerated,
    partialRebuildGenerated,
    globalRebuildCpSatElapsedMs,
    objectiveHotspotDeviceIds,
  };
}

/**
 * Change the shape of a cyclic production neighborhood by moving or rotating
 * one member at a time. The neighborhood includes the strongly connected core
 * and its directly connected production devices, so an asymmetric loop branch
 * can move with respect to the core without hard-coding recipe or device IDs.
 *
 * Cheap ranking combines port feasibility with the neighborhood span. The
 * latter is also a power-coverage proxy: a smaller span gives the downstream
 * diffuser set-cover pass more embedded positions that cover several machines.
 * Every retained candidate still has to pass real routing and power placement.
 */
function createSccInternalRearrangementNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly routedConnections: readonly RoutedConnection[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
}): { readonly packings: readonly PackingResult[]; readonly generated: number } {
  const deviceById = new Map(options.packing.devices.map((device) => [device.id, device]));
  const requestsById = new Map(options.requests.map((request) => [request.id, request]));
  const placeableRequests = options.requests.filter((request) =>
    request.kind === "production" && deviceById.has(request.id));
  const placeableIds = new Set(placeableRequests.map((request) => request.id));
  const logicalEdges = [...new Map(options.routedConnections
    .filter((connection) =>
      connection.sourceDeviceId !== null
      && connection.targetDeviceId !== null
      && placeableIds.has(connection.sourceDeviceId)
      && placeableIds.has(connection.targetDeviceId))
    .map((connection) => {
      const edge = {
        sourceId: connection.sourceDeviceId!,
        targetId: connection.targetDeviceId!,
      };
      return [`${edge.sourceId}->${edge.targetId}`, edge] as const;
    })).values()];
  const cyclicComponents = buildTopologyComponents(
    placeableRequests.map((request) => request.id),
    logicalEdges,
  ).filter((component) => component.deviceIds.length > 1);
  const moveDirections = [
    { name: "left", x: -1, y: 0 },
    { name: "right", x: 1, y: 0 },
    { name: "up", x: 0, y: -1 },
    { name: "down", x: 0, y: 1 },
    { name: "up-left", x: -1, y: -1 },
    { name: "up-right", x: 1, y: -1 },
    { name: "down-left", x: -1, y: 1 },
    { name: "down-right", x: 1, y: 1 },
  ] as const;
  interface ScoredRearrangement {
    readonly packing: PackingResult;
    readonly score: readonly number[];
    readonly movedDeviceId: string;
    readonly movementDistance: number;
  }
  const selected = new Map<string, ScoredRearrangement>();
  const routedCoreTranslations = new Map<string, PackingResult>();
  let generated = 0;

  for (const component of cyclicComponents) {
    const coreIds = new Set(component.deviceIds);
    const neighborhoodIds = new Set(component.deviceIds);
    for (const edge of logicalEdges) {
      if (coreIds.has(edge.sourceId) || coreIds.has(edge.targetId)) {
        neighborhoodIds.add(edge.sourceId);
        neighborhoodIds.add(edge.targetId);
      }
    }
    const neighborhoodDeviceIds = [...neighborhoodIds]
      .filter((id) => deviceById.has(id))
      .sort();
    const externalSuccessorDevices = logicalEdges
      .filter((edge) => coreIds.has(edge.sourceId) && !coreIds.has(edge.targetId))
      .map((edge) => deviceById.get(edge.targetId))
      .filter((device): device is HeadlessPlacedDevice => device !== undefined);
    if (externalSuccessorDevices.length > 0) {
      const coreDevices = component.deviceIds.map((id) => deviceById.get(id)!);
      const coreCenter = {
        x: coreDevices.reduce(
          (sum, device) => sum + device.position.x + device.width / 2,
          0,
        ) / coreDevices.length,
        y: coreDevices.reduce(
          (sum, device) => sum + device.position.y + device.height / 2,
          0,
        ) / coreDevices.length,
      };
      const successorCenter = {
        x: externalSuccessorDevices.reduce(
          (sum, device) => sum + device.position.x + device.width / 2,
          0,
        ) / externalSuccessorDevices.length,
        y: externalSuccessorDevices.reduce(
          (sum, device) => sum + device.position.y + device.height / 2,
          0,
        ) / externalSuccessorDevices.length,
      };
      const deltaX = successorCenter.x - coreCenter.x;
      const deltaY = successorCenter.y - coreCenter.y;
      const direction = Math.abs(deltaY) >= Math.abs(deltaX)
        ? { x: 0, y: Math.sign(deltaY) }
        : { x: Math.sign(deltaX), y: 0 };
      if (direction.x !== 0 || direction.y !== 0) {
        for (let distance = 1; distance <= 8; distance += 1) {
          const devices = translateRigidDeviceCluster({
            devices: options.packing.devices,
            deviceIds: coreIds,
            deltaX: direction.x * distance,
            deltaY: direction.y * distance,
            limitWidth: options.limitWidth,
            limitHeight: options.limitHeight,
          });
          if (devices === null) break;
          generated += 1;
          const moved = createMovedPacking(
            options.packing,
            devices,
            options.routingClearance,
          );
          const candidate: PackingResult = {
            ...moved,
            debugLabel:
              `local-scc-routed-core:toward-successor:${component.deviceIds[0]}:`
              + `${direction.x},${direction.y}:${distance}`,
          };
          routedCoreTranslations.set(packingSignature(candidate), candidate);
        }
      }
    }
    const scored: ScoredRearrangement[] = [];
    const addCandidate = (
      movedDeviceId: string,
      position: { readonly x: number; readonly y: number },
      rotation: GridRotation,
      width: number,
      height: number,
      operation: string,
      movementDistance: number,
      rotationDistance: number,
    ): void => {
      const movedIndex = options.packing.devices.findIndex((device) =>
        device.id === movedDeviceId);
      if (movedIndex < 0) return;
      const devices = options.packing.devices.map((device, index): HeadlessPlacedDevice =>
        index === movedIndex
          ? {
              ...device,
              position: { ...position },
              rotation,
              width,
              height,
            }
          : device);
      const moved = devices[movedIndex]!;
      if (
        moved.position.x < 0
        || moved.position.y < 0
        || moved.position.x + moved.width > options.limitWidth
        || moved.position.y + moved.height > options.limitHeight
        || !hasProductionClearance(devices, 0)
      ) return;
      const physicalDevices = devices.filter((device) => device.kind !== "warehouse-bus");
      const baselineOverflow = measureFrontageOverflowCells(
        options.packing.devices.filter((device) => device.kind !== "warehouse-bus"),
      );
      const frontageOverflow = measureFrontageOverflowCells(physicalDevices);
      if (frontageOverflow > baselineOverflow) return;
      generated += 1;
      const request = requestsById.get(movedDeviceId);
      if (request === undefined) return;
      const flowScore = measureFlowPlacementScore(
        request,
        {
          x: moved.position.x,
          y: moved.position.y,
          width: moved.width,
          height: moved.height,
          rotation: moved.rotation,
        },
        devices.filter((device) => device.id !== movedDeviceId),
        requestsById,
        options.registry,
      );
      const neighborhoodDevices = devices.filter((device) =>
        neighborhoodIds.has(device.id));
      const minimumX = Math.min(...neighborhoodDevices.map((device) => device.position.x));
      const minimumY = Math.min(...neighborhoodDevices.map((device) => device.position.y));
      const maximumX = Math.max(...neighborhoodDevices.map((device) =>
        device.position.x + device.width));
      const maximumY = Math.max(...neighborhoodDevices.map((device) =>
        device.position.y + device.height));
      const neighborhoodWidth = maximumX - minimumX;
      const neighborhoodHeight = maximumY - minimumY;
      const bounds = measureFactoryFootprintBounds(physicalDevices);
      const compactness = measureLayoutCompactness(physicalDevices);
      const packing = createMovedPacking(
        options.packing,
        devices,
        options.routingClearance,
      );
      scored.push({
        packing: {
          ...packing,
          debugLabel:
            `local-scc-internal:unranked:${component.deviceIds[0]}:`
            + `${movedDeviceId}:${coreIds.has(movedDeviceId) ? "core" : "branch"}:`
            + `${movementDistance <= 4 ? "near" : movementDistance <= 6 ? "mid" : "far"}:`
            + operation,
        },
        movedDeviceId,
        movementDistance,
        score: [
          frontageOverflow,
          flowScore[0],
          neighborhoodWidth * neighborhoodHeight,
          Math.max(neighborhoodWidth, neighborhoodHeight),
          neighborhoodWidth + neighborhoodHeight,
          flowScore[1],
          bounds.width * bounds.height,
          measureConvexContourArea(physicalDevices),
          compactness.enclosedVoidCellCount,
          compactness.boundingVoidCellCount,
          movementDistance,
          rotationDistance,
        ],
      });
    };

    for (const movedDeviceId of neighborhoodDeviceIds) {
      const device = deviceById.get(movedDeviceId)!;
      for (const rotationDelta of [90, 180, 270] as const) {
        const rotation = ((device.rotation + rotationDelta) % 360) as GridRotation;
        const swapsFootprint = rotationDelta === 90 || rotationDelta === 270;
        addCandidate(
          movedDeviceId,
          device.position,
          rotation,
          swapsFootprint ? device.height : device.width,
          swapsFootprint ? device.width : device.height,
          `rotate-${rotation}`,
          0,
          Math.min(rotationDelta, 360 - rotationDelta),
        );
      }
      for (const direction of moveDirections) {
        for (let distance = 1; distance <= 8; distance += 1) {
          for (const rotationDelta of [0, 90, 180, 270] as const) {
            const rotation = ((device.rotation + rotationDelta) % 360) as GridRotation;
            const swapsFootprint = rotationDelta === 90 || rotationDelta === 270;
            addCandidate(
              movedDeviceId,
              {
                x: device.position.x + direction.x * distance,
                y: device.position.y + direction.y * distance,
              },
              rotation,
              swapsFootprint ? device.height : device.width,
              swapsFootprint ? device.width : device.height,
              `${direction.name}-${distance}-rotate-${rotation}`,
              distance * (Math.abs(direction.x) + Math.abs(direction.y)),
              Math.min(rotationDelta, 360 - rotationDelta),
            );
          }
        }
      }
    }

    const ordered = scored.sort((left, right) =>
      compareScore(left.score, right.score)
      || left.movedDeviceId.localeCompare(right.movedDeviceId)
      || packingSignature(left.packing).localeCompare(packingSignature(right.packing)));
    const diverse = new Map<string, ScoredRearrangement>();
    for (const candidate of ordered.slice(0, 8)) {
      diverse.set(packingSignature(candidate.packing), candidate);
    }
    for (const movedDeviceId of neighborhoodDeviceIds) {
      for (const distanceBand of ["near", "mid", "far"] as const) {
        const candidate = ordered.find((entry) =>
          entry.movedDeviceId === movedDeviceId
          && (entry.movementDistance <= 4
            ? "near"
            : entry.movementDistance <= 6
              ? "mid"
              : "far") === distanceBand);
        if (candidate !== undefined) {
          diverse.set(packingSignature(candidate.packing), candidate);
        }
      }
    }
    let rank = 0;
    for (const candidate of [...diverse.values()].sort((left, right) =>
      compareScore(left.score, right.score))) {
      rank += 1;
      const ranked: ScoredRearrangement = {
        ...candidate,
        packing: {
          ...candidate.packing,
          debugLabel: candidate.packing.debugLabel?.replace(
            "local-scc-internal:unranked:",
            `local-scc-internal:${rank}:`,
          ),
        },
      };
      selected.set(packingSignature(ranked.packing), ranked);
    }
  }
  const combined = new Map<string, PackingResult>(
    [...routedCoreTranslations.values()].map((packing) => [
      packingSignature(packing),
      packing,
    ]),
  );
  for (const candidate of [...selected.values()]
    .sort((left, right) => compareScore(left.score, right.score))) {
    combined.set(packingSignature(candidate.packing), candidate.packing);
  }
  return {
    packings: [...combined.values()].sort(compareLocalPacking),
    generated,
  };
}

/**
 * Translate each non-trivial strongly connected production component as one
 * rigid local group. Cyclic equipment often forms a physical wall even though
 * moving any one member alone would break its compact internal routing.
 */
function createSccClusterTranslationNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
}): { readonly packings: readonly PackingResult[]; readonly generated: number } {
  const deviceById = new Map(options.packing.devices.map((device) => [device.id, device]));
  const placeableRequests = options.requests.filter((request) =>
    request.kind === "production" && deviceById.has(request.id));
  const logicalEdges = placeableRequests.flatMap((producer) =>
    placeableRequests.flatMap((consumer) =>
      producer.id !== consumer.id
      && [...producer.outputs.keys()].some((itemId) => consumer.inputs.has(itemId))
        ? [{ sourceId: producer.id, targetId: consumer.id }]
        : []));
  const cyclicComponents = buildTopologyComponents(
    placeableRequests.map((request) => request.id),
    logicalEdges,
  ).filter((component) => component.deviceIds.length > 1);
  const directions = [
    { name: "left", x: -1, y: 0 },
    { name: "right", x: 1, y: 0 },
    { name: "up", x: 0, y: -1 },
    { name: "down", x: 0, y: 1 },
  ] as const;
  const selected = new Map<string, PackingResult>();
  let generated = 0;
  for (const component of cyclicComponents) {
    const movedIds = new Set(component.deviceIds);
    const componentDevices = component.deviceIds.map((id) => deviceById.get(id)!);
    const minimumX = Math.min(...componentDevices.map((device) => device.position.x));
    const minimumY = Math.min(...componentDevices.map((device) => device.position.y));
    const maximumX = Math.max(...componentDevices.map((device) =>
      device.position.x + device.width));
    const maximumY = Math.max(...componentDevices.map((device) =>
      device.position.y + device.height));
    for (const direction of directions) {
      const legalMoves: PackingResult[] = [];
      const portClearanceLimit = direction.x < 0
        ? minimumX - options.routingClearance
        : direction.x > 0
          ? options.limitWidth - maximumX - options.routingClearance
          : direction.y < 0
            ? minimumY - options.routingClearance
            : options.limitHeight - maximumY - options.routingClearance;
      const maximumDistance = Math.max(0, Math.min(6, portClearanceLimit));
      for (let distance = 1; distance <= maximumDistance; distance += 1) {
        const devices = translateRigidDeviceCluster({
          devices: options.packing.devices,
          deviceIds: movedIds,
          deltaX: direction.x * distance,
          deltaY: direction.y * distance,
          limitWidth: options.limitWidth,
          limitHeight: options.limitHeight,
        });
        if (devices === null) break;
        generated += 1;
        const moved = createMovedPacking(options.packing, devices, options.routingClearance);
        legalMoves.push({
          ...moved,
          debugLabel:
            `local-scc-cluster:${direction.name}:${component.deviceIds[0]}:${distance}`,
        });
      }
      const ordered = [...legalMoves].sort(compareLocalPacking);
      for (const candidate of [
        ...ordered.slice(0, 2),
        legalMoves[0],
        legalMoves.at(-1),
      ]) {
        if (candidate === undefined) continue;
        selected.set(packingSignature(candidate), candidate);
      }
      if (direction.name === "left") {
        // Keep both deep-left translations in the small refinement beam. The
        // farthest move maximizes the new right-hand corridor, while the
        // penultimate move leaves one extra boundary cell for west-facing
        // component ports. Either can be the routable hard-frontage state.
        for (const [rank, corridorCandidate] of legalMoves.slice(-2).entries()) {
          selected.set(packingSignature(corridorCandidate), {
            ...corridorCandidate,
            debugLabel:
              `local-scc-cluster:frontage-corridor:${component.deviceIds[0]}:`
              + `${legalMoves.length - 1 + rank}`,
          });
        }
      }
    }
  }
  return {
    packings: [...selected.values()].sort(compareLocalPacking),
    generated,
  };
}

/**
 * Move a terminal and all of its direct producers as one rigid local cluster.
 * This preserves their relative arrangement while allowing a complete terminal
 * row/column to fill an empty strip that no sequence of individually improving
 * moves can cross.
 */
function createTerminalClusterTranslationNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
  readonly allowRotate: boolean;
}): { readonly packings: readonly PackingResult[]; readonly generated: number } {
  const deviceById = new Map(options.packing.devices.map((device) => [device.id, device]));
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const placeableRequests = options.requests.filter((request) =>
    (request.kind === "production" || request.kind === "storage")
    && deviceById.has(request.id));
  const directions = [
    { x: 0, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ] as const;
  const selected = new Map<string, PackingResult>();
  let generated = 0;

  const clusters = discoverFlowClusters(placeableRequests.map((request): FlowClusterNode => ({
    id: request.id,
    kind: request.kind,
    directProducerIds: request.warehouseProducerIds,
    inputItemIds: [...request.inputs.keys()],
    outputItemIds: [...request.outputs.keys()],
  })));
  for (const cluster of clusters) {
    const movedIds = new Set([cluster.terminalId, ...cluster.directProducerIds]);
    if ([...movedIds].some((id) => !deviceById.has(id))) continue;
    const terminalDevice = deviceById.get(cluster.terminalId)!;
    const terminalRequest = requestById.get(cluster.terminalId);
    const producerDevices = cluster.directProducerIds
      .map((id) => deviceById.get(id))
      .filter((device): device is HeadlessPlacedDevice => device !== undefined);
    if (terminalRequest?.kind === "storage" && producerDevices.length > 0) {
      const producerMinimumX = Math.min(...producerDevices.map((device) => device.position.x));
      const producerMaximumX = Math.max(...producerDevices.map(
        (device) => device.position.x + device.width,
      ));
      const producerMinimumY = Math.min(...producerDevices.map((device) => device.position.y));
      const producerMaximumY = Math.max(...producerDevices.map(
        (device) => device.position.y + device.height,
      ));
      for (const side of ["left", "right"] as const) {
        const desiredInputEdge: GridEdge = side === "right" ? "WEST" : "EAST";
        const rotation = options.allowRotate
          ? resolvePortFacingRotation(terminalRequest, "input", desiredInputEdge)
          : resolvePortEdge(terminalRequest, "input", terminalDevice.rotation) === desiredInputEdge
            ? terminalDevice.rotation
            : null;
        if (rotation === null) continue;
        const swaps = (rotation - terminalDevice.rotation + 360) % 180 !== 0;
        const width = swaps ? terminalDevice.height : terminalDevice.width;
        const height = swaps ? terminalDevice.width : terminalDevice.height;
        // Three terminal inputs need independent approach cells. A one-column
        // slit beside the producer bank makes all inputs share the same vertical
        // lane, so retain a three-column fan-in pocket while staying inside the
        // established frontage.
        const sidecarCorridorWidth = 3;
        const sideX = side === "right"
          ? producerMaximumX + sidecarCorridorWidth
          : producerMinimumX - width - sidecarCorridorWidth;
        const yCandidates = [
          { alignment: "below", y: producerMaximumY },
          { alignment: "top", y: producerMinimumY },
          {
            alignment: "middle",
            y: Math.floor((producerMinimumY + producerMaximumY - height) / 2),
          },
          { alignment: "bottom", y: producerMaximumY - height },
        ].filter((candidate, index, candidates) =>
          candidates.findIndex((other) => other.y === candidate.y) === index);
        for (const { alignment, y } of yCandidates) {
          const x = alignment === "below"
            ? side === "right" ? producerMaximumX - width : producerMinimumX
            : sideX;
          const sidecar: HeadlessPlacedDevice = {
            ...terminalDevice,
            position: { x, y },
            rotation,
            width,
            height,
          };
          if (x < 0 || y < 0
            || x + width > options.limitWidth
            || y + height > options.limitHeight) continue;
          const devices = options.packing.devices.map((device) =>
            device.id === sidecar.id ? sidecar : device);
          if (!hasProductionClearance(devices, 0)) continue;
          generated += 1;
          const moved = createMovedPacking(options.packing, devices, options.routingClearance);
          const candidate: PackingResult = {
            ...moved,
            debugLabel:
              `local-terminal-cluster:storage-sidecar:${cluster.terminalId}:`
              + `${side}:${alignment}:${y}`,
          };
          selected.set(packingSignature(candidate), candidate);
        }
      }
    }
    for (const direction of directions) {
      const legalMoves: PackingResult[] = [];
      // Keep one local move small enough to preserve a routable corridor.
      // Further compression is reached through repeated routed refinement
      // rounds, not by jumping straight to the first geometric collision.
      const maximumDistance = Math.min(
        4,
        direction.x === 0 ? options.limitHeight : options.limitWidth,
      );
      for (let distance = 1; distance <= maximumDistance; distance += 1) {
        const devices = translateRigidDeviceCluster({
          devices: options.packing.devices,
          deviceIds: movedIds,
          deltaX: direction.x * distance,
          deltaY: direction.y * distance,
          limitWidth: options.limitWidth,
          limitHeight: options.limitHeight,
        });
        if (devices === null) break;
        generated += 1;
        const moved = createMovedPacking(options.packing, devices, options.routingClearance);
        legalMoves.push({
          ...moved,
          debugLabel:
            `local-terminal-cluster:translate:${cluster.terminalId}:`
            + `${direction.x},${direction.y}:${distance}`,
        });
      }
      const ordered = [...legalMoves].sort(compareLocalPacking);
      for (const candidate of [
        ...ordered.slice(0, 2),
        legalMoves[0],
        legalMoves.at(-1),
      ]) {
        if (candidate === undefined) continue;
        selected.set(packingSignature(candidate), candidate);
      }
    }
    const terminalDevices = options.packing.devices.filter((device) => movedIds.has(device.id));
    const terminalMinimumY = Math.min(...terminalDevices.map((device) => device.position.y));
    for (let distance = 1; distance <= 4; distance += 1) {
      const nextTerminalMinimumY = terminalMinimumY - distance;
      // Leave one row for the terminal input frontage and one row from which
      // upstream paths can approach it. Only edge devices that physically
      // intrude into that corridor move; unrelated upstream layers stay fixed.
      const maximumBlockerBottom = nextTerminalMinimumY - 2;
      const blockerShiftById = new Map(options.packing.devices
        .filter((device) =>
          device.kind === "production"
          && !movedIds.has(device.id)
          && device.position.y < terminalMinimumY
          && device.position.y + device.height > maximumBlockerBottom
          && terminalDevices.some((terminalDevice) =>
            device.position.x < terminalDevice.position.x + terminalDevice.width
            && device.position.x + device.width > terminalDevice.position.x))
        .map((device) => [
          device.id,
          device.position.y + device.height - maximumBlockerBottom,
        ] as const));
      const geometricBlockerIds = new Set(blockerShiftById.keys());
      const rigidBlockerShift = Math.max(0, ...blockerShiftById.values());
      if (rigidBlockerShift > 0) {
        for (const device of options.packing.devices) {
          if (movedIds.has(device.id) || geometricBlockerIds.has(device.id)) continue;
          if (device.kind !== "production"
            || device.position.y + device.height < maximumBlockerBottom - 4) continue;
          const request = requestById.get(device.id);
          if (request === undefined) continue;
          const directlyConnected = [...geometricBlockerIds].some((blockerId) => {
            const blockerRequest = requestById.get(blockerId);
            return blockerRequest !== undefined
              && (
                [...request.outputs.keys()].some((itemId) => blockerRequest.inputs.has(itemId))
                || [...blockerRequest.outputs.keys()].some((itemId) => request.inputs.has(itemId))
              );
          });
          if (directlyConnected) blockerShiftById.set(device.id, rigidBlockerShift);
        }
        for (const blockerId of geometricBlockerIds) {
          blockerShiftById.set(blockerId, rigidBlockerShift);
        }
      }
      const horizontalOffsets = rigidBlockerShift > 0 ? [-1, 0, 1] : [0];
      for (const horizontalOffset of horizontalOffsets) {
        const devices = options.packing.devices.map((device): HeadlessPlacedDevice => {
          if (movedIds.has(device.id)) {
            return {
              ...device,
              position: { x: device.position.x, y: device.position.y - distance },
            };
          }
          const blockerShift = blockerShiftById.get(device.id) ?? 0;
          return blockerShift === 0
            ? device
            : {
                ...device,
                position: {
                  x: device.position.x + horizontalOffset,
                  y: device.position.y - blockerShift,
                },
              };
        });
        if (devices.some((device) =>
          device.position.x < 0
          || device.position.y < 0
          || device.position.x + device.width > options.limitWidth
          || device.position.y + device.height > options.limitHeight)
          || !hasProductionClearance(devices, 0)) continue;
        generated += 1;
        const moved = createMovedPacking(options.packing, devices, options.routingClearance);
        const candidate: PackingResult = {
          ...moved,
          debugLabel:
            `local-terminal-cluster:height-corridor:${cluster.terminalId}:`
            + `${horizontalOffset}:${distance}`,
        };
        selected.set(packingSignature(candidate), candidate);
      }
    }
  }
  return {
    packings: [...selected.values()].sort(compareLocalPacking),
    generated,
  };
}

/** Apply one collision-checked rigid translation without changing group shape. */
export function translateRigidDeviceCluster(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly deviceIds: ReadonlySet<string>;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly limitWidth: number;
  readonly limitHeight: number;
}): readonly HeadlessPlacedDevice[] | null {
  const translated = options.devices.map((device): HeadlessPlacedDevice =>
    options.deviceIds.has(device.id)
      ? {
          ...device,
          position: {
            x: device.position.x + options.deltaX,
            y: device.position.y + options.deltaY,
          },
        }
      : device);
  const outsideLimit = translated.some((device) =>
    options.deviceIds.has(device.id)
    && (
      device.position.x < 0
      || device.position.y < 0
      || device.position.x + device.width > options.limitWidth
      || device.position.y + device.height > options.limitHeight
    ));
  return outsideLimit || !hasProductionClearance(translated, 0) ? null : translated;
}

/** Keep operation-family diversity while bounding expensive routed refinement. */
function selectRefinementNeighborBeam(
  packings: readonly PackingResult[],
  maximum: number,
): PackingResult[] {
  const frontageCorridorCandidates = packings
    .filter((candidate) => candidate.debugLabel?.startsWith(
      "local-scc-cluster:frontage-corridor:",
    ))
    .sort((left, right) => {
      const leftDistance = Number(left.debugLabel?.split(":").at(-1) ?? 0);
      const rightDistance = Number(right.debugLabel?.split(":").at(-1) ?? 0);
      // Try the penultimate left translation before the boundary-hugging
      // farthest translation, but reserve the beam for both.
      return leftDistance - rightDistance || compareLocalPacking(left, right);
    });
  const selected = new Map<string, PackingResult>();
  for (const candidate of frontageCorridorCandidates.slice(0, 2)) {
    selected.set(packingSignature(candidate), candidate);
    if (selected.size >= maximum) return [...selected.values()];
  }
  const straightLineCollapseCandidates = packings
    .filter((candidate) =>
      candidate.debugLabel?.startsWith(
        "local-terminal-cluster:straight-row-collapse:",
      ) === true
      || candidate.debugLabel?.startsWith(
        "local-terminal-cluster:straight-column-collapse:",
      ) === true)
    .sort(compareLocalPacking);
  for (const candidate of straightLineCollapseCandidates.slice(0, 1)) {
    selected.set(packingSignature(candidate), candidate);
    if (selected.size >= maximum) return [...selected.values()];
  }
  const storageSidecarCandidates = packings
    .filter((candidate) => candidate.debugLabel?.startsWith(
      "local-terminal-cluster:storage-sidecar:",
    ))
    .sort((left, right) =>
      Number(right.debugLabel?.includes(":below:") === true)
      - Number(left.debugLabel?.includes(":below:") === true)
      || Number(right.debugLabel?.includes(":right:") === true)
      - Number(left.debugLabel?.includes(":right:") === true)
      || compareLocalPacking(left, right));
  for (const candidate of storageSidecarCandidates.slice(0, 1)) {
    selected.set(packingSignature(candidate), candidate);
    if (selected.size >= maximum) return [...selected.values()];
  }
  const sccInternalCandidates = packings
    .filter((candidate) => candidate.debugLabel?.startsWith("local-scc-internal:"))
    .sort((left, right) =>
      Number(left.debugLabel?.split(":")[1] ?? Number.MAX_SAFE_INTEGER)
      - Number(right.debugLabel?.split(":")[1] ?? Number.MAX_SAFE_INTEGER));
  const representedSccMemberBands = new Set<string>();
  // Reserve both a near and a far genuinely upstream cluster move before
  // terminal compression consumes the beam. A near move can unlock a cleaner
  // monotone route without overshooting its successor; a far move tests the
  // strongest row-elimination opportunity. Keeping both is the layout
  // equivalent of trying two Tetris drops instead of committing to one.
  const routedCoreCompressionCandidates = packings
    .filter((candidate) => candidate.debugLabel?.startsWith("local-scc-routed-core:"))
    .sort((left, right) =>
      Number(right.debugLabel?.split(":").at(-1) ?? 0)
      - Number(left.debugLabel?.split(":").at(-1) ?? 0)
      || compareLocalPacking(left, right));
  const inferredSccClusterCandidates = packings
    .filter((candidate) => candidate.debugLabel?.startsWith("local-scc-cluster:down:"))
    .sort((left, right) =>
      Number(right.debugLabel?.split(":").at(-1) ?? 0)
      - Number(left.debugLabel?.split(":").at(-1) ?? 0)
      || compareLocalPacking(left, right));
  const routedCoreExtremes = [
    routedCoreCompressionCandidates[0],
    routedCoreCompressionCandidates.at(-1),
  ].filter((candidate, index, candidates): candidate is PackingResult =>
    candidate !== undefined && candidates.indexOf(candidate) === index);
  const fallbackUpstreamCandidate = inferredSccClusterCandidates[0]
    ?? sccInternalCandidates.find((candidate) =>
      candidate.debugLabel?.split(":")[5] === "near"
      && candidate.debugLabel?.split(":")[6]?.startsWith("up-1-") === true)
    ?? sccInternalCandidates[0];
  const upstreamCandidates = routedCoreExtremes.length > 0
    ? routedCoreExtremes
    : fallbackUpstreamCandidate === undefined
      ? []
      : [fallbackUpstreamCandidate];
  for (const upstreamCandidate of upstreamCandidates) {
    const movedDeviceId = upstreamCandidate.debugLabel?.split(":")[3];
    const distanceBand = upstreamCandidate.debugLabel?.split(":")[5];
    if (movedDeviceId !== undefined && distanceBand !== undefined) {
      representedSccMemberBands.add(`${movedDeviceId}:${distanceBand}`);
    }
    selected.set(packingSignature(upstreamCandidate), upstreamCandidate);
    if (selected.size >= maximum) return [...selected.values()];
  }
  const terminalHeightCandidatesByDistance = new Map<number, PackingResult[]>();
  for (const candidate of packings
    .filter((candidate) =>
      (candidate.debugLabel?.startsWith("local-terminal-cluster:translate:") === true
        && candidate.debugLabel.includes(":0,-1:"))
      || candidate.debugLabel?.startsWith(
        "local-terminal-cluster:height-corridor:",
      ) === true)
    .sort((left, right) => {
      const corridorPreference =
        Number(right.debugLabel?.startsWith("local-terminal-cluster:height-corridor:") === true)
        - Number(left.debugLabel?.startsWith("local-terminal-cluster:height-corridor:") === true);
      if (corridorPreference !== 0) return corridorPreference;
      const leftOffset = left.debugLabel?.startsWith(
        "local-terminal-cluster:height-corridor:",
      ) === true
        ? Number(left.debugLabel.split(":").at(-2) ?? 0)
        : 0;
      const rightOffset = right.debugLabel?.startsWith(
        "local-terminal-cluster:height-corridor:",
      ) === true
        ? Number(right.debugLabel.split(":").at(-2) ?? 0)
        : 0;
      const alignmentPreference = Math.abs(leftOffset) - Math.abs(rightOffset);
      if (alignmentPreference !== 0) return alignmentPreference;
      return compareLocalPacking(left, right);
    })) {
    const distance = Number(candidate.debugLabel?.split(":").at(-1) ?? 0);
    const candidates = terminalHeightCandidatesByDistance.get(distance) ?? [];
    if (candidates.length < 1) candidates.push(candidate);
    terminalHeightCandidatesByDistance.set(distance, candidates);
  }
  const terminalHeightDistances = [...terminalHeightCandidatesByDistance.keys()]
    .sort((left, right) => right - left);
  const terminalHeightDistancePriority = [
    terminalHeightDistances[0],
    terminalHeightDistances.at(-1),
    ...terminalHeightDistances.slice(1, -1),
  ].filter((distance, index, distances): distance is number =>
    distance !== undefined && distances.indexOf(distance) === index);
  const terminalHeightCompressionCandidates = terminalHeightDistancePriority
    .slice(0, 4)
    .flatMap((distance) => terminalHeightCandidatesByDistance.get(distance) ?? []);
  // Height is decided by the bottom terminal cluster in layered layouts.
  // Reserve the deepest moves plus shallower fallbacks before cyclic shape
  // candidates consume the small per-base beam. Keeping the blocker group in
  // its existing columns preserves established fan-in lanes; a later global
  // neighborhood can still explore staggered horizontal arrangements.
  for (const candidate of terminalHeightCompressionCandidates.slice(0, 4)) {
    selected.set(packingSignature(candidate), candidate);
    if (selected.size >= maximum) return [...selected.values()];
  }
  for (const requestedBand of ["near", "mid", "far"] as const) {
    if (selected.size >= maximum) break;
    for (const candidate of sccInternalCandidates) {
      const movedDeviceId = candidate.debugLabel?.split(":")[3];
      const distanceBand = candidate.debugLabel?.split(":")[5];
      if (movedDeviceId === undefined || distanceBand === undefined) continue;
      if (distanceBand !== requestedBand) continue;
      const memberBand = `${movedDeviceId}:${distanceBand}`;
      if (representedSccMemberBands.has(memberBand)) continue;
      representedSccMemberBands.add(memberBand);
      selected.set(packingSignature(candidate), candidate);
      if (representedSccMemberBands.size >= 9 || selected.size >= maximum) break;
    }
  }
  const families = [
    // Always spend refinement capacity on true local compaction first. Global
    // rebuild is generated only in later rounds and remains a fallback family.
    "local-scc-cluster:",
    "local-terminal-cluster:",
    "local-storage:",
    "local-production:",
    "local-fanout:",
    // A small candidate beam must still reserve one slot for a coupled local
    // repair; multi-input clusters cannot improve through one-device moves alone.
    "cluster-repair:",
    "joint-storage-fanout:",
    "cluster-translate:",
    "slot-ejection:",
    "boundary-backtrack:",
    "global-rebuild:partial:",
    "global-rebuild:full:",
  ] as const;
  const candidatesByFamily = families.map((family) =>
    packings.filter((candidate) =>
      candidate.debugLabel?.startsWith(family)
      && !candidate.debugLabel.startsWith("local-scc-cluster:frontage-corridor:")));
  for (let familyRank = 0; familyRank < 2 && selected.size < maximum; familyRank += 1) {
    for (const familyCandidates of candidatesByFamily) {
      const packing = familyCandidates[familyRank];
      if (packing === undefined) continue;
      selected.set(packingSignature(packing), packing);
      if (selected.size >= maximum) break;
    }
  }
  for (const packing of packings) {
    if (selected.size >= maximum) break;
    selected.set(packingSignature(packing), packing);
  }
  return [...selected.values()].sort(comparePacking);
}

/**
 * Bound all initial packing candidates before full routing without losing the
 * deterministic baseline or cheap-search family diversity.
 */
function selectInitialPackingCandidateBeam(
  baseline: PackingResult,
  families: readonly (readonly PackingResult[])[],
  maximum: number,
): PackingResult[] {
  const selected = new Map<string, PackingResult>();
  selected.set(packingSignature(baseline), baseline);
  const cursors = families.map(() => 0);
  while (selected.size < maximum) {
    let added = false;
    for (const [familyIndex, family] of families.entries()) {
      let cursor = cursors[familyIndex] ?? 0;
      while (cursor < family.length) {
        const packing = family[cursor]!;
        cursor += 1;
        cursors[familyIndex] = cursor;
        const signature = packingSignature(packing);
        if (selected.has(signature)) continue;
        selected.set(signature, packing);
        added = true;
        break;
      }
      if (selected.size >= maximum) break;
    }
    if (!added) break;
  }
  return [...selected.values()];
}

/** Select deterministic route variants without repeating the fast path or exceeding a recovery allowance. */
export function selectUnattemptedRoutingVariants(
  candidates: readonly number[],
  previouslyAttempted: ReadonlySet<number>,
  maximumAdditional?: number,
): number[] {
  const unattempted = candidates.filter((candidate) => !previouslyAttempted.has(candidate));
  return maximumAdditional === undefined
    ? unattempted
    : unattempted.slice(0, Math.max(0, Math.trunc(maximumAdditional)));
}

/**
 * Retry a cold route with failure-directed priority promotion.
 *
 * A preservation pass may already have attempted the exact same route after
 * ripping every connection. Cached deterministic failures advance the priority
 * state without invoking A* again; uncached states retain the original search
 * order and bounded failure behavior.
 */
export function routeWithFailureDirectedPriorities<T>(options: {
  readonly maximumPriorities: number;
  readonly cachedFailuresByPriorityOrder?: ReadonlyMap<string, unknown>;
  readonly tryRoute: (priorityConnectionKeys: readonly string[]) => T;
  readonly failureKey: (error: unknown) => string | null;
  readonly onRoutingAttempt?: () => void;
  readonly onCachedFailureReuse?: () => void;
}): T {
  const maximumPriorities = Math.max(0, Math.trunc(options.maximumPriorities));
  const failurePriorities: string[] = [];
  while (true) {
    const priorityOrder = failurePriorities.join("\u0001");
    let failure: unknown;
    if (options.cachedFailuresByPriorityOrder?.has(priorityOrder) === true) {
      options.onCachedFailureReuse?.();
      failure = options.cachedFailuresByPriorityOrder.get(priorityOrder);
    } else {
      options.onRoutingAttempt?.();
      try {
        return options.tryRoute(failurePriorities);
      } catch (error) {
        failure = error;
      }
    }
    const failureKey = options.failureKey(failure);
    if (failureKey === null
      || failurePriorities.length >= maximumPriorities
      || failurePriorities.includes(failureKey)) {
      throw failure;
    }
    failurePriorities.unshift(failureKey);
  }
}

/**
 * Order a connection whose two outside port cells already coincide before any
 * connection that still needs corridor cells.
 */
export function compareZeroLengthRoutePriority(
  leftDistance: number,
  rightDistance: number,
): number {
  return Number(leftDistance !== 0) - Number(rightDistance !== 0);
}

export interface DetectSlotsOptions {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly logisticsDevices?: readonly HeadlessPlacedDevice[];
  readonly targetDeviceId: string;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate?: boolean;
  readonly relatedDeviceIds?: ReadonlySet<string>;
  readonly maxPotentialBlockers?: number;
}

/** Enumerate target-sized insertion rectangles on the current routed layout. */
export function detectSlots(options: DetectSlotsOptions): Slot[] {
  const target = options.devices.find((device) => device.id === options.targetDeviceId);
  if (target === undefined) return [];
  const otherDevices = options.devices.filter((device) => device.id !== target.id);
  const logistics = options.logisticsDevices ?? [];
  const maxPotentialBlockers = options.maxPotentialBlockers ?? 2;
  const rotations = options.allowRotate === false
    ? [target.rotation]
    : ([0, 90, 180, 270] as const);
  const uniqueOrientations = new Map<string, {
    readonly rotation: GridRotation;
    readonly width: number;
    readonly height: number;
  }>();
  for (const rotation of rotations) {
    const swaps = (rotation - target.rotation + 360) % 180 !== 0;
    const width = swaps ? target.height : target.width;
    const height = swaps ? target.width : target.height;
    const key = `${width}x${height}@${rotation}`;
    uniqueOrientations.set(key, { rotation, width, height });
  }
  const originalBounds = measureBounds(options.devices);
  const related = otherDevices.filter((device) => options.relatedDeviceIds?.has(device.id));
  const slots: Slot[] = [];
  for (const orientation of uniqueOrientations.values()) {
    for (let y = 0; y + orientation.height <= options.limitHeight; y += 1) {
      for (let x = 0; x + orientation.width <= options.limitWidth; x += 1) {
        const rectangle: HeadlessPlacedDevice = {
          ...target,
          position: { x, y },
          rotation: orientation.rotation,
          width: orientation.width,
          height: orientation.height,
        };
        const blockers = otherDevices.filter((device) => rectanglesOverlap(rectangle, device));
        if (blockers.length > maxPotentialBlockers) continue;
        const occupiedLogistics = logistics.filter((device) => rectanglesOverlap(rectangle, device));
        const kind: Slot["kind"] = blockers.length > 0
          ? "potential"
          : occupiedLogistics.length > 0 ? "logistics-occupied" : "empty";
        const occupied = otherDevices.filter((device) => !blockers.some((blocker) => blocker.id === device.id));
        let portAccessibility = 0;
        for (let edgeX = x; edgeX < x + orientation.width; edgeX += 1) {
          for (const edgeY of [y - 1, y + orientation.height]) {
            if (edgeY >= 0 && edgeY < options.limitHeight
              && !occupied.some((device) => pointInsideDevice(edgeX, edgeY, device))) portAccessibility += 1;
          }
        }
        for (let edgeY = y; edgeY < y + orientation.height; edgeY += 1) {
          for (const edgeX of [x - 1, x + orientation.width]) {
            if (edgeX >= 0 && edgeX < options.limitWidth
              && !occupied.some((device) => pointInsideDevice(edgeX, edgeY, device))) portAccessibility += 1;
          }
        }
        const candidateDevices = options.devices.map((device) => device.id === target.id ? rectangle : device);
        const candidateBounds = measureBounds(candidateDevices);
        const proximity = related.length === 0 ? 0 : related.reduce((sum, device) => {
          const targetCenter = deviceCenter(rectangle);
          const relatedCenter = deviceCenter(device);
          return sum + Math.abs(targetCenter.x - relatedCenter.x) + Math.abs(targetCenter.y - relatedCenter.y);
        }, 0);
        slots.push({
          id: `${target.id}:${x},${y},${orientation.rotation}`,
          kind,
          position: { x, y },
          width: orientation.width,
          height: orientation.height,
          rotation: orientation.rotation,
          blockingDeviceIds: blockers.map((device) => device.id).sort(),
          occupiedLogisticsIds: occupiedLogistics.map((device) => device.id).sort(),
          score: {
            fitWaste: 0,
            portAccessibility,
            proximity,
            boundaryReductionPotential:
              originalBounds.width * originalBounds.height - candidateBounds.width * candidateBounds.height,
            clearanceCost: occupiedLogistics.length + blockers.length * 4,
          },
        });
      }
    }
  }
  return slots.sort(compareSlots);
}

function pointInsideDevice(x: number, y: number, device: HeadlessPlacedDevice): boolean {
  return x >= device.position.x && x < device.position.x + device.width
    && y >= device.position.y && y < device.position.y + device.height;
}

function compareSlots(left: Slot, right: Slot): number {
  return right.score.boundaryReductionPotential - left.score.boundaryReductionPotential
    || left.score.clearanceCost - right.score.clearanceCost
    || right.score.portAccessibility - left.score.portAccessibility
    || left.score.proximity - right.score.proximity
    || left.position.y - right.position.y
    || left.position.x - right.position.x
    || left.rotation - right.rotation;
}

export interface EjectionChainSearchResult {
  readonly layouts: readonly (readonly HeadlessPlacedDevice[])[];
  readonly exploredStates: number;
  readonly generatedStates: number;
  readonly stoppedBy: "exhausted" | "max-states" | "time-budget";
}

interface EjectionState {
  readonly devices: ReadonlyMap<string, HeadlessPlacedDevice>;
  readonly pendingIds: readonly string[];
  readonly lockedIds: ReadonlySet<string>;
  readonly movedIds: ReadonlySet<string>;
  readonly vacatedPoses: readonly HeadlessPlacedDevice[];
  readonly depth: number;
  readonly trace: readonly string[];
}

/** Bounded beam search that may translate, rotate, insert, or swap displaced equipment. */
export function searchEjectionChains(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly logisticsDevices?: readonly HeadlessPlacedDevice[];
  readonly rootDeviceId: string;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate?: boolean;
  readonly slots?: readonly Slot[];
  readonly config: EjectionChainConfig;
}): EjectionChainSearchResult {
  const root = options.devices.find((device) => device.id === options.rootDeviceId);
  if (root === undefined || !isEjectionMovable(root)) {
    return { layouts: [], exploredStates: 0, generatedStates: 0, stoppedBy: "exhausted" };
  }
  const slots = options.slots ?? detectSlots({
    ...options,
    targetDeviceId: root.id,
    maxPotentialBlockers: options.config.maxPotentialBlockers,
  });
  // Slot enumeration is deterministic preprocessing; the wall-clock budget
  // bounds only the combinatorial chain expansion below.
  const startedAt = Date.now();
  const initialStates: EjectionState[] = [];
  for (const slot of slots) {
    if (slot.position.x === root.position.x && slot.position.y === root.position.y
      && slot.rotation === root.rotation) continue;
    const blockers = slot.blockingDeviceIds
      .map((id) => options.devices.find((device) => device.id === id))
      .filter((device): device is HeadlessPlacedDevice => device !== undefined);
    if (blockers.some((device) => !isEjectionMovable(device))) continue;
    const movedRoot: HeadlessPlacedDevice = {
      ...root,
      position: { ...slot.position },
      rotation: slot.rotation,
      width: slot.width,
      height: slot.height,
    };
    const devices = new Map(options.devices.map((device) => [device.id, device]));
    devices.set(root.id, movedRoot);
    initialStates.push({
      devices,
      pendingIds: blockers.map((device) => device.id).sort(),
      lockedIds: new Set([root.id]),
      movedIds: new Set([root.id]),
      vacatedPoses: [root],
      depth: 1,
      trace: [`insert:${root.id}:${slot.id}`],
    });
    if (initialStates.length >= options.config.beamWidth * 2) break;
  }

  let frontier = initialStates.sort(compareEjectionStates).slice(0, options.config.beamWidth);
  const visited = new Set<string>();
  const completed = new Map<string, readonly HeadlessPlacedDevice[]>();
  const continuationSlotsByDeviceId = new Map<string, readonly Slot[]>();
  let exploredStates = 0;
  let generatedStates = initialStates.length;
  let stoppedBy: EjectionChainSearchResult["stoppedBy"] = "exhausted";
  while (frontier.length > 0) {
    if (Date.now() - startedAt >= options.config.timeBudgetMs) {
      stoppedBy = "time-budget";
      break;
    }
    const next: EjectionState[] = [];
    for (const state of frontier) {
      if (exploredStates >= options.config.maxStates) {
        stoppedBy = "max-states";
        break;
      }
      const signature = ejectionStateSignature(state);
      if (visited.has(signature)) continue;
      visited.add(signature);
      exploredStates += 1;
      if (state.pendingIds.length === 0) {
        const devices = options.devices.map((device) => state.devices.get(device.id)!);
        if (hasProductionClearance(devices, 0)) completed.set(packingDevicesSignature(devices), devices);
        continue;
      }
      if (state.depth >= options.config.maxDepth) continue;
      const deviceId = state.pendingIds[0]!;
      const device = state.devices.get(deviceId)!;
      let continuationSlots = continuationSlotsByDeviceId.get(deviceId);
      if (continuationSlots === undefined) {
        continuationSlots = detectSlots({
          devices: options.devices,
          targetDeviceId: device.id,
          limitWidth: options.limitWidth,
          limitHeight: options.limitHeight,
          allowRotate: options.allowRotate,
          maxPotentialBlockers: 1,
        }).slice(0, Math.max(2, options.config.beamWidth));
        continuationSlotsByDeviceId.set(deviceId, continuationSlots);
      }
      for (const pose of createEjectionPoses(device, state, options, continuationSlots)) {
        const conflicts = [...state.devices.values()]
          .filter((other) => other.id !== device.id && rectanglesOverlap(pose, other));
        if (conflicts.some((other) => !isEjectionMovable(other) || state.lockedIds.has(other.id))) continue;
        const devices = new Map(state.devices);
        devices.set(device.id, pose);
        const pendingIds = [...new Set([
          ...state.pendingIds.slice(1),
          ...conflicts.map((other) => other.id),
        ])].sort();
        const operation = pose.position.x === device.position.x && pose.position.y === device.position.y
          ? "rotate"
          : state.vacatedPoses.some((vacated) => vacated.position.x === pose.position.x
              && vacated.position.y === pose.position.y) ? "swap" : "translate";
        next.push({
          devices,
          pendingIds,
          lockedIds: new Set(state.lockedIds).add(device.id),
          movedIds: new Set(state.movedIds).add(device.id),
          vacatedPoses: [...state.vacatedPoses, device],
          depth: state.depth + 1,
          trace: [...state.trace, `${operation}:${device.id}:${pose.position.x},${pose.position.y},${pose.rotation}`],
        });
        generatedStates += 1;
      }
    }
    if (stoppedBy === "max-states") break;
    frontier = next.sort(compareEjectionStates).slice(0, options.config.beamWidth);
  }
  return {
    layouts: [...completed.values()],
    exploredStates,
    generatedStates,
    stoppedBy,
  };
}

function createEjectionPoses(
  device: HeadlessPlacedDevice,
  state: EjectionState,
  options: {
    readonly limitWidth: number;
    readonly limitHeight: number;
    readonly allowRotate?: boolean;
    readonly config: EjectionChainConfig;
  },
  continuationSlots: readonly Slot[],
): HeadlessPlacedDevice[] {
  const poses = new Map<string, HeadlessPlacedDevice>();
  const addPose = (x: number, y: number, rotation: GridRotation) => {
    const swaps = (rotation - device.rotation + 360) % 180 !== 0;
    const pose: HeadlessPlacedDevice = {
      ...device,
      position: { x, y },
      rotation,
      width: swaps ? device.height : device.width,
      height: swaps ? device.width : device.height,
    };
    if (x < 0 || y < 0 || x + pose.width > options.limitWidth || y + pose.height > options.limitHeight) return;
    poses.set(`${x},${y},${rotation}`, pose);
  };
  // A displaced device is not limited to the root's old rectangle: it may
  // continue the chain through another high-quality empty/potential slot.
  for (const slot of continuationSlots) {
    addPose(slot.position.x, slot.position.y, slot.rotation);
  }
  for (const vacated of state.vacatedPoses) {
    for (const rotation of options.allowRotate === false
      ? [device.rotation]
      : [device.rotation, ((device.rotation + 90) % 360) as GridRotation,
        ((device.rotation + 180) % 360) as GridRotation, ((device.rotation + 270) % 360) as GridRotation]) {
      addPose(vacated.position.x, vacated.position.y, rotation);
    }
  }
  if (options.allowRotate !== false) {
    for (const delta of [90, 180, 270] as const) {
      addPose(device.position.x, device.position.y, ((device.rotation + delta) % 360) as GridRotation);
    }
  }
  for (let distance = 1; distance <= options.config.maxTranslation; distance += 1) {
    addPose(device.position.x - distance, device.position.y, device.rotation);
    addPose(device.position.x + distance, device.position.y, device.rotation);
    addPose(device.position.x, device.position.y - distance, device.rotation);
    addPose(device.position.x, device.position.y + distance, device.rotation);
  }
  return [...poses.values()].sort((left, right) =>
    left.position.y - right.position.y || left.position.x - right.position.x || left.rotation - right.rotation);
}

function compareEjectionStates(left: EjectionState, right: EjectionState): number {
  const leftDevices = [...left.devices.values()];
  const rightDevices = [...right.devices.values()];
  const leftBounds = measureFactoryFootprintBounds(leftDevices);
  const rightBounds = measureFactoryFootprintBounds(rightDevices);
  return left.pendingIds.length - right.pendingIds.length
    || leftBounds.width * leftBounds.height - rightBounds.width * rightBounds.height
    || left.movedIds.size - right.movedIds.size
    || left.trace.join("|").localeCompare(right.trace.join("|"));
}

function ejectionStateSignature(state: EjectionState): string {
  return `${packingDevicesSignature([...state.devices.values()])}#${state.pendingIds.join(",")}`;
}

function packingDevicesSignature(devices: readonly HeadlessPlacedDevice[]): string {
  return [...devices].sort((left, right) => left.id.localeCompare(right.id))
    .map((device) => `${device.id}@${device.position.x},${device.position.y},${device.rotation}`)
    .join("|");
}

function isEjectionMovable(device: HeadlessPlacedDevice): boolean {
  return device.kind === "production" || device.kind === "storage";
}

function createSlotEjectionNeighbors(options: {
  readonly packing: PackingResult;
  readonly routedLogistics: readonly HeadlessPlacedDevice[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
  readonly allowRotate: boolean;
}): { readonly packings: readonly PackingResult[]; readonly generated: number } {
  const movable = options.packing.devices.filter(isEjectionMovable);
  if (movable.length === 0) return { packings: [], generated: 0 };
  const bounds = {
    minimumX: Math.min(...movable.map((device) => device.position.x)),
    minimumY: Math.min(...movable.map((device) => device.position.y)),
    maximumX: Math.max(...movable.map((device) => device.position.x + device.width)),
    maximumY: Math.max(...movable.map((device) => device.position.y + device.height)),
  };
  const roots = movable.filter((device) =>
    device.position.x === bounds.minimumX
    || device.position.y === bounds.minimumY
    || device.position.x + device.width === bounds.maximumX
    || device.position.y + device.height === bounds.maximumY)
    .sort((left, right) => {
      const leftContribution = boundaryContribution(left, bounds);
      const rightContribution = boundaryContribution(right, bounds);
      return rightContribution - leftContribution || left.id.localeCompare(right.id);
    })
    .slice(0, 4);
  const layouts = new Map<string, PackingResult>();
  let generated = 0;
  for (const root of roots) {
    const search = searchEjectionChains({
      devices: options.packing.devices,
      logisticsDevices: options.routedLogistics,
      rootDeviceId: root.id,
      limitWidth: options.limitWidth,
      limitHeight: options.limitHeight,
      allowRotate: options.allowRotate,
      config: {
        maxDepth: 4,
        beamWidth: 6,
        maxStates: 72,
        maxTranslation: 5,
        timeBudgetMs: 250,
        maxPotentialBlockers: 2,
      },
    });
    generated += search.generatedStates;
    for (const devices of search.layouts.slice(0, 3)) {
      const packing = createMovedPacking(options.packing, devices, options.routingClearance);
      layouts.set(packingSignature(packing), {
        ...packing,
        debugLabel: `slot-ejection:${root.id}`,
      });
    }
  }
  return { packings: [...layouts.values()].sort(comparePacking).slice(0, 8), generated };
}

function boundaryContribution(
  device: HeadlessPlacedDevice,
  bounds: {
    readonly minimumX: number;
    readonly minimumY: number;
    readonly maximumX: number;
    readonly maximumY: number;
  },
): number {
  let contribution = 0;
  if (device.position.x === bounds.minimumX || device.position.x + device.width === bounds.maximumX) {
    contribution += device.height;
  }
  if (device.position.y === bounds.minimumY || device.position.y + device.height === bounds.maximumY) {
    contribution += device.width;
  }
  return contribution;
}

function createBoundaryBacktrackingNeighbors(options: {
  readonly packing: PackingResult;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
}): { readonly packings: readonly PackingResult[]; readonly generated: number } {
  const movableBoundaryDevices = options.packing.devices.filter((device) =>
    device.kind === "production" || device.kind === "storage");
  if (movableBoundaryDevices.length === 0) return { packings: [], generated: 0 };
  const minimumX = Math.min(...movableBoundaryDevices.map((device) => device.position.x));
  const minimumY = Math.min(...movableBoundaryDevices.map((device) => device.position.y));
  const maximumX = Math.max(...movableBoundaryDevices.map((device) => device.position.x + device.width));
  const maximumY = Math.max(...movableBoundaryDevices.map((device) => device.position.y + device.height));
  // Include near-boundary equipment as roots. A storage or fan-out machine can
  // sit one or two cells behind the literal extremum while still being the
  // device that prevents the contour from folding inward.
  const boundaryBand = 2;
  const roots = movableBoundaryDevices.flatMap((device) => {
    const directions: Array<{ readonly x: number; readonly y: number; readonly name: string }> = [];
    if (device.position.x <= minimumX + boundaryBand) directions.push({ x: 1, y: 0, name: "right" });
    if (device.position.x + device.width >= maximumX - boundaryBand) {
      directions.push({ x: -1, y: 0, name: "left" });
    }
    if (device.position.y <= minimumY + boundaryBand) directions.push({ x: 0, y: 1, name: "down" });
    if (device.position.y + device.height >= maximumY - boundaryBand) {
      directions.push({ x: 0, y: -1, name: "up" });
    }
    return directions.map((direction) => ({ device, direction }));
  });
  const candidates: Array<{ readonly packing: PackingResult; readonly score: readonly number[] }> = [];
  let generated = 0;
  for (const { device, direction } of roots) {
    let state = new Map(options.packing.devices.map((item) => [item.id, item]));
    for (let step = 1; step <= 8; step += 1) {
      const moved = pushDeviceWithBacktracking({
        devices: state,
        deviceId: device.id,
        direction,
        limitWidth: options.limitWidth,
        limitHeight: options.limitHeight,
        depthRemaining: 8,
        visiting: new Set(),
        budget: { remaining: 512 },
      });
      if (moved === null) break;
      state = moved;
      const devices = options.packing.devices.map((item) => state.get(item.id)!);
      if (!hasProductionClearance(devices, 0)) continue;
      generated += 1;
      const repaired = createMovedPacking(options.packing, devices, options.routingClearance);
      candidates.push({
        packing: {
          ...repaired,
          debugLabel: `boundary-backtrack:${device.id}:${direction.name}:${step}`,
        },
        score: [
          repaired.usedWidth * repaired.usedHeight,
          measureConvexContourArea(devices),
          step,
        ],
      });
    }
  }
  const unique = new Map<string, { readonly packing: PackingResult; readonly score: readonly number[] }>();
  for (const candidate of candidates.sort((left, right) => compareScore(left.score, right.score))) {
    unique.set(packingSignature(candidate.packing), candidate);
  }
  return {
    packings: [...unique.values()].slice(0, 8).map((candidate) => candidate.packing),
    generated,
  };
}

function pushDeviceWithBacktracking(options: {
  readonly devices: ReadonlyMap<string, HeadlessPlacedDevice>;
  readonly deviceId: string;
  readonly direction: { readonly x: number; readonly y: number };
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly depthRemaining: number;
  readonly visiting: ReadonlySet<string>;
  readonly budget: { remaining: number };
}): Map<string, HeadlessPlacedDevice> | null {
  if (options.budget.remaining <= 0) return null;
  options.budget.remaining -= 1;
  if (options.visiting.has(options.deviceId)) return null;
  const device = options.devices.get(options.deviceId);
  if (device === undefined) return null;
  const candidate: HeadlessPlacedDevice = {
    ...device,
    position: {
      x: device.position.x + options.direction.x,
      y: device.position.y + options.direction.y,
    },
  };
  if (
    candidate.position.x < 0
    || candidate.position.y < 0
    || candidate.position.x + candidate.width > options.limitWidth
    || candidate.position.y + candidate.height > options.limitHeight
  ) return null;
  let state = new Map(options.devices);
  const visiting = new Set(options.visiting).add(options.deviceId);
  while (true) {
    const blocker = [...state.values()]
      .filter((other) => other.id !== options.deviceId && rectanglesOverlap(candidate, other))
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (blocker === undefined) break;
    if (options.depthRemaining === 0) return null;
    const perpendicular = options.direction.x === 0
      ? [{ x: -1, y: 0 }, { x: 1, y: 0 }]
      : [{ x: 0, y: -1 }, { x: 0, y: 1 }];
    let displaced: Map<string, HeadlessPlacedDevice> | null = null;
    for (const direction of [options.direction, ...perpendicular]) {
      displaced = pushDeviceWithBacktracking({
        ...options,
        devices: state,
        deviceId: blocker.id,
        direction,
        depthRemaining: options.depthRemaining - 1,
        visiting,
      });
      if (displaced !== null) break;
    }
    if (displaced === null) return null;
    state = displaced;
  }
  state.set(candidate.id, candidate);
  return state;
}

function rectanglesOverlap(left: HeadlessPlacedDevice, right: HeadlessPlacedDevice): boolean {
  return left.position.x < right.position.x + right.width
    && left.position.x + left.width > right.position.x
    && left.position.y < right.position.y + right.height
    && left.position.y + left.height > right.position.y;
}

function createCoupledFlowTranslationNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
}): { readonly packings: readonly PackingResult[]; readonly generated: number } {
  const deviceById = new Map(options.packing.devices.map((device) => [device.id, device]));
  const placeableRequests = options.requests.filter((request) =>
    (request.kind === "production" || request.kind === "storage") && deviceById.has(request.id));
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const flowEdges = createCpSatFlowEdges(placeableRequests, options.registry);
  const candidates: Array<{
    readonly packing: PackingResult;
    readonly score: readonly number[];
    readonly terminalDeltaY: number;
    readonly upstreamDeltaY: number;
  }> = [];
  let generated = 0;
  for (const cluster of discoverFlowClusters(placeableRequests.map((request): FlowClusterNode => ({
    id: request.id,
    kind: request.kind,
    directProducerIds: request.warehouseProducerIds,
    inputItemIds: [...request.inputs.keys()],
    outputItemIds: [...request.outputs.keys()],
  })))) {
    const upstreamIds = new Set(cluster.sharedUpstreamIds);
    const movedIds = new Set([cluster.terminalId, ...upstreamIds]);
    if ([...movedIds].some((id) => !deviceById.has(id))) continue;
    const terminal = deviceById.get(cluster.terminalId)!;
    const maximumTerminalDown = options.limitHeight - terminal.position.y - terminal.height;
    const maximumUpstreamDown = cluster.sharedUpstreamIds.length === 0
      ? 0
      : Math.min(...cluster.sharedUpstreamIds.map((id) => {
        const device = deviceById.get(id)!;
        return options.limitHeight - device.position.y - device.height;
      }));
    for (let terminalDeltaY = 0; terminalDeltaY <= maximumTerminalDown; terminalDeltaY += 1) {
      for (let upstreamDeltaY = 0; upstreamDeltaY <= maximumUpstreamDown; upstreamDeltaY += 1) {
        if (terminalDeltaY === 0 && upstreamDeltaY === 0) continue;
        const devices = options.packing.devices.map((device): HeadlessPlacedDevice => {
          const deltaY = device.id === cluster.terminalId
            ? terminalDeltaY
            : upstreamIds.has(device.id) ? upstreamDeltaY : 0;
          return deltaY === 0
            ? device
            : { ...device, position: { x: device.position.x, y: device.position.y + deltaY } };
        });
        if (!hasProductionClearance(devices, 0)) continue;
        generated += 1;
        const portScore = measureExactPortFeasibility(
          devices,
          options.requests,
          flowEdges,
          options.limitWidth,
          options.limitHeight,
          movedIds,
        );
        if (portScore === null) continue;
        const repaired = createMovedPacking(options.packing, devices, options.routingClearance);
        let flowDistance = 0;
        for (const id of movedIds) {
          const request = requestById.get(id);
          const moved = devices.find((device) => device.id === id);
          if (request === undefined || moved === undefined) continue;
          flowDistance += measureFlowPlacementScore(
            request,
            { ...moved.position, ...moved },
            devices.filter((candidate) => candidate.id !== id),
            requestById,
            options.registry,
          )[1];
        }
        candidates.push({
          packing: {
            ...repaired,
            debugLabel: `cluster-translate:${cluster.terminalId}:down:${terminalDeltaY}:${upstreamDeltaY}`,
          },
          score: [
            repaired.usedWidth * repaired.usedHeight,
            portScore,
            flowDistance,
            -(terminalDeltaY + upstreamDeltaY),
          ],
          terminalDeltaY,
          upstreamDeltaY,
        });
      }
    }
  }
  const ordered = candidates.sort((left, right) => compareScore(left.score, right.score));
  const selected = new Map<string, typeof ordered[number]>();
  const keep = (candidate: typeof ordered[number] | undefined): void => {
    if (candidate !== undefined) selected.set(packingSignature(candidate.packing), candidate);
  };
  ordered.slice(0, 2).forEach(keep);
  for (const [terminalDeltaY, upstreamDeltaY] of [
    [1, 1], [1, 2], [2, 1], [2, 2], [2, 3], [3, 2], [3, 3], [3, 4], [4, 3], [4, 4],
  ] as const) {
    keep(ordered.find((candidate) =>
      candidate.terminalDeltaY === terminalDeltaY
      && candidate.upstreamDeltaY === upstreamDeltaY));
  }
  const preserveAxisDiversity = (
    axis: "terminalDeltaY" | "upstreamDeltaY",
  ): void => {
    const bestByOffset = new Map<number, typeof ordered[number]>();
    for (const candidate of ordered) {
      if (!bestByOffset.has(candidate[axis])) bestByOffset.set(candidate[axis], candidate);
    }
    const representatives = [...bestByOffset.entries()].sort((left, right) => left[0] - right[0]);
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      keep(representatives[Math.round((representatives.length - 1) * fraction)]?.[1]);
    }
  };
  preserveAxisDiversity("terminalDeltaY");
  preserveAxisDiversity("upstreamDeltaY");
  return {
    packings: [...selected.values()].slice(0, 16).map((candidate) => candidate.packing),
    generated,
  };
}

/**
 * Rebuild objective-attributed movable equipment first, with a full movable
 * rebuild retained as a bounded fallback when the configured batch can be split.
 * Warehouse ports and bus equipment remain fixed in both variants.
 */
function createCpSatGlobalRebuildNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
  readonly allowRotate: boolean;
  readonly maxSeconds: number;
  readonly candidateCount: number;
  readonly seed: number;
  readonly routedConnections: readonly RoutedConnection[];
  readonly forbiddenLayouts: readonly (readonly CpSatLayoutPlacement[])[];
  readonly capacityCuts: readonly CpSatLayoutCapacityCut[];
}): {
  readonly packings: readonly PackingResult[];
  readonly generated: number;
  readonly partialGenerated: number;
  readonly elapsedMs: number;
  readonly hotspotDeviceIds: readonly string[];
} {
  const incumbentById = new Map(options.packing.devices.map((device) => [device.id, device]));
  const placeableRequests = options.requests.filter((request) =>
    (request.kind === "production" || request.kind === "storage")
    && incumbentById.has(request.id));
  if (placeableRequests.length === 0) {
    return {
      packings: [],
      generated: 0,
      partialGenerated: 0,
      elapsedMs: 0,
      hotspotDeviceIds: [],
    };
  }

  const requestById = new Map(placeableRequests.map((request) => [request.id, request]));
  const flowEdges = createCpSatFlowEdges(placeableRequests, options.registry);
  const hotspotDeviceIds = selectObjectivePartialDestroyIds({
    devices: options.packing.devices,
    routedConnections: options.routedConnections,
    flowEdges,
    preferredDeviceIds: options.forbiddenLayouts.flatMap((layout) =>
      layout.map((placement) => placement.id)),
    maximum: Math.max(2, Math.min(8, Math.ceil(placeableRequests.length * 0.4))),
  });
  const placeableIds = new Set(placeableRequests.map((request) => request.id));
  const partialDestroyedIds = new Set(hotspotDeviceIds.filter((id) => placeableIds.has(id)));
  const totalSeconds = Math.max(0.1, Math.min(1, options.maxSeconds));
  const totalCandidateCount = Math.max(1, Math.min(6, Math.trunc(options.candidateCount)));
  const canUsePartial = partialDestroyedIds.size > 0
    && partialDestroyedIds.size < placeableRequests.length;
  const canSplitBatch = canUsePartial && totalSeconds >= 0.2 && totalCandidateCount >= 2;
  const plans: Array<{
    readonly kind: "partial" | "full";
    readonly destroyedIds: ReadonlySet<string>;
    readonly maxSeconds: number;
    readonly candidateCount: number;
    readonly seed: number;
  }> = [];
  if (canSplitBatch) {
    const fullSeconds = Math.max(0.1, totalSeconds * 0.2);
    const fullCandidateCount = Math.max(1, Math.floor(totalCandidateCount * 0.25));
    plans.push(
      {
        kind: "partial",
        destroyedIds: partialDestroyedIds,
        maxSeconds: totalSeconds - fullSeconds,
        candidateCount: totalCandidateCount - fullCandidateCount,
        seed: options.seed + 1_000_003,
      },
      {
        kind: "full",
        destroyedIds: placeableIds,
        maxSeconds: fullSeconds,
        candidateCount: fullCandidateCount,
        seed: options.seed + 2_000_003,
      },
    );
  } else {
    plans.push({
      kind: canUsePartial ? "partial" : "full",
      destroyedIds: canUsePartial ? partialDestroyedIds : placeableIds,
      maxSeconds: totalSeconds,
      candidateCount: totalCandidateCount,
      seed: options.seed + 1_000_003,
    });
  }

  const generated: Array<{
    readonly packing: PackingResult;
    readonly kind: "partial" | "full";
    readonly score: readonly number[];
  }> = [];
  let generatedCount = 0;
  let partialGenerated = 0;
  let elapsedMs = 0;
  for (const [planIndex, plan] of plans.entries()) {
    const cpSatResult = solveCpSatLayouts({
      devices: placeableRequests.map((request) => {
        const incumbent = incumbentById.get(request.id)!;
        return {
          id: request.id,
          width: request.definition.footprint.width,
          height: request.definition.footprint.height,
          portRequirements: createCpSatPortRequirements(request, flowEdges),
          fixedPlacement: plan.destroyedIds.has(request.id) ? undefined : {
            x: incumbent.position.x,
            y: incumbent.position.y,
            rotation: incumbent.rotation,
          },
        };
      }),
      fixedObstacles: options.packing.devices
        .filter((device) => !requestById.has(device.id))
        .map((device) => ({
          id: device.id,
          x: device.position.x,
          y: device.position.y,
          width: device.width,
          height: device.height,
        })),
      edges: flowEdges,
      clusters: createCpSatFlowClusters(placeableRequests),
      limitWidth: options.limitWidth,
      limitHeight: options.limitHeight,
      routingClearance: options.routingClearance,
      allowRotate: options.allowRotate,
      maxSeconds: plan.maxSeconds,
      candidateCount: plan.candidateCount,
      seed: plan.seed,
      forbiddenLayouts: options.forbiddenLayouts,
      capacityCuts: options.capacityCuts,
      objectiveWeights: DEFAULT_CP_SAT_OBJECTIVE_WEIGHTS,
    });
    generatedCount += cpSatResult.layouts.length;
    if (plan.kind === "partial") partialGenerated += cpSatResult.layouts.length;
    elapsedMs += cpSatResult.elapsedMs ?? 0;
    const minimumMovement = plan.kind === "partial"
      ? Math.max(1, Math.ceil(plan.destroyedIds.size / 2))
      : Math.max(4, Math.ceil(placeableRequests.length / 2));
    for (const [layoutIndex, layout] of cpSatResult.layouts.entries()) {
      const placementById = new Map(layout.map((placement) => [placement.id, placement]));
      if (placementById.size !== placeableRequests.length) continue;
      const devices = options.packing.devices.map((device): HeadlessPlacedDevice => {
        const request = requestById.get(device.id);
        const placement = placementById.get(device.id);
        return request === undefined || placement === undefined
          ? device
          : toProductionDevice(request, placement.x, placement.y, placement);
      });
      if (!hasProductionClearance(devices, 0)) continue;
      const repaired = createMovedPacking(options.packing, devices, options.routingClearance);
      const movement = measurePackingDiversity(options.packing, repaired);
      if (movement < minimumMovement) continue;
      const portScore = measureExactPortFeasibility(
        devices,
        options.requests,
        flowEdges,
        options.limitWidth,
        options.limitHeight,
        plan.destroyedIds,
      );
      if (portScore === null) continue;
      generated.push({
        kind: plan.kind,
        packing: {
          ...repaired,
          debugLabel: `global-rebuild:${plan.kind}:${layoutIndex}`,
        },
        score: [
          repaired.usedWidth * repaired.usedHeight,
          measureEnclosedVoidCells(devices),
          portScore,
          measureAcyclicFlowDirectionPenalty(
            devices,
            new Map(options.requests.map((request) => [request.id, request])),
          ),
          -movement,
          planIndex,
          layoutIndex,
        ],
      });
    }
  }
  const ordered = generated.sort((left, right) => compareScore(left.score, right.score));
  const selected = new Map<string, PackingResult>();
  for (let rank = 0; rank < 2 && selected.size < 4; rank += 1) {
    for (const kind of ["partial", "full"] as const) {
      const candidate = ordered.filter((entry) => entry.kind === kind)[rank];
      if (candidate === undefined) continue;
      selected.set(packingSignature(candidate.packing), candidate.packing);
    }
  }
  for (const candidate of ordered) {
    if (selected.size >= 4) break;
    selected.set(packingSignature(candidate.packing), candidate.packing);
  }
  return {
    packings: [...selected.values()],
    generated: generatedCount,
    partialGenerated,
    elapsedMs,
    hotspotDeviceIds: [...partialDestroyedIds],
  };
}

export function selectObjectivePartialDestroyIds(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly routedConnections: readonly RoutedConnection[];
  readonly flowEdges: readonly CpSatLayoutEdge[];
  readonly preferredDeviceIds?: readonly string[];
  readonly maximum: number;
}): string[] {
  const movableIds = new Set(options.devices
    .filter((device) => device.kind === "production" || device.kind === "storage")
    .map((device) => device.id));
  const capacity = Math.min(movableIds.size, Math.max(1, Math.floor(options.maximum)));
  const ranked = rankObjectiveHotspots({
    devices: options.devices,
    connections: options.routedConnections,
  }).filter((hotspot) => movableIds.has(hotspot.deviceId));
  const selected = new Set((options.preferredDeviceIds ?? [])
    .filter((id) => movableIds.has(id))
    .slice(0, capacity));
  const seedTarget = Math.max(selected.size, Math.max(1, Math.ceil(capacity / 2)));
  for (const hotspot of ranked) {
    if (selected.size >= seedTarget) break;
    selected.add(hotspot.deviceId);
  }
  const neighborIds = options.flowEdges
    .flatMap((edge) => {
      // Prefer moving a hotspot's downstream consumer/terminal with it. The
      // upstream side is more often anchored to an immovable warehouse source,
      // while cutting the downstream pair tends to strand a compact storage
      // terminal behind the rebuilt producer.
      if (selected.has(edge.sourceId)) {
        return [{ id: edge.targetId, direction: 0, weight: edge.weight }];
      }
      if (selected.has(edge.targetId)) {
        return [{ id: edge.sourceId, direction: 1, weight: edge.weight }];
      }
      return [];
    })
    .filter((entry) => movableIds.has(entry.id))
    .sort((left, right) =>
      left.direction - right.direction
      || right.weight - left.weight
      || left.id.localeCompare(right.id));
  for (const neighbor of neighborIds) {
    if (selected.size >= capacity) break;
    selected.add(neighbor.id);
  }
  for (const hotspot of ranked) {
    if (selected.size >= capacity) break;
    selected.add(hotspot.deviceId);
  }
  return [...selected];
}

/**
 * Convert a certified connectivity or cut-capacity conflict into a CP-SAT
 * no-good cut. Ordinary A* frontier evidence remains useful for reroute/LNS
 * prioritization but is not strong enough to exclude a pose from the master.
 */
export function createRouteFailurePoseCut(
  packing: PackingResult,
  evidence: RouteFailureEvidence,
): CpSatLayoutPlacement[] {
  const movableById = new Map(packing.devices
    .filter((device) => device.kind === "production" || device.kind === "storage")
    .map((device) => [device.id, device]));
  // Each certificate is independently sufficient. Select the smallest complete
  // actionable conjunction, but never drop a stale/missing member from one.
  const deviceIds = [
    evidence.placementConflict?.poseDeviceIds,
    evidence.capacityConflict?.poseDeviceIds,
  ].filter((ids): ids is readonly string[] =>
    ids !== undefined && ids.length > 0 && ids.every((id) => movableById.has(id)))
    .sort((left, right) => left.length - right.length || left.join("\u0000").localeCompare(right.join("\u0000")))[0];
  if (deviceIds === undefined) return [];
  return deviceIds.map((id) => {
    const device = movableById.get(id)!;
    return {
      id,
      x: device.position.x,
      y: device.position.y,
      rotation: device.rotation,
      width: device.width,
      height: device.height,
    };
  });
}

/** Build the generalized conditional capacity inequality carried by a certificate. */
export function createRouteFailureCapacityCut(
  packing: PackingResult,
  evidence: RouteFailureEvidence,
): CpSatLayoutCapacityCut | null {
  const certificate = evidence.capacityConflict;
  if (certificate === null
    || !Number.isInteger(certificate.gridWidth) || certificate.gridWidth <= 1
    || !Number.isInteger(certificate.gridHeight) || certificate.gridHeight <= 1
    || !Number.isInteger(certificate.demand) || certificate.demand <= 0
    || certificate.demand <= certificate.capacity) return null;

  let cutEdges: RouteCapacityCutEdge[];
  let fixedBlockedEdgeIndexes: number[];
  if (certificate.proof === "static-cut-capacity") {
    const axisSpan = certificate.axis === "vertical"
      ? certificate.gridWidth
      : certificate.gridHeight;
    const orthogonalSpan = certificate.axis === "vertical"
      ? certificate.gridHeight
      : certificate.gridWidth;
    if (!Number.isInteger(certificate.coordinate)
      || certificate.coordinate <= 0 || certificate.coordinate >= axisSpan
      || certificate.fixedBlockedOffsets.some((offset) =>
        !Number.isInteger(offset) || offset < 0 || offset >= orthogonalSpan)) return null;
    cutEdges = Array.from({ length: orthogonalSpan }, (_, offset) => ({
      from: certificate.axis === "vertical"
        ? { x: certificate.coordinate - 1, y: offset }
        : { x: offset, y: certificate.coordinate - 1 },
      to: certificate.axis === "vertical"
        ? { x: certificate.coordinate, y: offset }
        : { x: offset, y: certificate.coordinate },
    }));
    fixedBlockedEdgeIndexes = [...new Set(certificate.fixedBlockedOffsets)]
      .sort((left, right) => left - right);
  } else {
    cutEdges = certificate.cutEdges.map((edge) => ({
      from: { ...edge.from },
      to: { ...edge.to },
    }));
    fixedBlockedEdgeIndexes = [...new Set(certificate.fixedBlockedEdgeIndexes)]
      .sort((left, right) => left - right);
  }
  const isValidPoint = (point: GridPoint): boolean =>
    Number.isInteger(point.x) && Number.isInteger(point.y)
    && point.x >= 0 && point.x < certificate.gridWidth
    && point.y >= 0 && point.y < certificate.gridHeight;
  if (cutEdges.length === 0
    || cutEdges.some((edge) =>
      !isValidPoint(edge.from) || !isValidPoint(edge.to)
      || Math.abs(edge.from.x - edge.to.x) + Math.abs(edge.from.y - edge.to.y) !== 1)
    || fixedBlockedEdgeIndexes.some((index) =>
      !Number.isInteger(index) || index < 0 || index >= cutEdges.length)) return null;
  const edgeKeys = cutEdges.map((edge) => {
    const fromKey = gridKey(edge.from);
    const toKey = gridKey(edge.to);
    return fromKey < toKey ? `${fromKey}>${toKey}` : `${toKey}>${fromKey}`;
  });
  if (new Set(edgeKeys).size !== edgeKeys.length) return null;

  const movableById = new Map(packing.devices
    .filter((device) => device.kind === "production" || device.kind === "storage")
    .map((device) => [device.id, device]));
  const endpointIds = [...new Set(certificate.endpointPoseDeviceIds)].sort();
  if (endpointIds.some((id) => !movableById.has(id))) return null;
  const activeWhenPlacements = endpointIds.map((id): CpSatLayoutPlacement => {
    const device = movableById.get(id)!;
    return {
      id,
      x: device.position.x,
      y: device.position.y,
      rotation: device.rotation,
      width: device.width,
      height: device.height,
    };
  });
  return {
    axis: certificate.axis,
    coordinate: certificate.coordinate,
    gridWidth: certificate.gridWidth,
    gridHeight: certificate.gridHeight,
    requiredCapacity: certificate.demand,
    cutEdges,
    fixedBlockedEdgeIndexes,
    activeWhenPlacements,
  };
}

function createCpSatClusterRepairNeighbors(options: {
  readonly packing: PackingResult;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
  readonly allowRotate: boolean;
  readonly maxSeconds: number;
  readonly candidateCount: number;
  readonly seed: number;
}): { readonly packings: readonly PackingResult[]; readonly generated: number } {
  const incumbentById = new Map(options.packing.devices.map((device) => [device.id, device]));
  const placeableRequests = options.requests.filter((request) =>
    (request.kind === "production" || request.kind === "storage")
    && incumbentById.has(request.id));
  const requestById = new Map(placeableRequests.map((request) => [request.id, request]));
  const clusters = discoverFlowClusters(placeableRequests.map((request): FlowClusterNode => ({
    id: request.id,
    kind: request.kind,
    directProducerIds: request.warehouseProducerIds,
    inputItemIds: [...request.inputs.keys()],
    outputItemIds: [...request.outputs.keys()],
  })));
  const generated: Array<{ readonly packing: PackingResult; readonly score: readonly number[] }> = [];
  let attemptedLayouts = 0;
  for (const [clusterIndex, cluster] of clusters.entries()) {
    const movableIds = new Set(cluster.allDeviceIds);
    const sharedUpstreamIds = new Set(cluster.sharedUpstreamIds);
    const flowEdges = createCpSatFlowEdges(placeableRequests, options.registry);
    if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
      const incumbentPortScore = measureExactPortFeasibility(
        options.packing.devices,
        options.requests,
        flowEdges,
        options.limitWidth,
        options.limitHeight,
        new Set([cluster.terminalId, ...cluster.sharedUpstreamIds]),
      );
      console.error(`[cluster-incumbent-ports:${cluster.terminalId}] score=${String(incumbentPortScore)}`);
    }
    const cpSatResult = solveCpSatLayouts({
      devices: placeableRequests.map((request) => {
        const incumbent = incumbentById.get(request.id)!;
        return {
          id: request.id,
          width: request.definition.footprint.width,
          height: request.definition.footprint.height,
          hintPlacement: {
            x: incumbent.position.x,
            y: incumbent.position.y,
            rotation: incumbent.rotation,
          },
          portRequirements: request.id === cluster.terminalId
            ? createCpSatPortRequirements(request, flowEdges)
              .filter((requirement) => requirement.direction === "input")
            : sharedUpstreamIds.has(request.id)
              ? createCpSatPortRequirements(request, flowEdges)
                .filter((requirement) => requirement.direction === "output")
              : undefined,
          fixedPlacement: movableIds.has(request.id) ? undefined : {
            x: incumbent.position.x,
            y: incumbent.position.y,
            rotation: incumbent.rotation,
          },
        };
      }),
      fixedObstacles: options.packing.devices
        .filter((device) => !requestById.has(device.id))
        .map((device) => ({
          id: device.id,
          x: device.position.x,
          y: device.position.y,
          width: device.width,
          height: device.height,
        })),
      edges: flowEdges,
      clusters: [{
        terminalId: cluster.terminalId,
        producerIds: cluster.directProducerIds,
        sharedUpstreamIds: cluster.sharedUpstreamIds,
      }],
      limitWidth: options.limitWidth,
      limitHeight: options.limitHeight,
      routingClearance: options.routingClearance,
      allowRotate: options.allowRotate,
      maxSeconds: Math.max(0.1, Math.min(2, options.maxSeconds)),
      candidateCount: Math.max(6, Math.min(12, Math.trunc(options.candidateCount))),
      seed: options.seed + clusterIndex * 104_729,
      objectiveWeights: DEFAULT_CP_SAT_OBJECTIVE_WEIGHTS,
    });
    for (const [layoutIndex, layout] of cpSatResult.layouts.entries()) {
      attemptedLayouts += 1;
      const placementById = new Map(layout.map((placement) => [placement.id, placement]));
      if (placementById.size !== placeableRequests.length) continue;
      const devices = options.packing.devices.map((device): HeadlessPlacedDevice => {
        const placement = placementById.get(device.id);
        const request = requestById.get(device.id);
        return placement === undefined || request === undefined
          ? device
          : toProductionDevice(request, placement.x, placement.y, placement);
      });
      if (!hasProductionClearance(devices, 0)) continue;
      const cheapFlowScore = measureExactPortFeasibility(
        devices,
        options.requests,
        flowEdges,
        options.limitWidth,
        options.limitHeight,
        new Set([cluster.terminalId, ...cluster.sharedUpstreamIds]),
      );
      if (cheapFlowScore === null) continue;
      const repaired = createMovedPacking(options.packing, devices, options.routingClearance);
      const movement = devices.reduce((sum, device) => {
        if (!movableIds.has(device.id)) return sum;
        const incumbent = incumbentById.get(device.id)!;
        return sum
          + Math.abs(device.position.x - incumbent.position.x)
          + Math.abs(device.position.y - incumbent.position.y)
          + (device.rotation === incumbent.rotation ? 0 : 1);
      }, 0);
      const directionPenalty = measureAcyclicFlowDirectionPenalty(
        devices,
        new Map(options.requests.map((request) => [request.id, request])),
      );
      generated.push({
        packing: {
          ...repaired,
          debugLabel: `cluster-repair:${cluster.terminalId}:${clusterIndex}:${layoutIndex}`,
        },
        score: [
          cheapFlowScore,
          directionPenalty,
          repaired.usedWidth * repaired.usedHeight,
          movement,
          repaired.usedHeight,
          repaired.usedWidth,
          layoutIndex,
        ],
      });
    }
  }
  const unique = new Map<string, { readonly packing: PackingResult; readonly score: readonly number[] }>();
  for (const candidate of generated.sort((left, right) => compareScore(left.score, right.score))) {
    unique.set(packingSignature(candidate.packing), candidate);
  }
  return {
    packings: [...unique.values()].slice(0, 4).map((candidate) => candidate.packing),
    generated: attemptedLayouts,
  };
}

/**
 * Cheap funnel for CP-SAT layouts. It uses the actual rotated outside cells of
 * every port, so touching footprints are accepted only when enough connection
 * endpoints remain exposed. Full A* remains the final routing authority.
 */
function measureExactPortFeasibility(
  devices: readonly HeadlessPlacedDevice[],
  requests: readonly DeviceRequest[],
  edges: readonly CpSatLayoutEdge[],
  limitWidth: number,
  limitHeight: number,
  requiredDeviceIds: ReadonlySet<string>,
): number | null {
  const entities = createEntities(requests, devices);
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const occupied = new Set<string>();
  for (const device of devices) {
    addRectangleCells(occupied, device.position.x, device.position.y, device.width, device.height);
  }
  const requiredInputs = new Map<string, number>();
  const requiredOutputs = new Map<string, number>();
  for (const edge of edges) {
    if (requiredDeviceIds.has(edge.sourceId)) {
      requiredOutputs.set(edge.sourceId, (requiredOutputs.get(edge.sourceId) ?? 0) + edge.laneCount);
    }
    if (requiredDeviceIds.has(edge.targetId)) {
      requiredInputs.set(edge.targetId, (requiredInputs.get(edge.targetId) ?? 0) + edge.laneCount);
    }
  }
  interface AccessiblePort {
    readonly point: GridPoint;
    readonly escapeOptionCount: number;
  }
  const endpointCache = new Map<string, readonly AccessiblePort[]>();
  const resolveAccessible = (
    deviceId: string,
    direction: "input" | "output",
  ): readonly AccessiblePort[] => {
    const cacheKey = `${deviceId}:${direction}`;
    const cached = endpointCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const entity = entities[deviceId];
    const request = requestById.get(deviceId);
    if (entity === undefined || request === undefined) return [];
    const endpoints = (["belt", "pipe"] as const).flatMap((kind) =>
      resolveDevicePortEndpoints({
        entity,
        definition: request.definition,
        kind,
        direction,
        pointerGridPoint: entity.position,
      }))
      .filter(({ outsideGridPoint: point }) =>
        point.x >= 0 && point.y >= 0 && point.x < limitWidth && point.y < limitHeight)
      .filter(({ outsideGridPoint: point }) => !occupied.has(gridKey(point)));
    const unique = [...new Map(endpoints.map((endpoint): readonly [string, AccessiblePort] => {
      const point = endpoint.outsideGridPoint;
      const escapeOptionCount = [
        { x: point.x - 1, y: point.y },
        { x: point.x + 1, y: point.y },
        { x: point.x, y: point.y - 1 },
        { x: point.x, y: point.y + 1 },
      ].filter((neighbor) =>
        neighbor.x >= 0 && neighbor.y >= 0
        && neighbor.x < limitWidth && neighbor.y < limitHeight
        && !occupied.has(gridKey(neighbor))).length;
      return [gridKey(point), { point, escapeOptionCount }];
    })).values()];
    endpointCache.set(cacheKey, unique);
    return unique;
  };
  for (const [deviceId, count] of requiredInputs) {
    const available = resolveAccessible(deviceId, "input").length;
    if (available < count) {
      if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
        console.error(`[port-funnel:${deviceId}:input] available=${available} required=${count}`);
      }
      return null;
    }
  }
  for (const [deviceId, count] of requiredOutputs) {
    const available = resolveAccessible(deviceId, "output").length;
    if (available < count) {
      if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
        console.error(`[port-funnel:${deviceId}:output] available=${available} required=${count}`);
      }
      return null;
    }
  }
  let totalDistance = 0;
  for (const [direction, requirements] of [
    ["input", requiredInputs],
    ["output", requiredOutputs],
  ] as const) {
    for (const [deviceId, count] of requirements) {
      const accesses = [...resolveAccessible(deviceId, direction)]
        .sort((left, right) => right.escapeOptionCount - left.escapeOptionCount);
      totalDistance += accesses
        .slice(0, count)
        .reduce((sum, access) => sum + Math.max(0, 2 - access.escapeOptionCount) * 8, 0);
    }
  }
  for (const edge of edges) {
    const sources = resolveAccessible(edge.sourceId, "output");
    const targets = resolveAccessible(edge.targetId, "input");
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const source of sources) {
      for (const target of targets) {
        bestDistance = Math.min(
          bestDistance,
          Math.abs(source.point.x - target.point.x) + Math.abs(source.point.y - target.point.y),
        );
      }
    }
    if (!Number.isFinite(bestDistance)) {
      if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
        console.error(
          `[port-funnel-edge:${edge.sourceId}->${edge.targetId}] sources=${sources.length} targets=${targets.length}`,
        );
      }
      return null;
    }
    totalDistance += bestDistance * Math.max(1, edge.weight);
  }
  return totalDistance;
}

function hasBidirectionalMaterialFlow(left: DeviceRequest, right: DeviceRequest): boolean {
  return [...left.outputs.keys()].some((itemId) => right.inputs.has(itemId))
    && [...right.outputs.keys()].some((itemId) => left.inputs.has(itemId));
}

function hasMultiConsumerOutput(
  producer: DeviceRequest,
  requests: readonly DeviceRequest[],
): boolean {
  for (const [itemId, outputPerMinute] of producer.outputs) {
    const consumerRates = requests
      .filter((request) => request.id !== producer.id)
      .map((request) => request.inputs.get(itemId) ?? 0)
      .filter((rate) => rate > 0.000001)
      .sort((left, right) => left - right);
    if (
      consumerRates.length >= 2
      && outputPerMinute + 0.000001 >= consumerRates[0]! + consumerRates[1]!
    ) return true;
  }
  return false;
}

function hasMultiProducerInput(
  consumer: DeviceRequest,
  requests: readonly DeviceRequest[],
): boolean {
  for (const itemId of consumer.inputs.keys()) {
    const producerCount = requests.filter((request) =>
      request.id !== consumer.id && (request.outputs.get(itemId) ?? 0) > 0.000001).length;
    if (producerCount >= 2) return true;
  }
  return false;
}

function createFanoutRelocationNeighbors(
  packing: PackingResult,
  limitWidth: number,
  limitHeight: number,
  routingClearance: number,
  requests: readonly DeviceRequest[],
  requestsById: ReadonlyMap<string, DeviceRequest>,
  registry: RegistryContract,
): PackingResult[] {
  const candidates: Array<{
    readonly packing: PackingResult;
    readonly rotation: GridRotation;
    readonly score: readonly number[];
    readonly distanceScore: readonly number[];
  }> = [];
  for (let deviceIndex = 0; deviceIndex < packing.devices.length; deviceIndex += 1) {
    const device = packing.devices[deviceIndex]!;
    const request = requestsById.get(device.id);
    if (
      (device.kind !== "production" && device.kind !== "storage")
      || request === undefined
      || (
        !hasMultiConsumerOutput(request, requests)
        && !hasMultiProducerInput(request, requests)
      )
    ) continue;
    const otherDevices = packing.devices.filter((_, index) => index !== deviceIndex);
    for (const rotation of [0, 90, 180, 270] as const) {
      const swapsFootprint = rotation === 90 || rotation === 270;
      const width = swapsFootprint
        ? request.definition.footprint.height
        : request.definition.footprint.width;
      const height = swapsFootprint
        ? request.definition.footprint.width
        : request.definition.footprint.height;
      for (let y = routingClearance; y + height + routingClearance <= limitHeight; y += 1) {
        for (let x = routingClearance; x + width + routingClearance <= limitWidth; x += 1) {
          if (x === device.position.x && y === device.position.y && rotation === device.rotation) continue;
          const moved: HeadlessPlacedDevice = {
            ...device,
            position: { x, y },
            rotation,
            width,
            height,
          };
          const devices = packing.devices.map((item, index) => index === deviceIndex ? moved : item);
          if (!hasProductionClearance(devices, 0)) continue;
          const flowScore = measureFlowPlacementScore(
            request,
            { x, y, width, height, rotation },
            otherDevices,
            requestsById,
            registry,
          );
          const relocated = createMovedPacking(packing, devices, routingClearance);
          const frontageOverflow = measureFrontageOverflowCells(devices);
          candidates.push({
            packing: {
              ...relocated,
              debugLabel: `local-fanout:${device.id}:${rotation}:${x},${y}`,
            },
            rotation,
            score: [
              frontageOverflow,
              ...flowScore,
              relocated.usedWidth * relocated.usedHeight,
              Math.abs(x - device.position.x) + Math.abs(y - device.position.y),
              rotation,
              y,
              x,
            ],
            distanceScore: [
              frontageOverflow,
              flowScore[1],
              flowScore[0],
              relocated.usedWidth * relocated.usedHeight,
              rotation,
              y,
              x,
            ],
          });
        }
      }
    }
  }
  const selected = new Map<string, PackingResult>();
  for (const rotation of [0, 90, 180, 270] as const) {
    const rotationCandidates = candidates.filter((candidate) => candidate.rotation === rotation);
    for (const candidate of [
      ...rotationCandidates.sort((left, right) => compareScore(left.score, right.score)).slice(0, 3),
      ...rotationCandidates.sort((left, right) => compareScore(left.distanceScore, right.distanceScore)).slice(0, 2),
    ]) selected.set(packingSignature(candidate.packing), candidate.packing);
  }
  return [...selected.values()];
}

function createStorageFanoutJointNeighbors(
  packing: PackingResult,
  limitWidth: number,
  limitHeight: number,
  routingClearance: number,
  requests: readonly DeviceRequest[],
  requestsById: ReadonlyMap<string, DeviceRequest>,
  registry: RegistryContract,
): PackingResult[] {
  interface PlacementCandidate {
    readonly device: HeadlessPlacedDevice;
    readonly score: readonly number[];
    readonly areaScore: readonly number[];
  }
  const deviceIndexById = new Map(packing.devices.map((device, index) => [device.id, index]));
  const hasClearanceFrom = (
    device: HeadlessPlacedDevice,
    otherDevices: readonly HeadlessPlacedDevice[],
    clearance: number,
  ): boolean => otherDevices.every((other) => {
    const horizontalGap = Math.max(
      0,
      Math.max(device.position.x, other.position.x)
        - Math.min(device.position.x + device.width, other.position.x + other.width),
    );
    const verticalGap = Math.max(
      0,
      Math.max(device.position.y, other.position.y)
        - Math.min(device.position.y + device.height, other.position.y + other.height),
    );
    return horizontalGap >= clearance || verticalGap >= clearance;
  });
  const enumeratePlacements = (
    request: DeviceRequest,
    original: HeadlessPlacedDevice,
    excludedIds: ReadonlySet<string>,
    requiredClearance: number,
  ): PlacementCandidate[] => {
    const otherDevices = packing.devices.filter((device) => !excludedIds.has(device.id));
    const candidates: PlacementCandidate[] = [];
    for (const rotation of [0, 90, 180, 270] as const) {
      const swapsFootprint = rotation === 90 || rotation === 270;
      const width = swapsFootprint
        ? request.definition.footprint.height
        : request.definition.footprint.width;
      const height = swapsFootprint
        ? request.definition.footprint.width
        : request.definition.footprint.height;
      for (let y = routingClearance; y + height + routingClearance <= limitHeight; y += 1) {
        for (let x = routingClearance; x + width + routingClearance <= limitWidth; x += 1) {
          if (x === original.position.x && y === original.position.y && rotation === original.rotation) continue;
          const device: HeadlessPlacedDevice = {
            ...original,
            position: { x, y },
            rotation,
            width,
            height,
          };
          // Joint LNS candidates need an immediately usable port cell. The normal
          // packing search may let unused faces touch, but a relocated fan-out or
          // fan-in terminal has required logistics on both sides of this cluster.
          if (!hasClearanceFrom(device, otherDevices, requiredClearance)) continue;
          const flowScore = measureFlowPlacementScore(
            request,
            { x, y, width, height, rotation },
            otherDevices,
            requestsById,
            registry,
          );
          const bounds = measureBounds([...otherDevices, device]);
          const area = bounds.width * bounds.height;
          const movement = Math.abs(x - original.position.x) + Math.abs(y - original.position.y);
          candidates.push({
            device,
            score: [...flowScore, area, movement, rotation, y, x],
            areaScore: [area, ...flowScore, movement, rotation, y, x],
          });
        }
      }
    }
    const selected = new Map<string, PlacementCandidate>();
    for (const candidate of [
      ...candidates.sort((left, right) => compareScore(left.score, right.score)).slice(0, 8),
      ...candidates.sort((left, right) => compareScore(left.areaScore, right.areaScore)).slice(0, 4),
    ]) {
      const device = candidate.device;
      selected.set(`${device.position.x},${device.position.y},${device.rotation}`, candidate);
    }
    return [...selected.values()];
  };

  const jointCandidates: Array<{ readonly packing: PackingResult; readonly score: readonly number[] }> = [];
  const storageRequests = requests.filter((request) =>
    request.kind === "storage" && (request.warehouseProducerIds?.length ?? 0) >= 2);
  for (const storageRequest of storageRequests) {
    const storageIndex = deviceIndexById.get(storageRequest.id);
    if (storageIndex === undefined) continue;
    const storageDevice = packing.devices[storageIndex]!;
    const terminalProducers = (storageRequest.warehouseProducerIds ?? [])
      .flatMap((id) => {
        const request = requestsById.get(id);
        return request === undefined ? [] : [request];
      });
    const sharedUpstreamRequests = requests.filter((request) =>
      request.kind === "production"
      && hasMultiConsumerOutput(request, terminalProducers)
      && terminalProducers.filter((consumer) =>
        [...request.outputs.keys()].some((itemId) => consumer.inputs.has(itemId))).length >= 2);
    for (const upstreamRequest of sharedUpstreamRequests) {
      const upstreamIndex = deviceIndexById.get(upstreamRequest.id);
      if (upstreamIndex === undefined) continue;
      const upstreamDevice = packing.devices[upstreamIndex]!;
      const jointlyMovedIds = new Set([storageRequest.id, upstreamRequest.id]);
      // A multi-producer terminal needs enough depth to turn independent lanes
      // before they reach its input face. Derive that depth from graph fan-in;
      // this is orientation- and recipe-independent rather than a fixed layout.
      const fanInDepth = Math.max(2, Math.min(4, storageRequest.warehouseProducerIds?.length ?? 2));
      const storagePlacements = enumeratePlacements(
        storageRequest,
        storageDevice,
        jointlyMovedIds,
        fanInDepth,
      );
      const upstreamPlacements = enumeratePlacements(upstreamRequest, upstreamDevice, jointlyMovedIds, 1);
      for (const storagePlacement of storagePlacements) {
        for (const upstreamPlacement of upstreamPlacements) {
          const devices = packing.devices.map((device, index): HeadlessPlacedDevice => {
            if (index === storageIndex) return storagePlacement.device;
            if (index === upstreamIndex) return upstreamPlacement.device;
            return device;
          });
          if (
            !hasProductionClearance(devices, 0)
            || !hasClearanceFrom(storagePlacement.device, [upstreamPlacement.device], 1)
          ) continue;
          const relocated = createMovedPacking(packing, devices, routingClearance);
          const storageOthers = devices.filter((device) => device.id !== storageRequest.id);
          const upstreamOthers = devices.filter((device) => device.id !== upstreamRequest.id);
          const storageFlow = measureFlowPlacementScore(
            storageRequest,
            { ...storagePlacement.device.position, ...storagePlacement.device },
            storageOthers,
            requestsById,
            registry,
          );
          const upstreamFlow = measureFlowPlacementScore(
            upstreamRequest,
            { ...upstreamPlacement.device.position, ...upstreamPlacement.device },
            upstreamOthers,
            requestsById,
            registry,
          );
          jointCandidates.push({
            packing: {
              ...relocated,
              debugLabel: `joint-storage-fanout:${storageRequest.id}:${upstreamRequest.id}`,
            },
            score: [
              storageFlow[0] + upstreamFlow[0],
              storageFlow[1] + upstreamFlow[1],
              relocated.usedWidth * relocated.usedHeight,
              storagePlacement.device.position.y,
              storagePlacement.device.position.x,
              upstreamPlacement.device.position.y,
              upstreamPlacement.device.position.x,
            ],
          });
        }
      }
    }
  }
  return jointCandidates
    .sort((left, right) => compareScore(left.score, right.score))
    .slice(0, 1)
    .map((candidate) => candidate.packing);
}

function measureAcyclicFlowDirectionPenalty(
  devices: readonly HeadlessPlacedDevice[],
  requestsById: ReadonlyMap<string, DeviceRequest>,
): number {
  let directionPenalty = 0;
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  for (const producer of requestsById.values()) {
    const producerDevice = deviceById.get(producer.id);
    if (producerDevice === undefined) continue;
    for (const consumer of requestsById.values()) {
      if (producer.id === consumer.id) continue;
      const feedsConsumer = [...producer.outputs.keys()].some((itemId) => consumer.inputs.has(itemId));
      const consumerFeedsBack = [...consumer.outputs.keys()].some((itemId) => producer.inputs.has(itemId));
      if (!feedsConsumer || consumerFeedsBack) continue;
      const consumerDevice = deviceById.get(consumer.id);
      if (consumerDevice === undefined) continue;
      const producerCenter = deviceCenter(producerDevice);
      const consumerCenter = deviceCenter(consumerDevice);
      directionPenalty += measurePortDirectionPenalty(
        resolvePortEdge(producer, "output", producerDevice.rotation),
        consumerCenter.x - producerCenter.x,
        consumerCenter.y - producerCenter.y,
      );
      directionPenalty += measurePortDirectionPenalty(
        resolvePortEdge(consumer, "input", consumerDevice.rotation),
        producerCenter.x - consumerCenter.x,
        producerCenter.y - consumerCenter.y,
      );
    }
  }
  return directionPenalty;
}

function createMovedPacking(
  packing: PackingResult,
  devices: readonly HeadlessPlacedDevice[],
  routingClearance: number,
): PackingResult {
  return {
    devices,
    usedWidth: devices.reduce(
      (maximum, device) => Math.max(maximum, device.position.x + device.width + routingClearance),
      0,
    ),
    usedHeight: devices.reduce(
      (maximum, device) => Math.max(maximum, device.position.y + device.height + routingClearance),
      0,
    ),
    equipmentArea: packing.equipmentArea,
  };
}

function hasProductionClearance(
  devices: readonly HeadlessPlacedDevice[],
  clearance: number,
): boolean {
  for (let leftIndex = 0; leftIndex < devices.length; leftIndex += 1) {
    const left = devices[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < devices.length; rightIndex += 1) {
      const right = devices[rightIndex]!;
      const overlaps = left.position.x < right.position.x + right.width
        && left.position.x + left.width > right.position.x
        && left.position.y < right.position.y + right.height
        && left.position.y + left.height > right.position.y;
      if (overlaps) return false;
      if (clearance === 0) continue;
      const horizontalGap = Math.max(
        0,
        Math.max(left.position.x, right.position.x)
          - Math.min(left.position.x + left.width, right.position.x + right.width),
      );
      const verticalGap = Math.max(
        0,
        Math.max(left.position.y, right.position.y)
          - Math.min(left.position.y + left.height, right.position.y + right.height),
      );
      // Clearance is no longer mandatory between production devices. This helper
      // is retained for callers that explicitly request a positive geometric gap.
      if (horizontalGap < clearance && verticalGap < clearance) return false;
    }
  }
  return true;
}

interface PowerPlacementResult {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly minimumRequiredCount: number;
}

function placePowerDiffusers(options: {
  readonly placeableDevices: readonly HeadlessPlacedDevice[];
  readonly occupiedDevices: readonly HeadlessPlacedDevice[];
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly limitWidth: number;
  readonly limitHeight: number;
}): PowerPlacementResult | null {
  const powerDefinition = options.registry.entityDefinitions.find((definition) =>
    definition.id === "item_port_power_diffuser_1");
  if (powerDefinition === undefined || powerDefinition.powerRange === undefined) return null;
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const poweredTargets = options.placeableDevices.filter((device) =>
    requestById.get(device.id)?.definition.requiresPower === true);
  if (poweredTargets.length === 0) return { devices: [], minimumRequiredCount: 0 };

  const targetRects = new Map(poweredTargets.map((device) => [device.id, {
    x: device.position.x,
    y: device.position.y,
    width: device.width,
    height: device.height,
  }]));
  const targetIds = poweredTargets.map((device) => device.id).sort();
  const occupied = [...options.occupiedDevices];
  const occupiedCells = new Set<string>();
  for (const device of occupied) {
    addRectangleCells(
      occupiedCells,
      device.position.x,
      device.position.y,
      device.width,
      device.height,
    );
  }
  interface PowerPlacementCandidate extends MinimumCoverageCandidate {
    readonly device: HeadlessPlacedDevice;
    readonly adjacency: number;
    readonly score: readonly number[];
  }
  const rawCandidates: PowerPlacementCandidate[] = [];
  for (let y = 0; y + powerDefinition.footprint.height <= options.limitHeight; y += 1) {
    for (let x = 0; x + powerDefinition.footprint.width <= options.limitWidth; x += 1) {
      const device: HeadlessPlacedDevice = {
        id: `power-candidate-${x}-${y}`,
        definitionId: powerDefinition.id,
        kind: "power",
        recipeId: null,
        position: { x, y },
        rotation: 0,
        width: powerDefinition.footprint.width,
        height: powerDefinition.footprint.height,
      };
      if (occupied.some((other) => rectanglesOverlap(device, other))) continue;
      const rangeRect = resolvePowerRangeGridRect({
        entity: {
          id: device.id,
          definitionId: device.definitionId,
          position: device.position,
          rotation: device.rotation,
          config: {},
          tags: [],
        },
        definition: powerDefinition,
      });
      if (rangeRect === null) continue;
      const coveredIds = targetIds.filter((id) => {
        const rect = targetRects.get(id);
        return rect !== undefined && areGridRectsIntersecting(rangeRect, rect);
      });
      if (coveredIds.length === 0) continue;
      let adjacency = 0;
      for (let cellY = y; cellY < y + device.height; cellY += 1) {
        for (let cellX = x; cellX < x + device.width; cellX += 1) {
          for (const neighbor of [
            { x: cellX - 1, y: cellY },
            { x: cellX + 1, y: cellY },
            { x: cellX, y: cellY - 1 },
            { x: cellX, y: cellY + 1 },
          ]) {
            if (occupiedCells.has(gridKey(neighbor))) adjacency += 1;
          }
        }
      }
      const devices = [...occupied, device];
      const candidateBounds = measureFactoryFootprintBounds(devices);
      rawCandidates.push({
        id: device.id,
        device,
        coveredTargetIds: coveredIds,
        adjacency,
        score: [
          measureFrontageOverflowCells(devices),
          candidateBounds.width * candidateBounds.height,
          measureEnclosedVoidCells(devices),
          measureConvexContourArea(devices),
          -adjacency,
          -coveredIds.length,
          y,
          x,
        ],
      });
    }
  }
  const orderedRawCandidates = rawCandidates.sort((left, right) =>
    compareScore(left.score, right.score));
  const minimumCoverage = solveMinimumCoverage({
    targetIds,
    candidates: orderedRawCandidates,
    areCompatible: (left, right) => !rectanglesOverlap(left.device, right.device),
  });
  if (minimumCoverage === null) return null;
  const minimumRequiredCount = minimumCoverage.minimumCount;

  // Positions covering the same targets are interchangeable for the quality
  // beam. The exact solver above retains every position, so this reduction can
  // no longer alter the proved minimum-cardinality result.
  // Retain several geometrically distinct embedded representatives instead of
  // letting hundreds of exposed placements dominate the beam.
  const candidatesByCoverage = new Map<string, PowerPlacementCandidate[]>();
  for (const candidate of orderedRawCandidates) {
    const key = candidate.coveredTargetIds.join(",");
    const entries = candidatesByCoverage.get(key) ?? [];
    if (entries.length < 12) entries.push(candidate);
    candidatesByCoverage.set(key, entries);
  }
  const candidates = [...candidatesByCoverage.values()].flat();
  interface PowerPlacementState {
    readonly devices: readonly HeadlessPlacedDevice[];
    readonly coveredIds: ReadonlySet<string>;
    readonly adjacency: number;
    readonly score: readonly number[];
  }
  const scoreState = (
    devices: readonly HeadlessPlacedDevice[],
    coveredIds: ReadonlySet<string>,
    adjacency: number,
  ): readonly number[] => {
    const allDevices = [...occupied, ...devices];
    const bounds = measureFactoryFootprintBounds(allDevices);
    return [
      targetIds.length - coveredIds.size,
      measureFrontageOverflowCells(allDevices),
      bounds.width * bounds.height,
      measureEnclosedVoidCells(allDevices),
      measureConvexContourArea(allDevices),
      -adjacency,
      devices.length,
    ];
  };
  let beam: PowerPlacementState[] = [{
    devices: [],
    coveredIds: new Set(),
    adjacency: 0,
    score: [targetIds.length, 0, 0, 0, 0, 0, 0],
  }];
  for (let depth = 0; depth < minimumRequiredCount; depth += 1) {
    const expanded: PowerPlacementState[] = [];
    for (const state of beam) {
      for (const candidate of candidates) {
        if (state.devices.some((device) => rectanglesOverlap(device, candidate.device))) continue;
        const nextCovered = new Set(state.coveredIds);
        candidate.coveredTargetIds.forEach((id) => nextCovered.add(id));
        if (nextCovered.size === state.coveredIds.size) continue;
        const devices = [...state.devices, candidate.device];
        expanded.push({
          devices,
          coveredIds: nextCovered,
          adjacency: state.adjacency + candidate.adjacency,
          score: scoreState(devices, nextCovered, state.adjacency + candidate.adjacency),
        });
      }
    }
    if (expanded.length === 0) break;
    const ordered = expanded.sort((left, right) => compareScore(left.score, right.score));
    const complete = ordered.filter((state) => state.coveredIds.size === targetIds.length);
    if (complete.length > 0) {
      return {
        devices: complete[0]!.devices.map((device, index) => ({
          ...device,
          id: `power-diffuser-${index + 1}`,
        })),
        minimumRequiredCount,
      };
    }
    const statesPerCoverage = new Map<string, number>();
    beam = ordered.filter((state) => {
      const key = [...state.coveredIds].sort().join(",");
      const count = statesPerCoverage.get(key) ?? 0;
      if (count >= 4) return false;
      statesPerCoverage.set(key, count + 1);
      return true;
    }).slice(0, 48);
  }
  const candidateById = new Map(orderedRawCandidates.map((candidate) => [candidate.id, candidate]));
  const witnessDevices = minimumCoverage.selectedCandidateIds.map((id) =>
    candidateById.get(id)?.device);
  if (witnessDevices.some((device) => device === undefined)) return null;
  return {
    devices: witnessDevices.map((device, index) => ({
      ...device!,
      id: `power-diffuser-${index + 1}`,
    })),
    minimumRequiredCount,
  };
}

function createEntities(
  requests: readonly DeviceRequest[],
  devices: readonly HeadlessPlacedDevice[],
): Record<string, WorldEntity> {
  const requestById = new Map(requests.map((request) => [request.id, request]));
  return Object.fromEntries(devices.map((device) => {
    const request = requestById.get(device.id);
    const tags = ["headless-optimized", `layout:${request?.kind ?? device.kind}`];
    if (device.recipeId !== null) tags.push(`recipe:${device.recipeId}`);
    if (request?.warehouseItemId !== undefined) tags.push(`item:${request.warehouseItemId}`);
    return [device.id, {
      id: device.id,
      definitionId: device.definitionId,
      position: { ...device.position },
      rotation: device.rotation,
      config: request?.config ?? {},
      tags,
    } satisfies WorldEntity];
  }));
}

export interface ReroutableConnection extends AffectedConnectionDescriptor {
  readonly points: readonly GridPoint[];
}

/**
 * Resolve the minimal deterministic route set invalidated by equipment motion.
 * Directly incident routes, routes crossing an old/new footprint buffer, and
 * routes sharing a crossing cell with those routes are included.
 */
export function resolveConflictingConnections(options: {
  readonly connections: readonly ReroutableConnection[];
  readonly movedDeviceIds: ReadonlySet<string>;
  readonly previousDevices: readonly HeadlessPlacedDevice[];
  readonly nextDevices: readonly HeadlessPlacedDevice[];
  readonly buffer?: number;
  readonly maxConnections?: number;
}): string[] {
  const direct = new Set(computeAffectedConnections(options.connections, options.movedDeviceIds).connectionIds);
  const previousById = new Map(options.previousDevices.map((device) => [device.id, device]));
  const nextById = new Map(options.nextDevices.map((device) => [device.id, device]));
  const buffer = Math.max(0, Math.trunc(options.buffer ?? 1));
  const movedRectangles = [...options.movedDeviceIds].flatMap((id) => [
    previousById.get(id),
    nextById.get(id),
  ]).filter((device): device is HeadlessPlacedDevice => device !== undefined);
  for (const connection of options.connections) {
    if (connection.points.some((point) => movedRectangles.some((device) =>
      point.x >= device.position.x - buffer
      && point.x < device.position.x + device.width + buffer
      && point.y >= device.position.y - buffer
      && point.y < device.position.y + device.height + buffer))) {
      direct.add(connection.id);
    }
  }
  const affectedCells = new Set(options.connections
    .filter((connection) => direct.has(connection.id))
    .flatMap((connection) => connection.points.map(gridKey)));
  for (const connection of options.connections) {
    if (connection.points.some((point) => affectedCells.has(gridKey(point)))) direct.add(connection.id);
  }
  return [...direct].sort().slice(0, options.maxConnections ?? Number.MAX_SAFE_INTEGER);
}

/** Progressively enlarge a local rip-up set through shared endpoints/cells. */
export function ripUpAndReroute(options: {
  readonly connections: readonly ReroutableConnection[];
  readonly initialConnectionIds: readonly string[];
  readonly config: RipUpConfig;
  /**
   * Optional state outside the ripped ID set that changes the next reroute,
   * such as a failure-directed priority order. Repeating the same combined
   * state is exhausted immediately instead of burning the remaining attempts.
   */
  readonly retryStateSignature?: (connectionIds: readonly string[]) => string;
  /**
   * Failure-evidence-ranked blockers to rip before the generic
   * shared-endpoint/cell frontier. Only one new connection is selected per
   * attempt, so intermediate preservation states remain observable.
   */
  readonly prioritizeConnectionIds?: (connectionIds: readonly string[]) => readonly string[];
  readonly onPriorityConnectionSelected?: (connectionId: string) => void;
  readonly tryReroute: (connectionIds: readonly string[], attempt: number) => boolean;
}): RipUpResult {
  const startedAt = Date.now();
  const allIds = new Set(options.connections.map((connection) => connection.id));
  const ripped = new Set(options.initialConnectionIds.filter((id) => allIds.has(id)));
  const attemptedRetryStates = new Set<string>();
  let attempts = 0;
  while (attempts < options.config.maxAttempts) {
    if (Date.now() - startedAt >= options.config.timeBudgetMs) {
      return createRipUpResult("time-budget", ripped, allIds, attempts);
    }
    if (ripped.size > options.config.maxConnections) {
      return createRipUpResult("max-connections", ripped, allIds, attempts);
    }
    const ids = [...ripped].sort();
    if (options.retryStateSignature !== undefined) {
      const retryState = `${ids.join("\u0000")}\u0002${options.retryStateSignature(ids)}`;
      if (attemptedRetryStates.has(retryState)) {
        return createRipUpResult("exhausted", ripped, allIds, attempts);
      }
      attemptedRetryStates.add(retryState);
    }
    attempts += 1;
    if (options.tryReroute(ids, attempts)) return createRipUpResult("success", ripped, allIds, attempts);
    const priorityNext = options.prioritizeConnectionIds?.(ids)
      .find((id) => allIds.has(id) && !ripped.has(id));
    if (priorityNext !== undefined) {
      ripped.add(priorityNext);
      options.onPriorityConnectionSelected?.(priorityNext);
      continue;
    }
    const frontier = options.connections.filter((connection) => !ripped.has(connection.id))
      .map((connection) => ({
        connection,
        conflicts: options.connections.filter((other) => ripped.has(other.id)
          && connectionsInteract(connection, other)).length,
      }))
      .filter(({ conflicts }) => conflicts > 0)
      .sort((left, right) => right.conflicts - left.conflicts
        || left.connection.id.localeCompare(right.connection.id));
    const next = frontier[0]?.connection.id;
    if (next === undefined) {
      if (options.config.retryExhaustedSet === true
        && ripped.size === allIds.size
        && attempts < options.config.maxAttempts) continue;
      break;
    }
    ripped.add(next);
  }
  return createRipUpResult("exhausted", ripped, allIds, attempts);
}

/**
 * Rank existing routes that occupy the exact logistics frontier cells reached
 * by a failed A* search. Production-device blockers are intentionally ignored:
 * only removable connections can expand a rip-up set.
 */
export function rankConnectionsBlockingRouteFailure(
  evidence: Pick<RouteFailureEvidence, "frontierBlockers">,
  connections: readonly ReroutableConnection[],
): string[] {
  const logisticsBlockerCells = new Set(evidence.frontierBlockers
    .filter((blocker) => blocker.ownerKind === "logistics")
    .map((blocker) => `${blocker.x},${blocker.y}`));
  if (logisticsBlockerCells.size === 0) return [];
  return connections
    .map((connection) => ({
      id: connection.id,
      blockedCellCount: connection.points.reduce((count, point) =>
        count + Number(logisticsBlockerCells.has(gridKey(point))), 0),
    }))
    .filter((candidate) => candidate.blockedCellCount > 0)
    .sort((left, right) =>
      right.blockedCellCount - left.blockedCellCount
      || left.id.localeCompare(right.id))
    .map((candidate) => candidate.id);
}

function createRipUpResult(
  status: RipUpResult["status"],
  ripped: ReadonlySet<string>,
  allIds: ReadonlySet<string>,
  attempts: number,
): RipUpResult {
  const rippedConnectionIds = [...ripped].sort();
  return {
    status,
    rippedConnectionIds,
    preservedConnectionIds: [...allIds].filter((id) => !ripped.has(id)).sort(),
    attempts,
  };
}

function connectionsInteract(left: ReroutableConnection, right: ReroutableConnection): boolean {
  if (left.sourceDeviceId !== null
    && (left.sourceDeviceId === right.sourceDeviceId || left.sourceDeviceId === right.targetDeviceId)) return true;
  if (left.targetDeviceId !== null
    && (left.targetDeviceId === right.sourceDeviceId || left.targetDeviceId === right.targetDeviceId)) return true;
  // A route occupying the cell beside a failed path can block its only turn
  // just as effectively as a route sharing a connector cell. Include the
  // orthogonal one-cell corridor so progressive rip-up reaches physical
  // blockers instead of expanding only through shared device endpoints.
  const rightCorridor = new Set(right.points.flatMap((point) => [
    gridKey(point),
    `${point.x - 1},${point.y}`,
    `${point.x + 1},${point.y}`,
    `${point.x},${point.y - 1}`,
    `${point.x},${point.y + 1}`,
  ]));
  return left.points.some((point) => rightCorridor.has(gridKey(point)));
}

export interface BoundedCbsResult {
  readonly node: CbsNode | null;
  readonly exploredStates: number;
  readonly stoppedBy: "solved" | "exhausted" | "max-states" | "time-budget";
}

/** Deterministic CBS over precomputed route alternatives for a small conflict group. */
export function boundedCbs(options: {
  readonly candidatesByConnectionId: Readonly<Record<string, readonly (readonly GridPoint[])[]>>;
  readonly config: Pick<RipUpConfig, "maxConnections" | "maxCbsDepth" | "maxCbsStates" | "timeBudgetMs">;
}): BoundedCbsResult {
  const connectionIds = Object.keys(options.candidatesByConnectionId).sort();
  if (connectionIds.length === 0 || connectionIds.length > options.config.maxConnections) {
    return { node: null, exploredStates: 0, stoppedBy: "exhausted" };
  }
  const choosePath = (id: string, constraints: readonly CbsConstraint[]): readonly GridPoint[] | null => {
    const forbidden = new Set(constraints.filter((constraint) => constraint.connectionId === id)
      .map((constraint) => `${constraint.x},${constraint.y}`));
    return (options.candidatesByConnectionId[id] ?? [])
      .filter((path) => !path.some((point) => forbidden.has(gridKey(point))))
      .sort(compareRoute)[0] ?? null;
  };
  const rootPaths: Record<string, readonly GridPoint[]> = {};
  for (const id of connectionIds) {
    const path = choosePath(id, []);
    if (path === null) return { node: null, exploredStates: 0, stoppedBy: "exhausted" };
    rootPaths[id] = path;
  }
  const makeNode = (constraints: readonly CbsConstraint[], depth: number): CbsNode | null => {
    const pathsByConnectionId: Record<string, readonly GridPoint[]> = {};
    for (const id of connectionIds) {
      const path = choosePath(id, constraints);
      if (path === null) return null;
      pathsByConnectionId[id] = path;
    }
    return {
      pathsByConnectionId,
      constraints,
      cost: Object.values(pathsByConnectionId).reduce((sum, path) => sum + path.length, 0),
      depth,
    };
  };
  const root = makeNode([], 0)!;
  const queue: CbsNode[] = [root];
  const visited = new Set<string>();
  const startedAt = Date.now();
  let exploredStates = 0;
  while (queue.length > 0) {
    if (Date.now() - startedAt >= options.config.timeBudgetMs) {
      return { node: null, exploredStates, stoppedBy: "time-budget" };
    }
    if (exploredStates >= options.config.maxCbsStates) {
      return { node: null, exploredStates, stoppedBy: "max-states" };
    }
    queue.sort(compareCbsNodes);
    const node = queue.shift()!;
    const signature = cbsNodeSignature(node);
    if (visited.has(signature)) continue;
    visited.add(signature);
    exploredStates += 1;
    const conflict = findCbsConflict(node.pathsByConnectionId);
    if (conflict === null) return { node, exploredStates, stoppedBy: "solved" };
    if (node.depth >= options.config.maxCbsDepth) continue;
    for (const connectionId of [conflict.leftId, conflict.rightId].sort()) {
      const child = makeNode([
        ...node.constraints,
        { connectionId, x: conflict.point.x, y: conflict.point.y },
      ], node.depth + 1);
      if (child !== null) queue.push(child);
    }
  }
  return { node: null, exploredStates, stoppedBy: "exhausted" };
}

function findCbsConflict(paths: CbsNode["pathsByConnectionId"]): {
  readonly leftId: string;
  readonly rightId: string;
  readonly point: GridPoint;
} | null {
  const ids = Object.keys(paths).sort();
  for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
    const leftId = ids[leftIndex]!;
    const leftCells = new Set((paths[leftId] ?? []).slice(1, -1).map(gridKey));
    for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
      const rightId = ids[rightIndex]!;
      const conflictPoint = (paths[rightId] ?? []).slice(1, -1)
        .find((point) => leftCells.has(gridKey(point)));
      if (conflictPoint !== undefined) return { leftId, rightId, point: conflictPoint };
    }
  }
  return null;
}

function compareCbsNodes(left: CbsNode, right: CbsNode): number {
  return left.cost - right.cost || left.depth - right.depth
    || cbsNodeSignature(left).localeCompare(cbsNodeSignature(right));
}

function cbsNodeSignature(node: CbsNode): string {
  return node.constraints.map((constraint) =>
    `${constraint.connectionId}@${constraint.x},${constraint.y}`).sort().join("|");
}

function routeMaterialFlow(options: {
  readonly request: HeadlessOptimizationRequest;
  readonly registry: RegistryContract;
  readonly requests: readonly DeviceRequest[];
  readonly productionDevices: readonly HeadlessPlacedDevice[];
  readonly productionEntities: Readonly<Record<string, WorldEntity>>;
  readonly routingVariant: number;
  readonly prioritizeFanoutGroups?: boolean;
  readonly preferFirstFeasibleRoute?: boolean;
  /** Let joint rerouting reassign any free sibling port instead of a monotone band. */
  readonly relaxPortBandAssignment?: boolean;
  /** Pin selected rerouted connections to an exact target-port outside cell. */
  readonly forcedTargetPortGridKeyByConnectionId?: ReadonlyMap<string, string>;
  readonly previousRouting?: RoutingResult;
  readonly previousProductionDevices?: readonly HeadlessPlacedDevice[];
  readonly movedDeviceIds?: ReadonlySet<string>;
  readonly forcedRipUpConnectionIds?: ReadonlySet<string>;
  readonly priorityConnectionKeys?: readonly string[];
  /** Maximum explicit rip-up set that may still preserve unaffected old routes. */
  readonly preservationConnectionLimit?: number;
  readonly enforceFrontageConstraint?: boolean;
  readonly freezeFlowAllocation?: boolean;
  /** Allow hard certificates only when this call uses the authoritative full grid. */
  readonly enablePlacementConflictCertificates?: boolean;
  /** Observe endpoint pairs rejected by the relaxed equipment-wall funnel. */
  readonly onRelaxedConnectivityRejected?: (count: number) => void;
  /**
   * Optional complete production graph used to keep producer/consumer
   * allocation stable while routing a partially placed topology prefix.
   */
  readonly flowAllocationRequests?: readonly DeviceRequest[];
}): RoutingResult {
  const definitionMap = createEntityDefinitionMap(options.registry.entityDefinitions);
  const requestById = new Map(options.requests.map((request) => [request.id, request]));
  const deviceById = new Map(options.productionDevices.map((device) => [device.id, device]));
  const blocked = new Set<string>();
  for (const device of options.productionDevices) {
    addRectangleCells(blocked, device.position.x, device.position.y, device.width, device.height);
  }
  const frontageBlocked = new Set(blocked);
  if (options.enforceFrontageConstraint === true) {
    const unloaders = options.productionDevices.filter((device) => device.kind === "warehouse-port");
    if (unloaders.length >= 1) {
      const minX = Math.min(...unloaders.map((device) => device.position.x));
      const minY = Math.min(...unloaders.map((device) => device.position.y));
      const maxX = Math.max(...unloaders.map((device) => device.position.x + device.width));
      const maxY = Math.max(...unloaders.map((device) => device.position.y + device.height));
      const verticalFrontage = maxY - minY >= maxX - minX;
      const start = verticalFrontage ? minY : minX;
      const end = verticalFrontage ? maxY : maxX;
      for (let y = 0; y < options.request.height; y += 1) {
        for (let x = 0; x < options.request.width; x += 1) {
          const coordinate = verticalFrontage ? y : x;
          if (coordinate < start || coordinate >= end) frontageBlocked.add(`${x},${y}`);
        }
      }
    }
  }
  // The equipment/frontage obstacle grid is immutable for this routing call.
  // Build its relaxed connected components once and reuse them for every
  // connection and port pair; this is a necessary-condition funnel only, so
  // strict A* still decides every pair that may be feasible.
  const connectionBlocked = options.enforceFrontageConstraint === true
    ? frontageBlocked
    : blocked;
  const relaxedRouteConnectivity = buildRelaxedRouteConnectivity(
    options.request.width,
    options.request.height,
    connectionBlocked,
  );
  const routedCells = new Set<string>();
  const routedCellOccupations = new Map<string, RoutedCellOccupation>();
  const usedPorts = new Set<string>();
  const logisticsEntities: Record<string, WorldEntity> = {};
  const logisticsDevices: HeadlessPlacedDevice[] = [];
  const connections: RoutedConnection[] = [];
  const areaExcludedDeviceIds = new Set<string>();
  const plannedConnections: Array<{
    itemId: string;
    perMinute: number;
    sourceDeviceId: string | null;
    targetDeviceId: string | null;
  }> = [];
  let internalConnectionCount = 0;
  let boundaryConnectionCount = 0;

  const worldDocument = createRoutingDocument(options.request, options.productionEntities);
  const producersByItem = new Map<string, MaterialEndpoint[]>();
  const consumersByItem = new Map<string, MaterialEndpoint[]>();
  const allocationRequests = options.flowAllocationRequests ?? options.requests;
  const allocationFrozen = options.freezeFlowAllocation === true
    || options.flowAllocationRequests !== undefined;
  for (const request of allocationRequests) {
    for (const [itemId, perMinute] of request.outputs) {
      appendMaterialEndpointLanes(
        producersByItem,
        request,
        itemId,
        perMinute,
        resolveLogisticsLaneCapacityPerMinute(itemId, options.registry),
      );
    }
    for (const [itemId, perMinute] of request.inputs) {
      appendMaterialEndpointLanes(
        consumersByItem,
        request,
        itemId,
        perMinute,
        resolveLogisticsLaneCapacityPerMinute(itemId, options.registry),
      );
    }
  }

  const route = (input: {
    readonly id: string;
    readonly itemId: string;
    readonly perMinute: number;
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }): void => {
    const areaExcludedConnection = input.sourceDeviceId !== null
      && requestById.get(input.sourceDeviceId)?.definition.id === "item_port_unloader_1"
      && input.targetDeviceId !== null
      && requestById.get(input.targetDeviceId)?.kind === "production";
    const kind = resolveItemLogisticsKind(input.itemId, options.registry);
    let sourceCandidates = input.sourceDeviceId === null
      ? null
      : resolveUnusedPorts(input.sourceDeviceId, "output", kind, usedPorts);
    let targetCandidates = input.targetDeviceId === null
      ? null
      : resolveUnusedPorts(input.targetDeviceId, "input", kind, usedPorts);
    const forcedTargetPortGridKey =
      options.forcedTargetPortGridKeyByConnectionId?.get(input.id);
    if (targetCandidates !== null && forcedTargetPortGridKey !== undefined) {
      targetCandidates = targetCandidates.filter((candidate) =>
        gridKey(candidate.outsideGridPoint) === forcedTargetPortGridKey);
    }
    if (
      input.sourceDeviceId !== null
      && input.targetDeviceId !== null
      && sourceCandidates !== null
      && options.routingVariant >= 3
      && options.relaxPortBandAssignment !== true
    ) {
      const consumerIds = [...new Set(plannedConnections
        .filter((connection) => connection.sourceDeviceId === input.sourceDeviceId
          && connection.itemId === input.itemId
          && connection.targetDeviceId !== null)
        .map((connection) => connection.targetDeviceId!))]
        .filter((id) => deviceById.has(id));
      if (consumerIds.length >= 2) {
        let allSourcePorts = resolveUnusedPorts(input.sourceDeviceId, "output", kind, new Set())
          .sort((left, right) => left.outsideGridPoint.x - right.outsideGridPoint.x
            || left.outsideGridPoint.y - right.outsideGridPoint.y
            || portKey(left).localeCompare(portKey(right)));
        const horizontalPortSpan = allSourcePorts.length < 2
          || allSourcePorts[0]!.outsideGridPoint.x
            !== allSourcePorts[allSourcePorts.length - 1]!.outsideGridPoint.x;
        // Order consumers along the physical source-port face. Comparing the
        // consumers' overall x/y span is unstable when some edges skip layers:
        // a large vertical distance must not reverse a horizontal port row.
        const consumersVaryHorizontally = horizontalPortSpan;
        if (options.routingVariant >= 9) {
          // High-numbered variants enumerate source/target port mirroring
          // independently: 0=none, 1=target, 2=source, 3=both. Coupling the
          // two mirrors made a fan-out route cross the still-unused adjacent
          // source port whenever only the source face needed reversing.
          if (options.routingVariant % 4 === 2
            || options.routingVariant % 4 === 3) {
            allSourcePorts = [...allSourcePorts].reverse();
          }
        } else if (Math.floor(options.routingVariant / 3) % 2 === 0) {
          allSourcePorts = [...allSourcePorts].reverse();
        }
        const orderedConsumerIds = consumerIds.sort((leftId, rightId) => {
          const leftCenter = deviceCenter(deviceById.get(leftId)!);
          const rightCenter = deviceCenter(deviceById.get(rightId)!);
          return (consumersVaryHorizontally ? leftCenter.x - rightCenter.x : leftCenter.y - rightCenter.y)
            || leftId.localeCompare(rightId);
        });
        const consumerRank = orderedConsumerIds.indexOf(input.targetDeviceId);
        if (consumerRank >= 0 && allSourcePorts.length > 0) {
          const portRank = Math.round(
            consumerRank * (allSourcePorts.length - 1) / (orderedConsumerIds.length - 1),
          );
          const assignedPort = allSourcePorts[portRank];
          if (assignedPort !== undefined
            && sourceCandidates.some((candidate) => portKey(candidate) === portKey(assignedPort))) {
            sourceCandidates = sourceCandidates.filter((candidate) =>
              portKey(candidate) === portKey(assignedPort));
          }
        }
      }
    }
    const producerIdsForTarget = input.targetDeviceId === null
      ? []
      : [...new Set(plannedConnections
        .filter((connection) => connection.targetDeviceId === input.targetDeviceId
          && connection.sourceDeviceId !== null)
        .map((connection) => connection.sourceDeviceId!))]
        .filter((id) => deviceById.has(id));
    if (
      input.sourceDeviceId !== null
      && input.targetDeviceId !== null
      && targetCandidates !== null
      && options.routingVariant >= 3
      && options.relaxPortBandAssignment !== true
      && producerIdsForTarget.length >= 2
    ) {
      const producerIds = producerIdsForTarget;
      let allTargetPorts = resolveUnusedPorts(input.targetDeviceId, "input", kind, new Set())
        .sort((left, right) => left.outsideGridPoint.x - right.outsideGridPoint.x
          || left.outsideGridPoint.y - right.outsideGridPoint.y
          || portKey(left).localeCompare(portKey(right)));
      const horizontalPortSpan = allTargetPorts.length < 2
        || allTargetPorts[0]!.outsideGridPoint.x !== allTargetPorts[allTargetPorts.length - 1]!.outsideGridPoint.x;
      // Match producer order to the target-port face, independently of layer
      // distance. This preserves monotone port assignment for skipped layers.
      const producersVaryHorizontally = horizontalPortSpan;
      if (options.routingVariant >= 9) {
        if (options.routingVariant % 4 === 1
          || options.routingVariant % 4 === 3) {
          allTargetPorts = [...allTargetPorts].reverse();
        }
      } else if (Math.floor(options.routingVariant / 3) % 2 === 0) {
        allTargetPorts = [...allTargetPorts].reverse();
      }
      const orderedProducerIds = [...producerIds].sort((leftId, rightId) => {
        const leftCenter = deviceCenter(deviceById.get(leftId)!);
        const rightCenter = deviceCenter(deviceById.get(rightId)!);
        return (producersVaryHorizontally ? leftCenter.x - rightCenter.x : leftCenter.y - rightCenter.y)
          || leftId.localeCompare(rightId);
      });
      const producerRank = orderedProducerIds.indexOf(input.sourceDeviceId);
      if (producerRank >= 0 && allTargetPorts.length > 0) {
        const bandStart = Math.floor(
          producerRank * allTargetPorts.length / orderedProducerIds.length,
        );
        const bandEnd = Math.max(
          bandStart,
          Math.floor((producerRank + 1) * allTargetPorts.length / orderedProducerIds.length) - 1,
        );
        const assignedPortKeys = new Set(
          allTargetPorts.slice(bandStart, bandEnd + 1).map(portKey),
        );
        const assignedCandidates = targetCandidates.filter((candidate) =>
          assignedPortKeys.has(portKey(candidate)));
        if (assignedCandidates.length > 0) {
          targetCandidates = assignedCandidates;
        }
      }
    }
    const contourRouting = createContourRoutingContext(
      options.request.width,
      options.request.height,
      new Set([...blocked, ...routedCells]),
    );
    const reservedPortCells = new Set<string>([
      ...(sourceCandidates ?? []).map((endpoint) => gridKey(endpoint.outsideGridPoint)),
      ...(targetCandidates ?? []).map((endpoint) => gridKey(endpoint.outsideGridPoint)),
    ]);
    // Port ranking may narrow the current connection to one assigned endpoint,
    // but the remaining unused ports on the same device still belong to later
    // fan-out/fan-in lanes. Keep their outside cells blocked so this route
    // cannot take a shortcut through a sibling port.
    if (input.sourceDeviceId !== null) {
      for (const endpoint of resolveUnusedPorts(
        input.sourceDeviceId,
        "output",
        kind,
        usedPorts,
      )) {
        reservedPortCells.add(gridKey(endpoint.outsideGridPoint));
      }
    }
    if (input.targetDeviceId !== null) {
      for (const endpoint of resolveUnusedPorts(
        input.targetDeviceId,
        "input",
        kind,
        usedPorts,
      )) {
        reservedPortCells.add(gridKey(endpoint.outsideGridPoint));
      }
    }
    const resolved = resolveBestRoute({
      width: options.request.width,
      height: options.request.height,
      blocked: connectionBlocked,
      routedCells,
      routedCellOccupations,
      reservedPortCells,
      directionOrder: options.routingVariant % 4,
      kind,
      sourceCandidates,
      targetCandidates,
      preferFirstFeasible: options.preferFirstFeasibleRoute === true,
      preferShortestPortPair: options.relaxPortBandAssignment === true,
      contourRouting,
      relaxedConnectivity: relaxedRouteConnectivity,
      onRelaxedConnectivityRejected: options.onRelaxedConnectivityRejected,
    });
    if (resolved === null) {
      const sourceLabel = input.sourceDeviceId ?? "boundary";
      const targetLabel = input.targetDeviceId ?? "boundary";
      const startPoint = sourceCandidates?.[0]?.outsideGridPoint
        ?? (input.sourceDeviceId !== null && deviceById.has(input.sourceDeviceId)
          ? (() => {
              const device = deviceById.get(input.sourceDeviceId)!;
              return { x: device.position.x, y: device.position.y };
            })()
          : { x: 0, y: 0 });
      const attemptedPortPairs = (sourceCandidates ?? []).flatMap((source) =>
        (targetCandidates ?? []).map((target) => ({
          sourceGridPoint: { ...source.outsideGridPoint },
          targetGridPoint: { ...target.outsideGridPoint },
        })))
        .sort((left, right) =>
          left.sourceGridPoint.y - right.sourceGridPoint.y
          || left.sourceGridPoint.x - right.sourceGridPoint.x
          || left.targetGridPoint.y - right.targetGridPoint.y
          || left.targetGridPoint.x - right.targetGridPoint.x)
        .slice(0, MAX_ATTEMPTED_PORT_PAIRS);
      const failureEvidence = collectRouteFailureEvidence({
        start: startPoint,
        width: options.request.width,
        height: options.request.height,
        blocked: connectionBlocked,
        routedCellOccupations,
        productionDevices: options.productionDevices,
        kind,
      });
      // Keep proof endpoint sets independent of greedy port allocation. A hard
      // placement cut additionally requires a frozen producer/consumer lane
      // graph: if allocation is geometry-dependent, another assignment could
      // remove the failed connection without changing any certified pose.
      const placementProofSourceGridPoints = input.sourceDeviceId === null
        ? null
        : resolveUnusedPorts(input.sourceDeviceId, "output", kind, new Set())
          .map((endpoint) => endpoint.outsideGridPoint);
      const placementProofTargetGridPoints = input.targetDeviceId === null
        ? null
        : resolveUnusedPorts(input.targetDeviceId, "input", kind, new Set())
          .map((endpoint) => endpoint.outsideGridPoint);
      const mayGenerateHardCertificate = allocationFrozen
        && options.enablePlacementConflictCertificates === true;
      const placementConflict = mayGenerateHardCertificate
        ? proveRoutePlacementConflict({
            width: options.request.width,
            height: options.request.height,
            blocked: connectionBlocked,
            productionDevices: options.productionDevices,
            sourceDeviceId: input.sourceDeviceId,
            targetDeviceId: input.targetDeviceId,
            sourceGridPoints: placementProofSourceGridPoints,
            targetGridPoints: placementProofTargetGridPoints,
          })
        : null;
      const capacityConflict = mayGenerateHardCertificate
        ? (() => {
            const lanes = identifiedPlannedConnections.map((planned) => {
              const plannedKind = resolveItemLogisticsKind(planned.itemId, options.registry);
              return {
                id: planned.id,
                sourceDeviceId: planned.sourceDeviceId,
                targetDeviceId: planned.targetDeviceId,
                sourceGridPoints: planned.sourceDeviceId === null
                  ? null
                  : resolveUnusedPorts(planned.sourceDeviceId, "output", plannedKind, new Set())
                    .map((endpoint) => endpoint.outsideGridPoint),
                targetGridPoints: planned.targetDeviceId === null
                  ? null
                  : resolveUnusedPorts(planned.targetDeviceId, "input", plannedKind, new Set())
                    .map((endpoint) => endpoint.outsideGridPoint),
              };
            });
            const proofOptions = {
              width: options.request.width,
              height: options.request.height,
              blocked: connectionBlocked,
              productionDevices: options.productionDevices,
              lanes,
            };
            return proveRouteCutCapacityConflict(proofOptions)
              ?? proveRouteGeneralCutCapacityConflict({
                ...proofOptions,
                preferredLaneId: input.id,
              });
          })()
        : null;
      const evidence: RouteFailureEvidence = {
        itemId: input.itemId,
        sourceDeviceId: input.sourceDeviceId,
        targetDeviceId: input.targetDeviceId,
        kind: kind === "belt" ? "belt" : "pipe",
        attemptedPortPairs,
        ...failureEvidence,
        placementConflict,
        capacityConflict,
      };
      throw new RouteFailureError(
        evidence,
        `Unable to route ${kind} for ${input.itemId}: ${sourceLabel} -> ${targetLabel}. `
        + `Available ports: source=${sourceCandidates?.length ?? "boundary"}, `
        + `target=${targetCandidates?.length ?? "boundary"}. `
        + `Endpoints: source=${JSON.stringify(sourceCandidates?.map((endpoint) => endpoint.outsideGridPoint) ?? null)}, `
        + `target=${JSON.stringify(targetCandidates?.map((endpoint) => endpoint.outsideGridPoint) ?? null)}. `
        + `Completed connections: ${connections.length}/${plannedConnections.length}. `
        + "Increase the requested range/routingClearance or choose a recipe with enough ports.",
      );
    }

    commitResolvedRoute(input, resolved, areaExcludedConnection);
  };

  function commitResolvedRoute(input: {
    readonly id: string;
    readonly itemId: string;
    readonly perMinute: number;
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }, resolved: {
    readonly source: DevicePortEndpoint | null;
    readonly target: DevicePortEndpoint | null;
    readonly points: readonly GridPoint[];
  }, areaExcludedConnection: boolean): void {
    const kind = resolveItemLogisticsKind(input.itemId, options.registry);
    if (resolved.source !== null) usedPorts.add(portKey(resolved.source));
    if (resolved.target !== null) usedPorts.add(portKey(resolved.target));
    const sourceEndpoint: LogisticsDraftEndpoint = resolved.source ?? {
      type: "empty-cell",
      gridPoint: { ...resolved.points[0]! },
    };
    const targetEndpoint: LogisticsDraftEndpoint = resolved.target ?? {
      type: "empty-cell",
      gridPoint: { ...resolved.points[resolved.points.length - 1]! },
    };
    const cells = resolveLogisticsPathCells({
      kind,
      points: resolved.points,
      source: sourceEndpoint,
      target: targetEndpoint,
      document: worldDocument,
      entityDefinitionMap: definitionMap,
      replacingEntity: null,
      replacingDefinition: null,
    });
    const connectionIndex = connections.length + 1;
    for (const [cellIndex, cell] of cells.entries()) {
      const cellKey = gridKey(cell.gridPoint);
      const existingOccupation = routedCellOccupations.get(cellKey);
      if (existingOccupation !== undefined) {
        const crossingAxis = pathCellAxis(cell);
        if (
          crossingAxis === null
          || existingOccupation.axis === null
          || crossingAxis === existingOccupation.axis
          || existingOccupation.kind !== kind
          || existingOccupation.crossed
        ) {
          throw new Error(`Invalid logistics crossing at ${cellKey}`);
        }
        const connectorDefinitionId = kind === "belt" ? "item_log_connector" : "item_pipe_connector";
        const previous = logisticsEntities[existingOccupation.entityId];
        if (previous === undefined) throw new Error(`Missing crossing entity ${existingOccupation.entityId}`);
        logisticsEntities[existingOccupation.entityId] = {
          ...previous,
          definitionId: connectorDefinitionId,
          rotation: 0,
          tags: [...previous.tags, `connection:${input.id}`, "logistics:crossing"],
        };
        const deviceIndex = logisticsDevices.findIndex((device) => device.id === existingOccupation.entityId);
        const previousDevice = logisticsDevices[deviceIndex];
        if (previousDevice !== undefined) {
          logisticsDevices[deviceIndex] = {
            ...previousDevice,
            definitionId: connectorDefinitionId,
            rotation: 0,
          };
        }
        existingOccupation.crossed = true;
        if (!areaExcludedConnection) areaExcludedDeviceIds.delete(existingOccupation.entityId);
        continue;
      }
      const id = `log-${connectionIndex}-${cellIndex + 1}`;
      const definitionId = resolveLogisticsDefinitionId({ kind, shape: cell.shape });
      const definition = definitionMap.get(definitionId);
      logisticsEntities[id] = {
        id,
        definitionId,
        position: { ...cell.gridPoint },
        rotation: cell.rotation,
        config: cloneRecord(definition?.placementDefaults?.config) ?? {},
        tags: [
          "headless-optimized",
          `logistics:${kind}`,
          `item:${input.itemId}`,
          `connection:${input.id}`,
        ],
      };
      logisticsDevices.push({
        id,
        definitionId,
        kind,
        recipeId: null,
        position: { ...cell.gridPoint },
        rotation: cell.rotation,
        width: 1,
        height: 1,
      });
      routedCells.add(cellKey);
      routedCellOccupations.set(cellKey, {
        entityId: id,
        kind,
        axis: pathCellAxis(cell),
        crossed: false,
      });
      if (areaExcludedConnection) areaExcludedDeviceIds.add(id);
    }
    connections.push({
      id: input.id,
      itemId: input.itemId,
      kind,
      perMinute: input.perMinute,
      sourceDeviceId: input.sourceDeviceId,
      targetDeviceId: input.targetDeviceId,
      points: resolved.points,
    });
    if (process.env["INDUSTRIAL_PLANNER_TRACE_WAREHOUSE_CLUSTER"] === "1") {
      console.error(
        `[warehouse-supply-route:${connections.length}/${plannedConnections.length}] `
        + `${input.sourceDeviceId ?? "boundary"}->${input.targetDeviceId ?? "boundary"} `
        + `${JSON.stringify(resolved.points)}`,
      );
    }
    if (input.sourceDeviceId !== null && input.targetDeviceId !== null) {
      internalConnectionCount += 1;
    } else {
      boundaryConnectionCount += 1;
    }
  }

  const itemIds = new Set([...producersByItem.keys(), ...consumersByItem.keys()]);
  for (const itemId of [...itemIds].sort()) {
    const producers = producersByItem.get(itemId) ?? [];
    const consumers = consumersByItem.get(itemId) ?? [];
    if (allocationFrozen) {
      producers.sort((left, right) => left.request.id.localeCompare(right.request.id));
      consumers.sort((left, right) => left.request.id.localeCompare(right.request.id));
    }
    const stableProducerIds = producers.map((producer) => producer.request.id).sort();
    const producerRotationOffset = options.routingVariant >= 14
      ? (options.routingVariant - 13) % Math.max(1, stableProducerIds.length)
      : 0;
    for (const consumer of consumers) {
      const producerMatchPriority = (producer: MaterialEndpoint): number => {
        if (producer.request.definition.id !== "item_port_unloader_1") return 0;
        return producer.request.warehouseConsumerId === consumer.request.id ? 1 : 2;
      };
      while (consumer.remainingPerMinute > 0.000001) {
        const producer = producers
          .filter((candidate) => candidate.remainingPerMinute > 0.000001)
          .sort((left, right) => {
            const isReciprocal = (candidate: MaterialEndpoint): boolean =>
              plannedConnections.some((connection) =>
                connection.sourceDeviceId === consumer.request.id
                && connection.targetDeviceId === candidate.request.id);
            const reciprocalDifference = Number(isReciprocal(right)) - Number(isReciprocal(left));
            if (reciprocalDifference !== 0) return reciprocalDifference;
            const priorityDifference = producerMatchPriority(left) - producerMatchPriority(right);
            if (priorityDifference !== 0) return priorityDifference;
            if (!allocationFrozen) {
              // A logistics lane terminates at one physical input port. Prefer
              // a producer lane that can satisfy it atomically when allocation
              // is free. A graph-based baseline instead retains its previously
              // constructed producer/consumer assignment exactly.
              const leftCanFillLane = left.remainingPerMinute + 0.000001
                >= consumer.remainingPerMinute;
              const rightCanFillLane = right.remainingPerMinute + 0.000001
                >= consumer.remainingPerMinute;
              if (leftCanFillLane !== rightCanFillLane) {
                return leftCanFillLane ? -1 : 1;
              }
            }
            if (!allocationFrozen
              && options.routingVariant >= 14 && stableProducerIds.length > 1) {
              const cyclicRank = (producer: MaterialEndpoint): number => {
                const index = stableProducerIds.indexOf(producer.request.id);
                return (index - producerRotationOffset + stableProducerIds.length)
                  % stableProducerIds.length;
              };
              return cyclicRank(left) - cyclicRank(right);
            }
            // Two variants enforce nearest-port allocation. The third retains a
            // deterministic stable allocation as a congestion fallback; this
            // lets compact layouts survive when greedy nearest pairs cross and
            // block one another, while nearest remains the default strategy.
            if (allocationFrozen
              || options.routingVariant % 3 === 2) {
              return left.request.id.localeCompare(right.request.id);
            }
            const distanceDifference = estimatePortDistance(
              left.request.id,
              consumer.request.id,
              itemId,
            ) - estimatePortDistance(right.request.id, consumer.request.id, itemId);
            return distanceDifference || left.request.id.localeCompare(right.request.id);
          })[0];
        if (producer === undefined) break;
        const transferred = Math.min(producer.remainingPerMinute, consumer.remainingPerMinute);
        plannedConnections.push({
          itemId,
          perMinute: transferred,
          sourceDeviceId: producer.request.id,
          targetDeviceId: consumer.request.id,
        });
        producer.remainingPerMinute -= transferred;
        consumer.remainingPerMinute -= transferred;
      }
      if (consumer.remainingPerMinute > 0.000001) {
        plannedConnections.push({
          itemId,
          perMinute: consumer.remainingPerMinute,
          sourceDeviceId: null,
          targetDeviceId: consumer.request.id,
        });
        consumer.remainingPerMinute = 0;
      }

    }
  }

  const targetItemIds = new Set(options.request.targets.map((target) => target.itemId));
  for (const itemId of [...targetItemIds].sort()) {
    for (const producer of producersByItem.get(itemId) ?? []) {
      if (producer.remainingPerMinute <= 0.000001) continue;
      plannedConnections.push({
        itemId,
        perMinute: producer.remainingPerMinute,
        sourceDeviceId: producer.request.id,
        targetDeviceId: null,
      });
      producer.remainingPerMinute = 0;
    }
  }

  if (options.flowAllocationRequests !== undefined) {
    const activeConnections = plannedConnections.filter((connection) =>
      (connection.sourceDeviceId === null || requestById.has(connection.sourceDeviceId))
      && (connection.targetDeviceId === null || requestById.has(connection.targetDeviceId)));
    plannedConnections.splice(0, plannedConnections.length, ...activeConnections);
  }

  const hasMultiProducerInput = (targetDeviceId: string | null): boolean =>
    targetDeviceId !== null
    && new Set(plannedConnections
      .filter((connection) => connection.targetDeviceId === targetDeviceId
        && connection.sourceDeviceId !== null)
      .map((connection) => connection.sourceDeviceId)).size >= 2;

  plannedConnections.sort((left, right) => {
    const priorityRank = (connection: typeof left): number => {
      const key = routeConnectionKey(connection);
      const index = options.priorityConnectionKeys?.indexOf(key) ?? -1;
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    const forcedPriorityDifference = priorityRank(left) - priorityRank(right);
    if (forcedPriorityDifference !== 0) return forcedPriorityDifference;
    if (options.routingVariant >= 6 && options.prioritizeFanoutGroups === true) {
      // Establish the least-flexible local skeleton before long fan-out paths.
      // Adjacent warehouse feeds and producer/consumer pairs often have one
      // natural lane; routing a flexible long connection first can cut that
      // lane even though every individual A* path is locally shortest.
      const leftBoundary = Number(left.sourceDeviceId === null || left.targetDeviceId === null);
      const rightBoundary = Number(right.sourceDeviceId === null || right.targetDeviceId === null);
      const boundaryDifference = leftBoundary - rightBoundary;
      if (boundaryDifference !== 0) return boundaryDifference;
      if (options.routingVariant >= 33) {
        // Adjacent ports may share the same outside grid cell. That cell is a
        // complete zero-length connection, not spare corridor capacity. Route
        // such edges first so another long belt cannot make an otherwise valid
        // device placement unroutable.
        const directPriorityDifference = compareZeroLengthRoutePriority(
          approximateConnectionDistance(left),
          approximateConnectionDistance(right),
        );
        if (directPriorityDifference !== 0) return directPriorityDifference;
      }
      if (options.routingVariant >= 32) {
        const reciprocalPriority = (connection: typeof left): number =>
          Number(!(connection.sourceDeviceId !== null
            && connection.targetDeviceId !== null
            && plannedConnections.some((other) =>
              other.sourceDeviceId === connection.targetDeviceId
              && other.targetDeviceId === connection.sourceDeviceId)));
        const reciprocalDifference = reciprocalPriority(left) - reciprocalPriority(right);
        if (reciprocalDifference !== 0) return reciprocalDifference;
        const leftDistance = approximateConnectionDistance(left);
        const rightDistance = approximateConnectionDistance(right);
        if (leftDistance !== rightDistance) return rightDistance - leftDistance;
      } else if (options.routingVariant >= 31) {
        // A topological baseline can contain edges that skip one or more
        // device layers. Establish those scarce long corridors before local
        // cycle and adjacent-layer routes consume them. This depends only on
        // geometry and applies to any process graph.
        const leftDistance = approximateConnectionDistance(left);
        const rightDistance = approximateConnectionDistance(right);
        if (leftDistance !== rightDistance) return rightDistance - leftDistance;
        const constraintDifference = connectionPortChoices(left) - connectionPortChoices(right);
        if (constraintDifference !== 0) return constraintDifference;
      } else if (options.routingVariant >= 29) {
        // In a hard-frontage packing, reserve the scarce fan-out lanes before
        // flexible warehouse feeders. This complements variants 27/28, which
        // establish the feeder skeleton first.
        const hardFrontageFanoutPriority = (connection: typeof left): number => {
          const source = connection.sourceDeviceId === null
            ? undefined
            : requestById.get(connection.sourceDeviceId);
          if (source !== undefined && hasMultiConsumerOutput(source, options.requests)) return 0;
          const target = connection.targetDeviceId === null
            ? undefined
            : requestById.get(connection.targetDeviceId);
          if (target !== undefined && hasMultiConsumerOutput(target, options.requests)) return 1;
          if (hasMultiProducerInput(connection.targetDeviceId)) return 2;
          if (source?.definition.id === "item_port_unloader_1") return 3;
          return 4;
        };
        const fanoutDifference = hardFrontageFanoutPriority(left) - hardFrontageFanoutPriority(right);
        if (fanoutDifference !== 0) return fanoutDifference;
      } else if (options.routingVariant >= 27) {
        const anchoredFeederPriority = (connection: typeof left): number => {
          const source = connection.sourceDeviceId === null
            ? undefined
            : requestById.get(connection.sourceDeviceId);
          if (source?.definition.id === "item_port_unloader_1") return 0;
          const target = connection.targetDeviceId === null
            ? undefined
            : requestById.get(connection.targetDeviceId);
          if (target !== undefined && hasMultiConsumerOutput(target, options.requests)) return 1;
          const isReciprocal = connection.sourceDeviceId !== null
            && connection.targetDeviceId !== null
            && plannedConnections.some((other) =>
              other.sourceDeviceId === connection.targetDeviceId
              && other.targetDeviceId === connection.sourceDeviceId);
          if (isReciprocal) return 2;
          if (source !== undefined && hasMultiConsumerOutput(source, options.requests)) return 3;
          if (hasMultiProducerInput(connection.targetDeviceId)) return 4;
          return 5;
        };
        const anchoredDifference = anchoredFeederPriority(left) - anchoredFeederPriority(right);
        if (anchoredDifference !== 0) return anchoredDifference;
      } else if (options.routingVariant >= 26) {
        const fanoutFeederPriority = (connection: typeof left): number => {
          const target = connection.targetDeviceId === null
            ? undefined
            : requestById.get(connection.targetDeviceId);
          if (target !== undefined && hasMultiConsumerOutput(target, options.requests)) return 0;
          const isReciprocal = connection.sourceDeviceId !== null
            && connection.targetDeviceId !== null
            && plannedConnections.some((other) =>
              other.sourceDeviceId === connection.targetDeviceId
              && other.targetDeviceId === connection.sourceDeviceId);
          if (isReciprocal) return 1;
          const source = connection.sourceDeviceId === null
            ? undefined
            : requestById.get(connection.sourceDeviceId);
          if (source !== undefined && hasMultiConsumerOutput(source, options.requests)) return 2;
          if (hasMultiProducerInput(connection.targetDeviceId)) return 3;
          return 4;
        };
        const feederDifference = fanoutFeederPriority(left) - fanoutFeederPriority(right);
        if (feederDifference !== 0) return feederDifference;
      } else if (options.routingVariant >= 19) {
        const faninSkeletonPriority = (connection: typeof left): number => {
          if (hasMultiProducerInput(connection.targetDeviceId)) return 0;
          const isReciprocal = connection.sourceDeviceId !== null
            && connection.targetDeviceId !== null
            && plannedConnections.some((other) =>
              other.sourceDeviceId === connection.targetDeviceId
              && other.targetDeviceId === connection.sourceDeviceId);
          if (isReciprocal) return 1;
          const source = connection.sourceDeviceId === null
            ? undefined
            : requestById.get(connection.sourceDeviceId);
          if (source !== undefined && hasMultiConsumerOutput(source, options.requests)) return 2;
          return 3;
        };
        const faninDifference = faninSkeletonPriority(left) - faninSkeletonPriority(right);
        if (faninDifference !== 0) return faninDifference;
        if (left.targetDeviceId !== null && left.targetDeviceId === right.targetDeviceId) {
          if (hasMultiProducerInput(left.targetDeviceId)) {
            const farthestFirst = approximateConnectionDistance(right)
              - approximateConnectionDistance(left);
            if (farthestFirst !== 0) return farthestFirst;
          }
        }
      } else if (options.routingVariant >= 13) {
        const skeletonPriority = (connection: typeof left): number => {
          const isReciprocal = connection.sourceDeviceId !== null
            && connection.targetDeviceId !== null
            && plannedConnections.some((other) =>
              other.sourceDeviceId === connection.targetDeviceId
              && other.targetDeviceId === connection.sourceDeviceId);
          if (isReciprocal) return 0;
          const source = connection.sourceDeviceId === null
            ? undefined
            : requestById.get(connection.sourceDeviceId);
          if (source !== undefined && hasMultiConsumerOutput(source, options.requests)) return 1;
          return 2;
        };
        const skeletonDifference = skeletonPriority(left) - skeletonPriority(right);
        if (skeletonDifference !== 0) return skeletonDifference;
        const leftReciprocal = left.sourceDeviceId !== null
          && left.targetDeviceId !== null
          && plannedConnections.some((other) =>
            other.sourceDeviceId === left.targetDeviceId
            && other.targetDeviceId === left.sourceDeviceId);
        const rightReciprocal = right.sourceDeviceId !== null
          && right.targetDeviceId !== null
          && plannedConnections.some((other) =>
            other.sourceDeviceId === right.targetDeviceId
            && other.targetDeviceId === right.sourceDeviceId);
        if (leftReciprocal && rightReciprocal) {
          // In an SCC, reserve the long return corridor before placing the
          // adjacent direct edge. Otherwise the short path can consume the
          // only boundary lane and make a graph-correct cycle unroutable.
          const farthestReturnFirst = approximateConnectionDistance(right)
            - approximateConnectionDistance(left);
          if (farthestReturnFirst !== 0) return farthestReturnFirst;
        }
      }
      const leftReciprocal = left.sourceDeviceId !== null
        && left.targetDeviceId !== null
        && plannedConnections.some((other) =>
          other.sourceDeviceId === left.targetDeviceId
          && other.targetDeviceId === left.sourceDeviceId);
      const rightReciprocal = right.sourceDeviceId !== null
        && right.targetDeviceId !== null
        && plannedConnections.some((other) =>
          other.sourceDeviceId === right.targetDeviceId
          && other.targetDeviceId === right.sourceDeviceId);
      if (leftReciprocal && rightReciprocal) {
        const farthestReturnFirst = approximateConnectionDistance(right)
          - approximateConnectionDistance(left);
        if (farthestReturnFirst !== 0) return farthestReturnFirst;
      }
      const constraintDifference = connectionPortChoices(left) - connectionPortChoices(right);
      const distanceDifference = approximateConnectionDistance(left) - approximateConnectionDistance(right);
      if (options.routingVariant >= 12) {
        if (constraintDifference !== 0) return constraintDifference;
        if (distanceDifference !== 0) return distanceDifference;
      } else {
        if (distanceDifference !== 0) return distanceDifference;
        if (constraintDifference !== 0) return constraintDifference;
      }
      const leftKey = `${left.itemId}:${left.sourceDeviceId ?? ""}->${left.targetDeviceId ?? ""}`;
      const rightKey = `${right.itemId}:${right.sourceDeviceId ?? ""}->${right.targetDeviceId ?? ""}`;
      return options.routingVariant % 2 === 0
        ? leftKey.localeCompare(rightKey)
        : rightKey.localeCompare(leftKey);
    }
    if (options.routingVariant >= 3 && options.prioritizeFanoutGroups === true) {
      const groupedPriority = (connection: typeof left): number => {
        const source = connection.sourceDeviceId === null
          ? undefined
          : requestById.get(connection.sourceDeviceId);
        if (source !== undefined && hasMultiConsumerOutput(source, options.requests)) return 0;
        if (hasMultiProducerInput(connection.targetDeviceId)) return 1;
        return 2;
      };
      const groupedDifference = groupedPriority(left) - groupedPriority(right);
      if (groupedDifference !== 0) return groupedDifference;
    }
    const leftPriority = connectionRoutingPriority(left);
    const rightPriority = connectionRoutingPriority(right);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftSourceRequest = left.sourceDeviceId === null ? undefined : requestById.get(left.sourceDeviceId);
    const rightSourceRequest = right.sourceDeviceId === null ? undefined : requestById.get(right.sourceDeviceId);
    if (
      leftSourceRequest?.definition.id === "item_port_unloader_1"
      && rightSourceRequest?.definition.id === "item_port_unloader_1"
    ) {
      const leftX = left.targetDeviceId === null
        ? Number.MAX_SAFE_INTEGER
        : deviceCenter(deviceById.get(left.targetDeviceId)!).x;
      const rightX = right.targetDeviceId === null
        ? Number.MAX_SAFE_INTEGER
        : deviceCenter(deviceById.get(right.targetDeviceId)!).x;
      const spatialDifference = leftX - rightX;
      if (spatialDifference !== 0) {
        const spatialMode = Math.floor(options.routingVariant / 3);
        if (spatialMode === 1) return -spatialDifference;
        if (spatialMode === 2) {
          const centerX = options.request.width / 2;
          return Math.abs(rightX - centerX) - Math.abs(leftX - centerX) || spatialDifference;
        }
        return spatialDifference;
      }
    }
    if (
      left.sourceDeviceId !== null
      && left.sourceDeviceId === right.sourceDeviceId
      && left.targetDeviceId !== null
      && right.targetDeviceId !== null
      && options.routingVariant >= 3
      && hasMultiConsumerOutput(requestById.get(left.sourceDeviceId)!, options.requests)
    ) {
      const leftCenter = deviceCenter(deviceById.get(left.targetDeviceId)!);
      const rightCenter = deviceCenter(deviceById.get(right.targetDeviceId)!);
      const sourceCenter = deviceCenter(deviceById.get(left.sourceDeviceId)!);
      if (options.routingVariant % 3 === 1) return rightCenter.x - leftCenter.x;
      if (options.routingVariant % 3 === 2) {
        return Math.abs(leftCenter.x - sourceCenter.x) - Math.abs(rightCenter.x - sourceCenter.x)
          || leftCenter.x - rightCenter.x;
      }
      return leftCenter.x - rightCenter.x;
    }
    if (
      left.targetDeviceId !== null
      && left.targetDeviceId === right.targetDeviceId
      && options.routingVariant >= 3
      && hasMultiProducerInput(left.targetDeviceId)
      && left.sourceDeviceId !== null
      && right.sourceDeviceId !== null
    ) {
      const leftCenter = deviceCenter(deviceById.get(left.sourceDeviceId)!);
      const rightCenter = deviceCenter(deviceById.get(right.sourceDeviceId)!);
      const targetCenter = deviceCenter(deviceById.get(left.targetDeviceId)!);
      if (options.routingVariant % 3 === 1) return rightCenter.x - leftCenter.x;
      if (options.routingVariant % 3 === 2) {
        return Math.abs(leftCenter.x - targetCenter.x) - Math.abs(rightCenter.x - targetCenter.x)
          || leftCenter.x - rightCenter.x;
      }
      return leftCenter.x - rightCenter.x;
    }
    const leftBoundary = Number(left.sourceDeviceId === null || left.targetDeviceId === null);
    const rightBoundary = Number(right.sourceDeviceId === null || right.targetDeviceId === null);
    const boundaryDifference = leftBoundary - rightBoundary;
    if (boundaryDifference !== 0) return boundaryDifference;
    const leftConstraint = connectionPortChoices(left);
    const rightConstraint = connectionPortChoices(right);
    const leftDistance = approximateConnectionDistance(left);
    const rightDistance = approximateConnectionDistance(right);
    switch (options.routingVariant % 3) {
      case 1:
        return rightDistance - leftDistance
          || leftConstraint - rightConstraint
          || left.itemId.localeCompare(right.itemId);
      case 2:
        return leftDistance - rightDistance
          || leftConstraint - rightConstraint
          || right.itemId.localeCompare(left.itemId);
      default:
        return leftConstraint - rightConstraint
          || rightDistance - leftDistance
          || left.itemId.localeCompare(right.itemId);
    }
  });
  const occurrenceBySemanticKey = new Map<string, number>();
  const identifiedPlannedConnections = plannedConnections.map((connection) => {
    const semanticKey = `${connection.itemId}\u0000${connection.sourceDeviceId ?? ""}\u0000${connection.targetDeviceId ?? ""}`;
    const occurrence = (occurrenceBySemanticKey.get(semanticKey) ?? 0) + 1;
    occurrenceBySemanticKey.set(semanticKey, occurrence);
    return {
      ...connection,
      id: createMaterialConnectionId(connection, occurrence),
    };
  });
  const preservedIds = new Set<string>();
  if (
    options.previousRouting !== undefined
    && options.previousProductionDevices !== undefined
    && options.movedDeviceIds !== undefined
    && options.movedDeviceIds.size > 0
  ) {
    const conflictingIds = options.forcedRipUpConnectionIds === undefined
      ? resolveConflictingConnections({
          connections: options.previousRouting.connections,
          movedDeviceIds: options.movedDeviceIds,
          previousDevices: options.previousProductionDevices,
          nextDevices: options.productionDevices,
          buffer: 1,
        })
      : [...options.forcedRipUpConnectionIds].sort();
    const localLimit = options.preservationConnectionLimit ?? 16;
    if (conflictingIds.length <= localLimit) {
      const conflicting = new Set(conflictingIds);
      const previousById = new Map(options.previousRouting.connections.map((connection) => [connection.id, connection]));
      for (const planned of identifiedPlannedConnections) {
        if (conflicting.has(planned.id)) continue;
        const previous = previousById.get(planned.id);
        if (previous === undefined
          || previous.itemId !== planned.itemId
          || previous.sourceDeviceId !== planned.sourceDeviceId
          || previous.targetDeviceId !== planned.targetDeviceId
          || Math.abs(previous.perMinute - planned.perMinute) > 0.000001
          || previous.points.some((point) => blocked.has(gridKey(point)))) continue;
        const kind = resolveItemLogisticsKind(planned.itemId, options.registry);
        const source = planned.sourceDeviceId === null ? null : resolveUnusedPorts(
          planned.sourceDeviceId,
          "output",
          kind,
          new Set(),
        ).find((endpoint) => gridKey(endpoint.outsideGridPoint) === gridKey(previous.points[0]!));
        const target = planned.targetDeviceId === null ? null : resolveUnusedPorts(
          planned.targetDeviceId,
          "input",
          kind,
          new Set(),
        ).find((endpoint) => gridKey(endpoint.outsideGridPoint)
          === gridKey(previous.points[previous.points.length - 1]!));
        if ((planned.sourceDeviceId !== null && source === undefined)
          || (planned.targetDeviceId !== null && target === undefined)) continue;
        const areaExcludedConnection = planned.sourceDeviceId !== null
          && requestById.get(planned.sourceDeviceId)?.definition.id === "item_port_unloader_1"
          && planned.targetDeviceId !== null
          && requestById.get(planned.targetDeviceId)?.kind === "production";
        commitResolvedRoute(planned, {
          source: source ?? null,
          target: target ?? null,
          points: previous.points,
        }, areaExcludedConnection);
        preservedIds.add(planned.id);
      }
    }
  }
  if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING_ORDER"] === "1") {
    console.error(JSON.stringify({
      label: "routing-order",
      routingVariant: options.routingVariant,
      connections: identifiedPlannedConnections.map((connection) => ({
        id: connection.id,
        itemId: connection.itemId,
        sourceDeviceId: connection.sourceDeviceId,
        targetDeviceId: connection.targetDeviceId,
        approximateDistance: approximateConnectionDistance(connection),
        portChoices: connectionPortChoices(connection),
      })),
    }));
  }
  for (const connection of identifiedPlannedConnections) {
    if (!preservedIds.has(connection.id)) route(connection);
  }

  function resolveUnusedPorts(
    deviceId: string,
    direction: "input" | "output",
    kind: LogisticsKind,
    used: ReadonlySet<string>,
  ): DevicePortEndpoint[] {
    const entity = options.productionEntities[deviceId];
    const request = requestById.get(deviceId);
    const device = deviceById.get(deviceId);
    if (entity === undefined || request === undefined || device === undefined) return [];
    return resolveDevicePortEndpoints({
      entity,
      definition: request.definition,
      kind,
      direction,
      pointerGridPoint: device.position,
    }).filter((endpoint) => !used.has(portKey(endpoint)));
  }

  function isProductionInternalConnection(connection: {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }): boolean {
    return connection.sourceDeviceId !== null
      && connection.targetDeviceId !== null
      && requestById.get(connection.sourceDeviceId)?.kind === "production"
      && requestById.get(connection.targetDeviceId)?.kind === "production";
  }

  function connectionRoutingPriority(connection: {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }): number {
    const isInternal = isProductionInternalConnection(connection);
    const isWarehouseSupply =
      connection.sourceDeviceId !== null
      && requestById.get(connection.sourceDeviceId)?.definition.id === "item_port_unloader_1";
    const isWarehouseStorage =
      connection.sourceDeviceId !== null
      && requestById.get(connection.sourceDeviceId)?.kind === "production"
      && connection.targetDeviceId !== null
      && requestById.get(connection.targetDeviceId)?.kind === "storage";
    const isFanoutInternal = isInternal && (
      (connection.sourceDeviceId !== null
        && hasMultiConsumerOutput(requestById.get(connection.sourceDeviceId)!, options.requests))
      || (connection.targetDeviceId !== null
        && hasMultiConsumerOutput(requestById.get(connection.targetDeviceId)!, options.requests))
    );
    if (options.routingVariant >= 3) {
      if (isFanoutInternal) return 0;
      if (isInternal) return 1;
      if (isWarehouseSupply || isWarehouseStorage) return 2;
      return 3;
    }
    switch (options.routingVariant % 3) {
      case 1:
        if (isWarehouseSupply) return 0;
        if (isInternal) return 1;
        if (isWarehouseStorage) return 2;
        break;
      case 2:
        if (isInternal) return 0;
        if (isWarehouseSupply || isWarehouseStorage) return 1;
        break;
      default:
        if (isWarehouseStorage) return 0;
        if (isInternal) return 1;
        if (isWarehouseSupply) return 2;
        break;
    }
    return 3;
  }

  function connectionPortChoices(connection: {
    readonly itemId: string;
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }): number {
    const kind = resolveItemLogisticsKind(connection.itemId, options.registry);
    const sourceCount = connection.sourceDeviceId === null
      ? 1
      : resolveUnusedPorts(connection.sourceDeviceId, "output", kind, new Set()).length;
    const targetCount = connection.targetDeviceId === null
      ? 1
      : resolveUnusedPorts(connection.targetDeviceId, "input", kind, new Set()).length;
    return sourceCount * targetCount;
  }

  function approximateConnectionDistance(connection: {
    readonly itemId: string;
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }): number {
    const source = connection.sourceDeviceId === null ? null : deviceById.get(connection.sourceDeviceId) ?? null;
    const target = connection.targetDeviceId === null ? null : deviceById.get(connection.targetDeviceId) ?? null;
    if (source !== null && target !== null) {
      return estimatePortDistance(source.id, target.id, connection.itemId);
    }
    const device = source ?? target;
    if (device === null) return 0;
    const center = deviceCenter(device);
    return Math.min(
      center.x,
      center.y,
      options.request.width - 1 - center.x,
      options.request.height - 1 - center.y,
    );
  }

  function estimatePortDistance(sourceDeviceId: string, targetDeviceId: string, itemId: string): number {
    const kind = resolveItemLogisticsKind(itemId, options.registry);
    const sourcePorts = resolveUnusedPorts(sourceDeviceId, "output", kind, new Set());
    const targetPorts = resolveUnusedPorts(targetDeviceId, "input", kind, new Set());
    let minimum = Number.POSITIVE_INFINITY;
    for (const sourcePort of sourcePorts) {
      for (const targetPort of targetPorts) {
        minimum = Math.min(minimum, manhattan(sourcePort.outsideGridPoint, targetPort.outsideGridPoint));
      }
    }
    if (Number.isFinite(minimum)) return minimum;
    const source = deviceById.get(sourceDeviceId);
    const target = deviceById.get(targetDeviceId);
    return source === undefined || target === undefined
      ? Number.MAX_SAFE_INTEGER
      : manhattan(deviceCenter(source), deviceCenter(target));
  }

  return {
    entities: logisticsEntities,
    devices: logisticsDevices,
    connections,
    internalConnectionCount,
    boundaryConnectionCount,
    areaExcludedDeviceIds,
  };
}

/**
 * Build bounded reroute neighborhoods around fan-in/fan-out devices. Routes
 * touching or running immediately beside that shared-device skeleton are added
 * as movable conflicts, while unrelated routes remain fixed obstacles.
 */
export function createSharedDeviceRoutingNeighborhoods(
  connections: readonly {
    readonly id: string;
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
    readonly points: readonly GridPoint[];
  }[],
  maximumConnections = 12,
): string[][] {
  const limit = Math.max(2, Math.trunc(maximumConnections));
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const groups = new Map<string, string[]>();
  const addToGroup = (key: string, connectionId: string): void => {
    const ids = groups.get(key) ?? [];
    ids.push(connectionId);
    groups.set(key, ids);
  };
  for (const connection of connections) {
    if (connection.sourceDeviceId !== null) {
      addToGroup(`source:${connection.sourceDeviceId}`, connection.id);
    }
    if (connection.targetDeviceId !== null) {
      addToGroup(`target:${connection.targetDeviceId}`, connection.id);
    }
  }

  const cellsByConnectionId = new Map(connections.map((connection) => [
    connection.id,
    new Set(connection.points.map(gridKey)),
  ]));
  const routeProximity = (leftId: string, rightId: string): number => {
    const left = connectionById.get(leftId);
    const rightCells = cellsByConnectionId.get(rightId);
    if (left === undefined || rightCells === undefined) return Number.POSITIVE_INFINITY;
    for (const point of left.points) {
      if (rightCells.has(gridKey(point))) return 0;
    }
    for (const point of left.points) {
      if (
        rightCells.has(`${point.x - 1},${point.y}`)
        || rightCells.has(`${point.x + 1},${point.y}`)
        || rightCells.has(`${point.x},${point.y - 1}`)
        || rightCells.has(`${point.x},${point.y + 1}`)
      ) return 1;
    }
    return Number.POSITIVE_INFINITY;
  };

  const unique = new Map<string, string[]>();
  const keep = (ids: readonly string[]): void => {
    const bounded = [...new Set(ids)].slice(0, limit).sort();
    if (bounded.length >= 2) unique.set(bounded.join("\u0000"), bounded);
  };
  for (const seedIds of groups.values()) {
    const seeds = [...new Set(seedIds)].sort();
    if (seeds.length < 2) continue;
    const seedSet = new Set(seeds);
    const nearby = connections
      .filter((connection) => !seedSet.has(connection.id))
      .map((connection) => ({
        id: connection.id,
        proximity: Math.min(...seeds.map((seedId) =>
          routeProximity(seedId, connection.id))),
        length: connection.points.length,
      }))
      .filter((candidate) => Number.isFinite(candidate.proximity))
      .sort((left, right) =>
        left.proximity - right.proximity
        || right.length - left.length
        || left.id.localeCompare(right.id));
    // Generate the minimum shared-port group and progressively release
    // crossing and immediately adjacent corridors. The final ordering below
    // prioritizes the released conflict neighborhoods: rerouting only the
    // small seed group while its crossed corridors remain frozen commonly
    // makes every alternate input-port assignment infeasible.
    keep(seeds);
    keep([
      ...seeds,
      ...nearby.filter((candidate) => candidate.proximity === 0)
        .map((candidate) => candidate.id),
    ]);
    keep([...seeds, ...nearby.map((candidate) => candidate.id)]);
  }
  const overlapCount = (ids: readonly string[]): number => {
    const visits = new Map<string, number>();
    for (const id of ids) {
      for (const key of cellsByConnectionId.get(id) ?? []) {
        visits.set(key, (visits.get(key) ?? 0) + 1);
      }
    }
    return [...visits.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    );
  };
  return [...unique.values()].sort((left, right) => {
    const totalLength = (ids: readonly string[]): number => ids.reduce(
      (sum, id) => sum + (connectionById.get(id)?.points.length ?? 0),
      0,
    );
    return overlapCount(right) - overlapCount(left)
      || right.length - left.length
      || totalLength(right) - totalLength(left)
      || left.join("\u0000").localeCompare(right.join("\u0000"));
  });
}

/**
 * Build joint reroute neighborhoods for an adjacent bank of equivalent
 * multi-input devices. Releasing one target at a time leaves the other bank
 * lanes frozen and can make the nearest free input unreachable.
 */
export function createDeviceBankRoutingNeighborhoods(
  connections: readonly {
    readonly id: string;
    readonly targetDeviceId: string | null;
    readonly points: readonly GridPoint[];
  }[],
  devices: readonly HeadlessPlacedDevice[],
  maximumConnections = 12,
): string[][] {
  const incomingByTargetId = new Map<string, typeof connections>();
  for (const connection of connections) {
    if (connection.targetDeviceId === null) continue;
    incomingByTargetId.set(connection.targetDeviceId, [
      ...(incomingByTargetId.get(connection.targetDeviceId) ?? []),
      connection,
    ]);
  }
  const banks = new Map<string, HeadlessPlacedDevice[]>();
  for (const device of devices) {
    if (device.kind !== "production") continue;
    const key = [
      device.definitionId,
      device.rotation,
      device.position.y,
      device.height,
    ].join(":");
    banks.set(key, [...(banks.get(key) ?? []), device]);
  }
  const result: string[][] = [];
  for (const devicesInBank of banks.values()) {
    const ordered = [...devicesInBank]
      .filter((device) => (incomingByTargetId.get(device.id)?.length ?? 0) >= 2)
      .sort((left, right) => left.position.x - right.position.x || left.id.localeCompare(right.id));
    if (ordered.length < 2) continue;
    const isAdjacentBank = ordered.slice(1).every((device, index) => {
      const previous = ordered[index]!;
      return device.position.x <= previous.position.x + previous.width + 1;
    });
    if (!isAdjacentBank) continue;
    const ids = [...new Set(ordered.flatMap((device) =>
      (incomingByTargetId.get(device.id) ?? []).map((connection) => connection.id)))].sort();
    if (ids.length > maximumConnections) continue;
    result.push(ids);
  }
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  return result.sort((left, right) =>
    right.length - left.length
    || right.reduce((sum, id) => sum + (connectionById.get(id)?.points.length ?? 0), 0)
      - left.reduce((sum, id) => sum + (connectionById.get(id)?.points.length ?? 0), 0)
    || left.join("\u0000").localeCompare(right.join("\u0000")));
}

/**
 * Enumerate exact target-port assignments for the most circuitous target in a
 * jointly rerouted neighborhood. Other targets retain their incumbent ports
 * so a local port experiment cannot reshuffle the entire layout. Small fan-ins
 * enumerate every permutation; larger fan-ins use bounded swaps between the
 * most circuitous lane and each sibling.
 */
export function createHotspotTargetPortAssignments(
  connections: readonly {
    readonly id: string;
    readonly targetDeviceId: string | null;
    readonly points: readonly GridPoint[];
  }[],
): ReadonlyMap<string, string>[] {
  const incomingByTargetId = new Map<string, typeof connections>();
  for (const connection of connections) {
    if (connection.targetDeviceId === null || connection.points.length === 0) continue;
    incomingByTargetId.set(connection.targetDeviceId, [
      ...(incomingByTargetId.get(connection.targetDeviceId) ?? []),
      connection,
    ]);
  }
  const candidates = [...incomingByTargetId.values()]
    .filter((incoming) => incoming.length >= 2)
    .filter((incoming) =>
      new Set(incoming.map((connection) =>
        gridKey(connection.points[connection.points.length - 1]!))).size === incoming.length)
    .sort((left, right) => {
      const detour = (incoming: typeof connections): number => incoming.reduce(
        (sum, connection) => sum + Math.max(
          0,
          connection.points.length - 1
            - manhattan(connection.points[0]!, connection.points[connection.points.length - 1]!),
        ),
        0,
      );
      return detour(right) - detour(left)
        || right.length - left.length
        || (left[0]!.targetDeviceId ?? "").localeCompare(right[0]!.targetDeviceId ?? "");
    });
  const hotspot = candidates[0];
  if (hotspot === undefined) return [];

  const orderedConnections = [...hotspot].sort((left, right) => left.id.localeCompare(right.id));
  const hotspotPortKeys = orderedConnections
    .map((connection) => gridKey(connection.points[connection.points.length - 1]!))
    .sort((left, right) => {
      const [leftX, leftY] = left.split(",").map(Number);
      const [rightX, rightY] = right.split(",").map(Number);
      return leftX! - rightX! || leftY! - rightY! || left.localeCompare(right);
    });
  const baseAssignment = new Map(connections
    .filter((connection) => connection.targetDeviceId !== null && connection.points.length > 0)
    .map((connection) => [
      connection.id,
      gridKey(connection.points[connection.points.length - 1]!),
    ]));
  const assignments: ReadonlyMap<string, string>[] = [];
  if (orderedConnections.length > 4) {
    const routeDetour = (connection: typeof orderedConnections[number]): number =>
      Math.max(
        0,
        connection.points.length - 1
          - manhattan(connection.points[0]!, connection.points[connection.points.length - 1]!),
      );
    const byDetour = [...orderedConnections].sort((left, right) =>
      routeDetour(right) - routeDetour(left)
      || right.points.length - left.points.length
      || left.id.localeCompare(right.id));
    const anchor = byDetour[0]!;
    const anchorPort = baseAssignment.get(anchor.id)!;
    for (const sibling of byDetour.slice(1, 5)) {
      const siblingPort = baseAssignment.get(sibling.id);
      if (siblingPort === undefined || siblingPort === anchorPort) continue;
      const assignment = new Map(baseAssignment);
      assignment.set(anchor.id, siblingPort);
      assignment.set(sibling.id, anchorPort);
      assignments.push(assignment);
    }
    return assignments;
  }
  const permute = (prefix: readonly string[], remaining: readonly string[]): void => {
    if (remaining.length === 0) {
      const assignment = new Map(baseAssignment);
      orderedConnections.forEach((connection, index) => {
        assignment.set(connection.id, prefix[index]!);
      });
      assignments.push(assignment);
      return;
    }
    for (const [index, value] of remaining.entries()) {
      permute(
        [...prefix, value],
        [...remaining.slice(0, index), ...remaining.slice(index + 1)],
      );
    }
  };
  permute([], hotspotPortKeys);
  return assignments;
}

function fixedDeviceRoutingScore(
  productionDevices: readonly HeadlessPlacedDevice[],
  routing: RoutingResult,
): readonly number[] {
  const allDevices = [...productionDevices, ...routing.devices];
  const areaDevices = allDevices.filter((device) =>
    device.kind !== "warehouse-bus"
    && (
      device.kind !== "belt"
      || !routing.areaExcludedDeviceIds.has(device.id)
    ));
  const bounds = measureFactoryFootprintBounds(areaDevices);
  const compactness = measureLayoutCompactness(allDevices);
  return [
    measureFrontageOverflowCells(allDevices),
    bounds.width * bounds.height,
    measureConvexContourArea(allDevices),
    countTurnsAndCrossings(routing),
    routing.devices.length,
    compactness.enclosedVoidCellCount,
    compactness.boundingVoidCellCount,
  ];
}

/**
 * Improve a complete route allocation without moving equipment. Each accepted
 * step rips a shared-port/corridor neighborhood, jointly reassigns its ports,
 * and preserves every route outside that neighborhood.
 */
function createFixedDeviceRoutingRefinements(options: {
  readonly request: HeadlessOptimizationRequest;
  readonly registry: RegistryContract;
  readonly requests: readonly DeviceRequest[];
  readonly productionDevices: readonly HeadlessPlacedDevice[];
  readonly productionEntities: Readonly<Record<string, WorldEntity>>;
  readonly routing: RoutingResult;
  readonly enforceFrontageConstraint: boolean;
  readonly maximumNeighborhoods?: number;
  readonly maximumConnectionsPerNeighborhood?: number;
}): RoutingResult[] {
  const preservationAnchor = options.productionDevices.find((device) =>
    device.kind === "production" || device.kind === "storage");
  if (preservationAnchor === undefined) return [];
  const neighborhoodPool = createSharedDeviceRoutingNeighborhoods(
    options.routing.connections,
    options.maximumConnectionsPerNeighborhood,
  );
  const connectionById = new Map(options.routing.connections.map((connection) => [
    connection.id,
    connection,
  ]));
  const sharesEndpoint = (
    ids: readonly string[],
    endpoint: "sourceDeviceId" | "targetDeviceId",
  ): boolean => {
    const endpointIds = new Set(ids.map((id) => connectionById.get(id)?.[endpoint]));
    return endpointIds.size === 1 && !endpointIds.has(null) && !endpointIds.has(undefined);
  };
  const totalRouteLength = (ids: readonly string[]): number => ids.reduce(
    (sum, id) => sum + (connectionById.get(id)?.points.length ?? 0),
    0,
  );
  const neighborhoodLimit = options.maximumNeighborhoods ?? 10;
  const selectedNeighborhoods = new Map<string, string[]>();
  const keepNeighborhood = (ids: readonly string[]): void => {
    if (selectedNeighborhoods.size >= neighborhoodLimit) return;
    selectedNeighborhoods.set(ids.join("\u0000"), [...ids]);
  };
  // First release a complete adjacent multi-input bank. Releasing one consumer
  // at a time leaves the other vertical lanes frozen, which can force a nearby
  // port onto a long return path.
  const bankNeighborhoods = createDeviceBankRoutingNeighborhoods(
    options.routing.connections,
    options.productionDevices,
    options.maximumConnectionsPerNeighborhood,
  ).slice(0, 1);
  const bankNeighborhoodSignatures = new Set(bankNeighborhoods.map((ids) =>
    ids.join("\u0000")));
  for (const ids of bankNeighborhoods) {
    keepNeighborhood(ids);
  }
  // Conflict-expanded groups make the frozen corridors movable, but they must
  // not consume every slot. Preserve one pure fan-out and one pure fan-in
  // group so the router can jointly choose alternate ports across several
  // successors/inputs even when those routes do not currently cross each
  // other.
  const conflictAllowance = Math.max(0, neighborhoodLimit - 3);
  for (const ids of neighborhoodPool
    .filter((candidate) =>
      !sharesEndpoint(candidate, "sourceDeviceId")
      && !sharesEndpoint(candidate, "targetDeviceId"))
    .slice(0, conflictAllowance)) {
    keepNeighborhood(ids);
  }
  for (const endpoint of ["sourceDeviceId", "targetDeviceId"] as const) {
    const sharedEndpointCandidate = neighborhoodPool
      .filter((candidate) => sharesEndpoint(candidate, endpoint))
      .sort((left, right) =>
        totalRouteLength(right) - totalRouteLength(left)
        || left.join("\u0000").localeCompare(right.join("\u0000")))[0];
    if (sharedEndpointCandidate !== undefined) keepNeighborhood(sharedEndpointCandidate);
  }
  for (const ids of neighborhoodPool) keepNeighborhood(ids);
  const neighborhoods = [...selectedNeighborhoods.values()];
  if (neighborhoods.length === 0) return [];
  const traceRouting = process.env["INDUSTRIAL_PLANNER_TRACE_FIXED_ROUTING"] === "1"
    || process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1";

  let incumbent = options.routing;
  const improvements: RoutingResult[] = [];
  const seen = new Set<string>();
  const signature = (routing: RoutingResult): string => routing.connections
    .map((connection) =>
      `${connection.id}:${connection.points.map(gridKey).join(";")}`)
    .sort()
    .join("|");
  seen.add(signature(incumbent));
  if (traceRouting) {
    console.error(
      `[fixed-routing-refinement] neighborhoods=${neighborhoods.map((ids) => ids.length).join(",")} `
      + `score=${fixedDeviceRoutingScore(options.productionDevices, incumbent).join(",")}`,
    );
  }

  for (const [neighborhoodIndex, connectionIds] of neighborhoods.entries()) {
    let neighborhoodBest = incumbent;
    const isDeviceBank = bankNeighborhoodSignatures.has(connectionIds.join("\u0000"));
    const ripped = new Set(connectionIds);
    const rippedConnections = incumbent.connections.filter((connection) =>
      ripped.has(connection.id));
    const targetPortAssignments = createHotspotTargetPortAssignments(rippedConnections);
    const hasTargetPortAssignments = targetPortAssignments.length > 0;
    const routingVariants = hasTargetPortAssignments
      ? targetPortAssignments.map((_, index) => 41 + index)
      : isDeviceBank
        ? [33, 34, 35, 36, 37, 38, 39, 40]
        : [33, 34, 35, 36];
    for (const routingVariant of routingVariants) {
      const sourceMultiplicity = new Map<string, number>();
      for (const connection of rippedConnections) {
        const sourceId = connection.sourceDeviceId ?? "";
        sourceMultiplicity.set(sourceId, (sourceMultiplicity.get(sourceId) ?? 0) + 1);
      }
      const productionDeviceById = new Map(options.productionDevices.map((device) => [
        device.id,
        device,
      ]));
      const orderedRippedConnections = [...rippedConnections].sort((left, right) => {
        if (!isDeviceBank || routingVariant < 37) {
          return routingVariant % 2 === 0
            ? right.points.length - left.points.length || left.id.localeCompare(right.id)
            : left.points.length - right.points.length || right.id.localeCompare(left.id);
        }
        const fanoutRank = (connection: RoutedConnection): number =>
          Number((sourceMultiplicity.get(connection.sourceDeviceId ?? "") ?? 0) > 1);
        const fanoutFirst = routingVariant >= 39;
        const fanoutDifference = fanoutFirst
          ? fanoutRank(right) - fanoutRank(left)
          : fanoutRank(left) - fanoutRank(right);
        if (fanoutDifference !== 0) return fanoutDifference;
        const sourceX = (connection: RoutedConnection): number =>
          connection.sourceDeviceId === null
            ? Number.MAX_SAFE_INTEGER
            : deviceCenter(productionDeviceById.get(connection.sourceDeviceId)!).x;
        const targetX = (connection: RoutedConnection): number =>
          connection.targetDeviceId === null
            ? Number.MAX_SAFE_INTEGER
            : deviceCenter(productionDeviceById.get(connection.targetDeviceId)!).x;
        const spatialDifference = sourceX(left) - sourceX(right)
          || targetX(left) - targetX(right)
          || left.id.localeCompare(right.id);
        return routingVariant % 2 === 0 ? -spatialDifference : spatialDifference;
      });
      const priorityConnectionKeys = orderedRippedConnections.map(routeConnectionKey);
      const maximumRouteOrderAttempts = isDeviceBank || hasTargetPortAssignments ? 3 : 1;
      for (let routeOrderAttempt = 0;
        routeOrderAttempt < maximumRouteOrderAttempts;
        routeOrderAttempt += 1) {
        try {
          const candidate = routeMaterialFlow({
            request: options.request,
            registry: options.registry,
            requests: options.requests,
            productionDevices: options.productionDevices,
            productionEntities: options.productionEntities,
            routingVariant,
            prioritizeFanoutGroups: true,
            preferFirstFeasibleRoute: routeOrderAttempt === 2,
            // The whole shared-port neighborhood is being ripped together, so
            // no sibling owns a band yet. Let A* compare every still-free input
            // and output port; the normal monotone band is only a construction
            // heuristic and can force a route to return across the whole bank.
            relaxPortBandAssignment: true,
            forcedTargetPortGridKeyByConnectionId:
              targetPortAssignments[routingVariant - 41],
            previousRouting: incumbent,
            previousProductionDevices: options.productionDevices,
            // Preservation is activated by a non-empty motion set. The forced
            // rip-up IDs are exact, so this anchor itself never moves.
            movedDeviceIds: new Set([preservationAnchor.id]),
            forcedRipUpConnectionIds: ripped,
            priorityConnectionKeys,
            enforceFrontageConstraint: options.enforceFrontageConstraint,
            freezeFlowAllocation: true,
          });
          const candidateSignature = signature(candidate);
          if (!seen.has(candidateSignature)) {
            seen.add(candidateSignature);
            if (traceRouting) {
              console.error(
                `[fixed-routing-refinement:${neighborhoodIndex}:v${routingVariant}`
                + `:a${routeOrderAttempt + 1}] `
                + `score=${fixedDeviceRoutingScore(options.productionDevices, candidate).join(",")}`,
              );
            }
            if (compareScore(
              fixedDeviceRoutingScore(options.productionDevices, candidate),
              fixedDeviceRoutingScore(options.productionDevices, neighborhoodBest),
            ) < 0) {
              neighborhoodBest = candidate;
            }
          }
          break;
        } catch (error) {
          if (traceRouting) {
            console.error(
              `[fixed-routing-refinement:${neighborhoodIndex}:v${routingVariant}`
              + `:a${routeOrderAttempt + 1}] failed=`
              + `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (!(error instanceof RouteFailureError)
            || routeOrderAttempt + 1 >= maximumRouteOrderAttempts) break;
          const failureKey = routeFailureConnectionKey(error.evidence);
          const existingIndex = priorityConnectionKeys.indexOf(failureKey);
          if (existingIndex >= 0) priorityConnectionKeys.splice(existingIndex, 1);
          // Reserve the route that was just sealed off before replaying the
          // remaining bank. This is bounded order backtracking, not an
          // unbounded permutation search.
          priorityConnectionKeys.unshift(failureKey);
        }
      }
    }
    if (neighborhoodBest !== incumbent) {
      incumbent = neighborhoodBest;
      improvements.push(incumbent);
    }
  }
  return improvements;
}

function routeFailureEvidenceKey(evidence: RouteFailureEvidence): string {
  return `${evidence.kind}\u0000${evidence.itemId}\u0000${evidence.sourceDeviceId ?? ""}\u0000${evidence.targetDeviceId ?? ""}`;
}

function routeFailureConnectionKey(evidence: RouteFailureEvidence): string {
  return routeConnectionKey(evidence);
}

function createFailureDirectedPriorityNeighborhood(options: {
  readonly evidence: RouteFailureEvidence;
  readonly requests: readonly DeviceRequest[];
  readonly registry: RegistryContract;
  readonly devices: readonly HeadlessPlacedDevice[];
}): string[] {
  const failedKey = routeFailureConnectionKey(options.evidence);
  const flowEdges = createCpSatFlowEdges(options.requests, options.registry);
  const placeableIds = options.requests
    .filter((request) => request.kind === "production" || request.kind === "storage")
    .map((request) => request.id);
  const components = buildTopologyComponents(placeableIds, flowEdges);
  const cyclicMemberIds = new Set(
    components.find((component) =>
      component.deviceIds.length > 1
      && (
        (options.evidence.sourceDeviceId !== null
          && component.deviceIds.includes(options.evidence.sourceDeviceId))
        || (options.evidence.targetDeviceId !== null
          && component.deviceIds.includes(options.evidence.targetDeviceId))
      ))?.deviceIds ?? [],
  );
  const deviceById = new Map(options.devices.map((device) => [device.id, device]));
  const centerDistance = (edge: {
    readonly sourceId: string;
    readonly targetId: string;
  }): number => {
    const source = deviceById.get(edge.sourceId);
    const target = deviceById.get(edge.targetId);
    return source === undefined || target === undefined
      ? 0
      : manhattan(deviceCenter(source), deviceCenter(target));
  };
  const neighborhood = flowEdges
    .filter((edge) =>
      (
        options.evidence.sourceDeviceId !== null
        && edge.sourceId === options.evidence.sourceDeviceId
      )
      || (
        options.evidence.targetDeviceId !== null
        && edge.targetId === options.evidence.targetDeviceId
      )
      || (
        cyclicMemberIds.has(edge.sourceId)
        && cyclicMemberIds.has(edge.targetId)
      ))
    .sort((left, right) =>
      centerDistance(right) - centerDistance(left)
      || left.sourceId.localeCompare(right.sourceId)
      || left.targetId.localeCompare(right.targetId)
      || left.itemId.localeCompare(right.itemId))
    .map((edge) => routeConnectionKey({
      itemId: edge.itemId,
      sourceDeviceId: edge.sourceId,
      targetDeviceId: edge.targetId,
    }));
  return [...new Set([...neighborhood, failedKey])];
}

function routeConnectionKey(connection: {
  readonly itemId: string;
  readonly sourceDeviceId: string | null;
  readonly targetDeviceId: string | null;
}): string {
  return `${connection.itemId}\u0000${connection.sourceDeviceId ?? ""}\u0000${connection.targetDeviceId ?? ""}`;
}

function createMaterialConnectionId(connection: {
  readonly itemId: string;
  readonly sourceDeviceId: string | null;
  readonly targetDeviceId: string | null;
}, occurrence: number): string {
  return `${connection.itemId}:${connection.sourceDeviceId ?? "boundary"}->${connection.targetDeviceId ?? "boundary"}:${occurrence}`;
}

function resolveBestRoute(options: {
  readonly width: number;
  readonly height: number;
  readonly blocked: ReadonlySet<string>;
  readonly routedCells: ReadonlySet<string>;
  readonly routedCellOccupations: ReadonlyMap<string, RoutedCellOccupation>;
  readonly reservedPortCells: ReadonlySet<string>;
  readonly directionOrder: number;
  readonly kind: LogisticsKind;
  readonly sourceCandidates: readonly DevicePortEndpoint[] | null;
  readonly targetCandidates: readonly DevicePortEndpoint[] | null;
  readonly preferFirstFeasible: boolean;
  readonly preferShortestPortPair?: boolean;
  readonly contourRouting: ContourRoutingContext;
  readonly relaxedConnectivity: RelaxedRouteConnectivity;
  readonly onRelaxedConnectivityRejected?: (count: number) => void;
}): { readonly source: DevicePortEndpoint | null; readonly target: DevicePortEndpoint | null; readonly points: GridPoint[] } | null {
  let best: { source: DevicePortEndpoint | null; target: DevicePortEndpoint | null; points: GridPoint[] } | null = null;
  const relaxedConnectivity = options.relaxedConnectivity;
  if (options.sourceCandidates === null) {
    for (const target of options.targetCandidates ?? []) {
      if (!isRouteEndpointFree(target.outsideGridPoint, options)) continue;
      if (!relaxedConnectivity.boundaryComponents.has(
        relaxedConnectivity.componentByCell.get(gridKey(target.outsideGridPoint)) ?? -1,
      )) {
        options.onRelaxedConnectivityRejected?.(1);
        continue;
      }
      const reversed = findGridRouteToBoundary({
        ...options,
        blocked: blockReservedPortCells(options, [target.outsideGridPoint]),
        start: target.outsideGridPoint,
      });
      if (reversed === null) continue;
      const points = [...reversed].reverse();
      if (options.preferFirstFeasible) return { source: null, target, points };
      if (best === null || comparePortPairRoute(
        points,
        best.points,
        options.contourRouting,
        options.routedCellOccupations,
        options.preferShortestPortPair,
      ) < 0) {
        best = { source: null, target, points };
      }
    }
    return best;
  }
  if (options.targetCandidates === null) {
    for (const source of options.sourceCandidates) {
      if (!isRouteEndpointFree(source.outsideGridPoint, options)) continue;
      if (!relaxedConnectivity.boundaryComponents.has(
        relaxedConnectivity.componentByCell.get(gridKey(source.outsideGridPoint)) ?? -1,
      )) {
        options.onRelaxedConnectivityRejected?.(1);
        continue;
      }
      const points = findGridRouteToBoundary({
        ...options,
        blocked: blockReservedPortCells(options, [source.outsideGridPoint]),
        start: source.outsideGridPoint,
      });
      if (points === null) continue;
      if (options.preferFirstFeasible) return { source, target: null, points };
      if (best === null || comparePortPairRoute(
        points,
        best.points,
        options.contourRouting,
        options.routedCellOccupations,
        options.preferShortestPortPair,
      ) < 0) {
        best = { source, target: null, points };
      }
    }
    return best;
  }
  const endpointPairs = options.sourceCandidates.flatMap((source) =>
    options.targetCandidates!.map((target) => ({ source, target })))
    .sort((left, right) =>
      manhattan(left.source.outsideGridPoint, left.target.outsideGridPoint)
      - manhattan(right.source.outsideGridPoint, right.target.outsideGridPoint)
      || portKey(left.source).localeCompare(portKey(right.source))
      || portKey(left.target).localeCompare(portKey(right.target)));
  for (const { source, target } of endpointPairs) {
      if (
        !isRouteEndpointFree(source.outsideGridPoint, options)
        || !isRouteEndpointFree(target.outsideGridPoint, options)
      ) continue;
      const sourceComponent = relaxedConnectivity.componentByCell.get(
        gridKey(source.outsideGridPoint),
      );
      const targetComponent = relaxedConnectivity.componentByCell.get(
        gridKey(target.outsideGridPoint),
      );
      if (sourceComponent === undefined || sourceComponent !== targetComponent) {
        options.onRelaxedConnectivityRejected?.(1);
        continue;
      }
      const points = findGridRoute({
        ...options,
        blocked: blockReservedPortCells(
          options,
          [source.outsideGridPoint, target.outsideGridPoint],
        ),
        start: source.outsideGridPoint,
        goal: target.outsideGridPoint,
      });
      if (
        points !== null
        && (best === null || comparePortPairRoute(
          points,
          best.points,
          options.contourRouting,
          options.routedCellOccupations,
          options.preferShortestPortPair,
        ) < 0)
      ) {
        if (options.preferFirstFeasible) return { source, target, points };
        best = { source, target, points };
      }
  }
  return best;
}

interface RelaxedRouteConnectivity {
  readonly componentByCell: ReadonlyMap<string, number>;
  readonly boundaryComponents: ReadonlySet<number>;
}

/**
 * Label free-space components while deliberately ignoring committed logistics.
 * This is a necessary-condition funnel only: the strict A* may still reject a
 * pair for turns, crossings, reserved ports, or route direction.
 */
function buildRelaxedRouteConnectivity(
  width: number,
  height: number,
  blocked: ReadonlySet<string>,
): RelaxedRouteConnectivity {
  const componentByCell = new Map<string, number>();
  const boundaryComponents = new Set<number>();
  const directionDeltas = [
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 1 },
  ] as const;
  let component = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startKey = `${x},${y}`;
      if (blocked.has(startKey) || componentByCell.has(startKey)) continue;
      const queue: GridPoint[] = [{ x, y }];
      componentByCell.set(startKey, component);
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const point = queue[cursor]!;
        if (point.x === 0 || point.y === 0
          || point.x === width - 1 || point.y === height - 1) {
          boundaryComponents.add(component);
        }
        for (const delta of directionDeltas) {
          const neighbor = { x: point.x + delta.x, y: point.y + delta.y };
          if (neighbor.x < 0 || neighbor.y < 0
            || neighbor.x >= width || neighbor.y >= height) continue;
          const key = gridKey(neighbor);
          if (blocked.has(key) || componentByCell.has(key)) continue;
          componentByCell.set(key, component);
          queue.push(neighbor);
        }
      }
      component += 1;
    }
  }
  return { componentByCell, boundaryComponents };
}

/** Test-facing necessary-condition check used by the A* endpoint funnel. */
export function canRelaxedGridPointsConnect(options: {
  readonly width: number;
  readonly height: number;
  readonly blocked: ReadonlySet<string>;
  readonly source: GridPoint;
  readonly target: GridPoint;
}): boolean {
  const connectivity = buildRelaxedRouteConnectivity(
    options.width,
    options.height,
    options.blocked,
  );
  const sourceComponent = connectivity.componentByCell.get(gridKey(options.source));
  return sourceComponent !== undefined
    && sourceComponent === connectivity.componentByCell.get(gridKey(options.target));
}

function blockReservedPortCells(
  options: {
    readonly blocked: ReadonlySet<string>;
    readonly reservedPortCells: ReadonlySet<string>;
  },
  allowedEndpoints: readonly GridPoint[],
): ReadonlySet<string> {
  const blocked = new Set(options.blocked);
  const allowed = new Set(allowedEndpoints.map(gridKey));
  for (const key of options.reservedPortCells) {
    if (!allowed.has(key)) blocked.add(key);
  }
  return blocked;
}

function isRouteEndpointFree(
  point: GridPoint,
  obstacles: { readonly blocked: ReadonlySet<string>; readonly routedCells: ReadonlySet<string> },
): boolean {
  const key = gridKey(point);
  return !obstacles.blocked.has(key) && !obstacles.routedCells.has(key);
}

function findGridRoute(options: {
  readonly width: number;
  readonly height: number;
  readonly blocked: ReadonlySet<string>;
  readonly routedCells: ReadonlySet<string>;
  readonly routedCellOccupations: ReadonlyMap<string, RoutedCellOccupation>;
  readonly kind: LogisticsKind;
  readonly directionOrder: number;
  readonly contourRouting: ContourRoutingContext;
  readonly start: GridPoint;
  readonly goal: GridPoint;
}): GridPoint[] | null {
  return findGridRouteToGoal({
    ...options,
    isGoal: (point) => point.x === options.goal.x && point.y === options.goal.y,
    estimate: (point) => manhattan(point, options.goal),
  });
}

function findGridRouteToBoundary(options: {
  readonly width: number;
  readonly height: number;
  readonly blocked: ReadonlySet<string>;
  readonly routedCells: ReadonlySet<string>;
  readonly routedCellOccupations: ReadonlyMap<string, RoutedCellOccupation>;
  readonly kind: LogisticsKind;
  readonly directionOrder: number;
  readonly contourRouting: ContourRoutingContext;
  readonly start: GridPoint;
}): GridPoint[] | null {
  return findGridRouteToGoal({
    ...options,
    isGoal: (point) => !options.routedCells.has(gridKey(point)) && (
      point.x === 0
      || point.y === 0
      || point.x === options.width - 1
      || point.y === options.height - 1
    ),
    estimate: (point) => Math.min(
      point.x,
      point.y,
      options.width - 1 - point.x,
      options.height - 1 - point.y,
    ),
  });
}

function findGridRouteToGoal(options: {
  readonly width: number;
  readonly height: number;
  readonly blocked: ReadonlySet<string>;
  readonly routedCells: ReadonlySet<string>;
  readonly routedCellOccupations: ReadonlyMap<string, RoutedCellOccupation>;
  readonly kind: LogisticsKind;
  readonly directionOrder: number;
  readonly contourRouting: ContourRoutingContext;
  readonly start: GridPoint;
  readonly isGoal: (point: GridPoint) => boolean;
  readonly estimate: (point: GridPoint) => number;
}): GridPoint[] | null {
  type SearchNode = {
    point: GridPoint;
    direction: number;
    cost: number;
    estimate: number;
    parent: string | null;
    sequence: number;
  };
  const baseDirections = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ] as const;
  const directionOffset = ((options.directionOrder % baseDirections.length)
    + baseDirections.length) % baseDirections.length;
  const directions = [
    ...baseDirections.slice(directionOffset),
    ...baseDirections.slice(0, directionOffset),
  ];
  const startKey = searchKey(options.start, -1);
  const open: SearchNode[] = [{
    point: { ...options.start }, direction: -1, cost: 0,
    estimate: options.estimate(options.start), parent: null, sequence: 0,
  }];
  let nextSequence = 1;
  const compareOpen = (left: SearchNode, right: SearchNode): number =>
    left.estimate - right.estimate || left.cost - right.cost || left.sequence - right.sequence;
  const pushOpen = (node: SearchNode): void => {
    open.push(node);
    let index = open.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareOpen(open[parent]!, node) <= 0) break;
      open[index] = open[parent]!;
      index = parent;
    }
    open[index] = node;
  };
  const popOpen = (): SearchNode => {
    const first = open[0]!;
    const last = open.pop();
    if (open.length === 0 || last === undefined) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= open.length) break;
      const right = left + 1;
      const child = right < open.length && compareOpen(open[right]!, open[left]!) < 0 ? right : left;
      if (compareOpen(last, open[child]!) <= 0) break;
      open[index] = open[child]!;
      index = child;
    }
    open[index] = last;
    return first;
  };
  const bestCost = new Map([[startKey, 0]]);
  const nodes = new Map<string, SearchNode>();

  while (open.length > 0) {
    const current = popOpen();
    const currentKey = searchKey(current.point, current.direction);
    if (current.cost !== bestCost.get(currentKey)) continue;
    nodes.set(currentKey, current);
    if (options.isGoal(current.point)) {
      const path: GridPoint[] = [];
      let cursor: SearchNode | undefined = current;
      while (cursor !== undefined) {
        path.push(cursor.point);
        cursor = cursor.parent === null ? undefined : nodes.get(cursor.parent);
      }
      return path.reverse();
    }

    for (const [direction, delta] of directions.entries()) {
      const currentOccupation = options.routedCellOccupations.get(gridKey(current.point));
      if (
        currentOccupation !== undefined
        && current.direction >= 0
        && direction !== current.direction
      ) continue;
      const point = { x: current.point.x + delta.x, y: current.point.y + delta.y };
      if (point.x < 0 || point.y < 0 || point.x >= options.width || point.y >= options.height) continue;
      const key = gridKey(point);
      const isEndpoint = point.x === options.start.x && point.y === options.start.y;
      if (!isEndpoint && options.blocked.has(key)) continue;
      const occupation = options.routedCellOccupations.get(key);
      if (
        occupation !== undefined
        && (
          occupation.kind !== options.kind
          || occupation.axis === null
          || occupation.axis === directionAxis(direction)
          || occupation.crossed
        )
      ) continue;
      const bendPenalty = current.direction >= 0 && current.direction !== direction ? 2 : 0;
      const crossingPenalty = occupation === undefined ? 0 : 6;
      const distanceToContour = options.contourRouting.distanceByCell.get(key) ?? 1;
      const contourGapPenalty = Math.min(3, Math.max(0, distanceToContour - 1));
      const bounds = options.contourRouting.bounds;
      const contourExpansionPenalty = bounds !== null && (
        point.x < bounds.minX
        || point.x > bounds.maxX
        || point.y < bounds.minY
        || point.y > bounds.maxY
      ) ? 2 : 0;
      const cost = current.cost
        + 1
        + bendPenalty
        + crossingPenalty
        + contourGapPenalty
        + contourExpansionPenalty;
      const nextKey = searchKey(point, direction);
      if (cost >= (bestCost.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      const next: SearchNode = {
        point,
        direction,
        cost,
        estimate: cost + options.estimate(point),
        parent: currentKey,
        sequence: nextSequence,
      };
      nextSequence += 1;
      bestCost.set(nextKey, cost);
      nodes.set(nextKey, next);
      pushOpen(next);
    }
  }
  return null;
}

function createRoutingDocument(
  request: HeadlessOptimizationRequest,
  entities: Readonly<Record<string, WorldEntity>>,
): WorldDocument {
  const timestamp = new Date(0).toISOString();
  return {
    schemaVersion: 1,
    documentKey: "headless-routing",
    baseId: request.baseId ?? "wuling_protocol_core",
    meta: { id: "headless-routing", name: "Headless routing", createdAt: timestamp, updatedAt: timestamp },
    entities: { ...entities },
    entityOrder: Object.keys(entities),
    slotLinks: [],
    documentSettings: {
      viewport: { center: { x: 0, y: 0 }, gridSize: 1, displayRotation: 0 },
      powerMode: "infinite",
    },
  };
}

function resolveItemLogisticsKind(itemId: string, registry: RegistryContract): LogisticsKind {
  return registry.queries.resolveItemDomain(itemId) === "solid" ? "belt" : "pipe";
}

function appendMaterialEndpoint(
  map: Map<string, MaterialEndpoint[]>,
  endpoint: MaterialEndpoint,
): void {
  const endpoints = map.get(endpoint.itemId) ?? [];
  endpoints.push(endpoint);
  map.set(endpoint.itemId, endpoints);
}

function appendMaterialEndpointLanes(
  map: Map<string, MaterialEndpoint[]>,
  request: DeviceRequest,
  itemId: string,
  perMinute: number,
  laneCapacity: number,
): void {
  let remaining = perMinute;
  while (remaining > 0.000001) {
    const laneRate = Math.min(remaining, laneCapacity);
    appendMaterialEndpoint(map, { request, itemId, remainingPerMinute: laneRate });
    remaining -= laneRate;
  }
}

function resolveLogisticsLaneCapacityPerMinute(itemId: string, registry: RegistryContract): number {
  const kind = resolveItemLogisticsKind(itemId, registry);
  const durationSeconds = kind === "belt"
    ? BELT_TRANSPORT_DURATION_SECONDS
    : PIPE_TRANSPORT_DURATION_SECONDS;
  return 60 / durationSeconds;
}

export function resolveRequiredLogisticsLaneCount(
  perMinute: number,
  kind: LogisticsKind,
): number {
  if (!Number.isFinite(perMinute) || perMinute <= 0) return 0;
  const durationSeconds = kind === "belt"
    ? BELT_TRANSPORT_DURATION_SECONDS
    : PIPE_TRANSPORT_DURATION_SECONDS;
  return Math.ceil(perMinute / (60 / durationSeconds) - 0.000001);
}

function sumConnectionRate(
  connections: readonly RoutedConnection[],
  itemId: string,
  endpoint: "sourceDeviceId" | "targetDeviceId",
  deviceId: string,
): number {
  return connections.reduce((sum, connection) =>
    connection.itemId === itemId && connection[endpoint] === deviceId
      ? sum + connection.perMinute
      : sum, 0);
}

function addRectangleCells(
  cells: Set<string>, x: number, y: number, width: number, height: number,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) cells.add(`${column},${row}`);
  }
}

function measureBounds(devices: readonly HeadlessPlacedDevice[]): { width: number; height: number } {
  return devices.reduce((bounds, device) => ({
    width: Math.max(bounds.width, device.position.x + device.width),
    height: Math.max(bounds.height, device.position.y + device.height),
  }), { width: 0, height: 0 });
}

interface MeasuredDeviceExtents {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

function measuredFactoryDevices(
  devices: readonly HeadlessPlacedDevice[],
): readonly HeadlessPlacedDevice[] {
  return devices.filter((device) => device.kind !== "warehouse-bus");
}

function measureDeviceExtents(
  devices: readonly HeadlessPlacedDevice[],
): MeasuredDeviceExtents | null {
  if (devices.length === 0) return null;
  const minX = Math.min(...devices.map((device) => device.position.x));
  const minY = Math.min(...devices.map((device) => device.position.y));
  const maxX = Math.max(...devices.map((device) => device.position.x + device.width));
  const maxY = Math.max(...devices.map((device) => device.position.y + device.height));
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Charged factory footprint whose width is measured from the warehouse
 * unloader frontage. Wide warehouse bus/base entities remain in the blueprint
 * but do not enlarge production width. Height remains anchored at the layout
 * origin: the warehouse shell consumes vertical construction space and must
 * not be silently subtracted from the requested height.
 */
export function measureFactoryFootprintBounds(
  devices: readonly HeadlessPlacedDevice[],
): { readonly width: number; readonly height: number } {
  const extents = measureDeviceExtents(measuredFactoryDevices(devices));
  return extents === null
    ? { width: 0, height: 0 }
    : {
        width: extents.width,
        height: devices.reduce(
          (maximum, device) => Math.max(maximum, device.position.y + device.height),
          0,
        ),
      };
}

/** A route- and power-independent lower bound for the final bounding area. */
export function measureDeviceBoundingAreaLowerBound(
  devices: readonly HeadlessPlacedDevice[],
): number {
  const extents = measureDeviceExtents(measuredFactoryDevices(devices));
  return extents === null ? 0 : extents.width * extents.height;
}

export interface ObjectiveHotspotScore {
  readonly deviceId: string;
  readonly frontageOverflowCells: number;
  readonly boundingAreaReduction: number;
  readonly enclosedVoidAdjacency: number;
  readonly routeCost: number;
}

/**
 * Attribute the routed objective's movable proxies to production/storage
 * devices. Results use the same high-level lexicographic order as layout
 * comparison and are deterministic on device ID ties.
 */
export function rankObjectiveHotspots(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly connections: readonly {
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
    readonly points: readonly GridPoint[];
  }[];
}): ObjectiveHotspotScore[] {
  const movable = options.devices.filter((device) =>
    device.kind === "production" || device.kind === "storage");
  const baseBounds = measureFactoryFootprintBounds(options.devices);
  const baseArea = baseBounds.width * baseBounds.height;
  const enclosedVoidCells = collectEnclosedVoidCells(options.devices);
  const routeCostByDeviceId = new Map<string, number>();
  for (const connection of options.connections) {
    const routeCost = connection.points.length + countConnectionTurns(connection.points) * 4;
    for (const deviceId of [connection.sourceDeviceId, connection.targetDeviceId]) {
      if (deviceId === null) continue;
      routeCostByDeviceId.set(deviceId, (routeCostByDeviceId.get(deviceId) ?? 0) + routeCost);
    }
  }
  const hotspots = movable.map((device): ObjectiveHotspotScore => {
    const reducedBounds = measureFactoryFootprintBounds(
      options.devices.filter((candidate) => candidate.id !== device.id),
    );
    return {
      deviceId: device.id,
      frontageOverflowCells: measureDeviceFrontageOverflowCells(device, options.devices),
      boundingAreaReduction: Math.max(
        0,
        baseArea - reducedBounds.width * reducedBounds.height,
      ),
      enclosedVoidAdjacency: countAdjacentCells(device, enclosedVoidCells),
      routeCost: routeCostByDeviceId.get(device.id) ?? 0,
    };
  });
  return hotspots.sort((left, right) =>
    right.frontageOverflowCells - left.frontageOverflowCells
    || right.boundingAreaReduction - left.boundingAreaReduction
    || right.enclosedVoidAdjacency - left.enclosedVoidAdjacency
    || right.routeCost - left.routeCost
    || left.deviceId.localeCompare(right.deviceId));
}

function collectEnclosedVoidCells(devices: readonly HeadlessPlacedDevice[]): ReadonlySet<string> {
  const measuredDevices = measuredFactoryDevices(devices);
  const bounds = measureDeviceExtents(measuredDevices);
  if (bounds === null || bounds.width === 0 || bounds.height === 0) return new Set();
  const occupied = new Set<string>();
  for (const device of measuredDevices) {
    addRectangleCells(occupied, device.position.x, device.position.y, device.width, device.height);
  }
  const outside = new Set<string>();
  const queue: GridPoint[] = [];
  for (let x = bounds.minX; x < bounds.maxX; x += 1) {
    queue.push({ x, y: bounds.minY }, { x, y: bounds.maxY - 1 });
  }
  for (let y = bounds.minY; y < bounds.maxY; y += 1) {
    queue.push({ x: bounds.minX, y }, { x: bounds.maxX - 1, y });
  }
  while (queue.length > 0) {
    const point = queue.pop()!;
    const key = gridKey(point);
    if (
      point.x < bounds.minX
      || point.y < bounds.minY
      || point.x >= bounds.maxX
      || point.y >= bounds.maxY
      || occupied.has(key) || outside.has(key)
    ) continue;
    outside.add(key);
    queue.push(
      { x: point.x - 1, y: point.y },
      { x: point.x + 1, y: point.y },
      { x: point.x, y: point.y - 1 },
      { x: point.x, y: point.y + 1 },
    );
  }
  const enclosed = new Set<string>();
  for (let y = bounds.minY; y < bounds.maxY; y += 1) {
    for (let x = bounds.minX; x < bounds.maxX; x += 1) {
      const key = `${x},${y}`;
      if (!occupied.has(key) && !outside.has(key)) enclosed.add(key);
    }
  }
  return enclosed;
}

function countAdjacentCells(
  device: HeadlessPlacedDevice,
  cells: ReadonlySet<string>,
): number {
  const adjacent = new Set<string>();
  for (let x = device.position.x; x < device.position.x + device.width; x += 1) {
    adjacent.add(`${x},${device.position.y - 1}`);
    adjacent.add(`${x},${device.position.y + device.height}`);
  }
  for (let y = device.position.y; y < device.position.y + device.height; y += 1) {
    adjacent.add(`${device.position.x - 1},${y}`);
    adjacent.add(`${device.position.x + device.width},${y}`);
  }
  return [...adjacent].filter((key) => cells.has(key)).length;
}

function measureDeviceFrontageOverflowCells(
  device: HeadlessPlacedDevice,
  devices: readonly HeadlessPlacedDevice[],
): number {
  const unloaders = devices.filter((candidate) => candidate.kind === "warehouse-port");
  if (unloaders.length === 0) return 0;
  const minX = Math.min(...unloaders.map((candidate) => candidate.position.x));
  const minY = Math.min(...unloaders.map((candidate) => candidate.position.y));
  const maxX = Math.max(...unloaders.map((candidate) => candidate.position.x + candidate.width));
  const maxY = Math.max(...unloaders.map((candidate) => candidate.position.y + candidate.height));
  const verticalFrontage = maxY - minY >= maxX - minX;
  const start = verticalFrontage ? minY : minX;
  const end = verticalFrontage ? maxY : maxX;
  let overflow = 0;
  for (let y = device.position.y; y < device.position.y + device.height; y += 1) {
    for (let x = device.position.x; x < device.position.x + device.width; x += 1) {
      const coordinate = verticalFrontage ? y : x;
      if (coordinate < start || coordinate >= end) overflow += 1;
    }
  }
  return overflow;
}

function countConnectionTurns(points: readonly GridPoint[]): number {
  if (points.length < 3) return 0;
  let turns = 0;
  let previousDeltaX = points[1]!.x - points[0]!.x;
  let previousDeltaY = points[1]!.y - points[0]!.y;
  for (let index = 2; index < points.length; index += 1) {
    const deltaX = points[index]!.x - points[index - 1]!.x;
    const deltaY = points[index]!.y - points[index - 1]!.y;
    if (deltaX !== previousDeltaX || deltaY !== previousDeltaY) {
      turns += 1;
      previousDeltaX = deltaX;
      previousDeltaY = deltaY;
    }
  }
  return turns;
}

function measureLayoutCompactness(devices: readonly HeadlessPlacedDevice[]): {
  readonly occupiedCellCount: number;
  readonly boundingVoidCellCount: number;
  readonly enclosedVoidCellCount: number;
} {
  const measuredDevices = measuredFactoryDevices(devices);
  const bounds = measureDeviceExtents(measuredDevices);
  if (bounds === null || bounds.width === 0 || bounds.height === 0) {
    return { occupiedCellCount: 0, boundingVoidCellCount: 0, enclosedVoidCellCount: 0 };
  }
  const occupied = new Set<string>();
  for (const device of measuredDevices) {
    addRectangleCells(occupied, device.position.x, device.position.y, device.width, device.height);
  }
  const outside = new Set<string>();
  const queue: GridPoint[] = [];
  for (let x = bounds.minX; x < bounds.maxX; x += 1) {
    queue.push({ x, y: bounds.minY }, { x, y: bounds.maxY - 1 });
  }
  for (let y = bounds.minY; y < bounds.maxY; y += 1) {
    queue.push({ x: bounds.minX, y }, { x: bounds.maxX - 1, y });
  }
  while (queue.length > 0) {
    const point = queue.pop()!;
    const key = gridKey(point);
    if (
      point.x < bounds.minX
      || point.y < bounds.minY
      || point.x >= bounds.maxX
      || point.y >= bounds.maxY
      || occupied.has(key) || outside.has(key)
    ) continue;
    outside.add(key);
    queue.push(
      { x: point.x - 1, y: point.y },
      { x: point.x + 1, y: point.y },
      { x: point.x, y: point.y - 1 },
      { x: point.x, y: point.y + 1 },
    );
  }
  let enclosedVoidCellCount = 0;
  for (let y = bounds.minY; y < bounds.maxY; y += 1) {
    for (let x = bounds.minX; x < bounds.maxX; x += 1) {
      const key = `${x},${y}`;
      if (!occupied.has(key) && !outside.has(key)) enclosedVoidCellCount += 1;
    }
  }
  const occupiedCellCount = [...occupied].filter((key) => {
    const [x, y] = key.split(",").map(Number);
    return x! >= bounds.minX
      && y! >= bounds.minY
      && x! < bounds.maxX
      && y! < bounds.maxY;
  }).length;
  return {
    occupiedCellCount,
    boundingVoidCellCount: bounds.width * bounds.height - occupiedCellCount,
    enclosedVoidCellCount,
  };
}

function measureEnclosedVoidCells(devices: readonly HeadlessPlacedDevice[]): number {
  return measureLayoutCompactness(devices).enclosedVoidCellCount;
}

export function measureFrontageOverflowCells(devices: readonly HeadlessPlacedDevice[]): number {
  const unloaders = devices.filter((device) => device.kind === "warehouse-port");
  if (unloaders.length === 0) return 0;
  const minX = Math.min(...unloaders.map((device) => device.position.x));
  const minY = Math.min(...unloaders.map((device) => device.position.y));
  const maxX = Math.max(...unloaders.map((device) => device.position.x + device.width));
  const maxY = Math.max(...unloaders.map((device) => device.position.y + device.height));
  const verticalFrontage = maxY - minY >= maxX - minX;
  const start = verticalFrontage ? minY : minX;
  const end = verticalFrontage ? maxY : maxX;
  const overflow = new Set<string>();
  for (const device of devices) {
    if (device.kind === "warehouse-bus") continue;
    for (let y = device.position.y; y < device.position.y + device.height; y += 1) {
      for (let x = device.position.x; x < device.position.x + device.width; x += 1) {
        const coordinate = verticalFrontage ? y : x;
        if (coordinate < start || coordinate >= end) overflow.add(`${x},${y}`);
      }
    }
  }
  return overflow.size;
}

/**
 * Necessary prospective-routing rule for a topology layer.
 *
 * Every row occupied by equipment in the layer must retain at least one
 * distinct frontage cell per lane whose source is above the layer and whose
 * target is below it, plus every lane already reserved for reaching a side
 * port in that layer. Device footprints are hard belt obstacles. This catches
 * both a complete equipment wall and a nominally open corridor whose capacity
 * is already consumed by terminal-port approaches before the normal router
 * spends A* work on the candidate.
 */
export function hasRequiredThroughCorridorCapacity(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly layerDeviceIds: ReadonlySet<string>;
  readonly frontageStart: number;
  readonly frontageEnd: number;
  readonly requiredLaneCount: number;
  readonly reservedApproachLaneCount?: number;
}): boolean {
  const requiredCapacity = Math.max(0, options.requiredLaneCount)
    + Math.max(0, options.reservedApproachLaneCount ?? 0);
  if (requiredCapacity <= 0) return true;
  const frontageWidth = options.frontageEnd - options.frontageStart;
  if (frontageWidth < requiredCapacity) return false;

  const activeRows = new Set<number>();
  for (const device of options.devices) {
    if (!options.layerDeviceIds.has(device.id)) continue;
    for (let y = device.position.y; y < device.position.y + device.height; y += 1) {
      activeRows.add(y);
    }
  }

  for (const y of activeRows) {
    const blockedColumns = new Set<number>();
    for (const device of options.devices) {
      // Belts and pipes have their own crossing rules. This prospective check
      // is specifically about impassable equipment footprints; committed
      // logistics conflicts remain the prefix router's responsibility.
      if (device.kind === "belt" || device.kind === "pipe") continue;
      if (y < device.position.y || y >= device.position.y + device.height) continue;
      const start = Math.max(options.frontageStart, device.position.x);
      const end = Math.min(options.frontageEnd, device.position.x + device.width);
      for (let x = start; x < end; x += 1) blockedColumns.add(x);
    }
    if (frontageWidth - blockedColumns.size < requiredCapacity) return false;
  }
  return true;
}

function listFrontageOverflowConnectionIds(
  devices: readonly HeadlessPlacedDevice[],
  connections: readonly RoutedConnection[],
): string[] {
  const unloaders = devices.filter((device) => device.kind === "warehouse-port");
  if (unloaders.length === 0) return [];
  const minX = Math.min(...unloaders.map((device) => device.position.x));
  const minY = Math.min(...unloaders.map((device) => device.position.y));
  const maxX = Math.max(...unloaders.map((device) => device.position.x + device.width));
  const maxY = Math.max(...unloaders.map((device) => device.position.y + device.height));
  const verticalFrontage = maxY - minY >= maxX - minX;
  const start = verticalFrontage ? minY : minX;
  const end = verticalFrontage ? maxY : maxX;
  return connections
    .filter((connection) => connection.points.some((point) => {
      const coordinate = verticalFrontage ? point.y : point.x;
      return coordinate < start || coordinate >= end;
    }))
    .map((connection) => connection.id)
    .sort();
}

function listFrontageOverflowDeviceIds(devices: readonly HeadlessPlacedDevice[]): string[] {
  const unloaders = devices.filter((device) => device.kind === "warehouse-port");
  if (unloaders.length === 0) return [];
  const minX = Math.min(...unloaders.map((device) => device.position.x));
  const minY = Math.min(...unloaders.map((device) => device.position.y));
  const maxX = Math.max(...unloaders.map((device) => device.position.x + device.width));
  const maxY = Math.max(...unloaders.map((device) => device.position.y + device.height));
  const verticalFrontage = maxY - minY >= maxX - minX;
  const start = verticalFrontage ? minY : minX;
  const end = verticalFrontage ? maxY : maxX;
  return devices
    .filter((device) => device.kind !== "warehouse-bus")
    .filter((device) => {
      const deviceStart = verticalFrontage ? device.position.y : device.position.x;
      const deviceEnd = deviceStart + (verticalFrontage ? device.height : device.width);
      return deviceStart < start || deviceEnd > end;
    })
    .map((device) => device.id)
    .sort();
}

function measureConvexContourArea(devices: readonly HeadlessPlacedDevice[]): number {
  const points = measuredFactoryDevices(devices).flatMap((device) => [
    { x: device.position.x, y: device.position.y },
    { x: device.position.x + device.width, y: device.position.y },
    { x: device.position.x, y: device.position.y + device.height },
    { x: device.position.x + device.width, y: device.position.y + device.height },
  ]);
  return measureConvexHullArea(points);
}

function measureConvexHullArea(input: readonly GridPoint[]): number {
  const points = [...input].sort((left, right) => left.x - right.x || left.y - right.y);
  if (points.length < 3) return 0;
  const cross = (origin: GridPoint, left: GridPoint, right: GridPoint): number =>
    (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
  const lower: GridPoint[] = [];
  for (const point of points) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: GridPoint[] = [];
  for (const point of [...points].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const doubledArea = hull.reduce((sum, point, index) => {
    const next = hull[(index + 1) % hull.length]!;
    return sum + point.x * next.y - point.y * next.x;
  }, 0);
  return Math.abs(doubledArea) / 2;
}

function createContourRoutingContext(
  width: number,
  height: number,
  referenceCells: ReadonlySet<string>,
): ContourRoutingContext {
  const referencePoints = [...referenceCells].map(parseGridKey);
  const bounds = referencePoints.length === 0 ? null : {
    minX: Math.min(...referencePoints.map((point) => point.x)),
    minY: Math.min(...referencePoints.map((point) => point.y)),
    maxX: Math.max(...referencePoints.map((point) => point.x)),
    maxY: Math.max(...referencePoints.map((point) => point.y)),
  };
  const distanceByCell = new Map<string, number>();
  const queue: GridPoint[] = [];
  for (const point of referencePoints) {
    if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) continue;
    const key = gridKey(point);
    if (distanceByCell.has(key)) continue;
    distanceByCell.set(key, 0);
    queue.push(point);
  }
  const directions = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ] as const;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const distance = distanceByCell.get(gridKey(current))!;
    for (const direction of directions) {
      const point = { x: current.x + direction.x, y: current.y + direction.y };
      if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) continue;
      const key = gridKey(point);
      if (distanceByCell.has(key)) continue;
      distanceByCell.set(key, distance + 1);
      queue.push(point);
    }
  }
  return { referencePoints, distanceByCell, bounds };
}

export function compareContourAwareRoutes(options: {
  readonly width: number;
  readonly height: number;
  readonly referenceCells: readonly GridPoint[];
  readonly left: readonly GridPoint[];
  readonly right: readonly GridPoint[];
}): number {
  const contourRouting = createContourRoutingContext(
    options.width,
    options.height,
    new Set(options.referenceCells.map(gridKey)),
  );
  return compareRoute(options.left, options.right, contourRouting);
}

/** Count cells where a candidate route would cross an already committed route. */
export function countRouteCrossings(
  points: readonly GridPoint[],
  routedCellOccupations: ReadonlyMap<string, RoutedCellOccupation>,
): number {
  return points.reduce((sum, point) =>
    sum + Number(routedCellOccupations.has(gridKey(point))), 0);
}

/**
 * Compare paths produced by different source/target port pairs. Bounding shape
 * remains primary, but crossings and turns are evaluated before small contour
 * gaps and raw length so a short crossed pairing cannot defeat a monotone one.
 */
function comparePortPairRoute(
  left: readonly GridPoint[],
  right: readonly GridPoint[],
  contourRouting: ContourRoutingContext,
  routedCellOccupations: ReadonlyMap<string, RoutedCellOccupation>,
  preferShortestPortPair = false,
): number {
  const leftPacking = measureRoutePacking(left, contourRouting);
  const rightPacking = measureRoutePacking(right, contourRouting);
  if (preferShortestPortPair) {
    return leftPacking.boundingArea - rightPacking.boundingArea
      || countRouteCrossings(left, routedCellOccupations)
        - countRouteCrossings(right, routedCellOccupations)
      || left.length - right.length
      || countBends(left) - countBends(right)
      || leftPacking.contourArea - rightPacking.contourArea
      || leftPacking.contourGap - rightPacking.contourGap;
  }
  return leftPacking.boundingArea - rightPacking.boundingArea
    || leftPacking.contourArea - rightPacking.contourArea
    || countRouteCrossings(left, routedCellOccupations)
      - countRouteCrossings(right, routedCellOccupations)
    || countBends(left) - countBends(right)
    || leftPacking.contourGap - rightPacking.contourGap
    || left.length - right.length;
}

/** Test-facing wrapper for deterministic port-pair route comparison. */
export function comparePortPairRoutes(options: {
  readonly width: number;
  readonly height: number;
  readonly referenceCells: readonly GridPoint[];
  readonly routedCellOccupations: ReadonlyMap<string, RoutedCellOccupation>;
  readonly left: readonly GridPoint[];
  readonly right: readonly GridPoint[];
  readonly preferShortestPortPair?: boolean;
}): number {
  return comparePortPairRoute(
    options.left,
    options.right,
    createContourRoutingContext(
      options.width,
      options.height,
      new Set(options.referenceCells.map(gridKey)),
    ),
    options.routedCellOccupations,
    options.preferShortestPortPair,
  );
}

function compareRoute(
  left: readonly GridPoint[],
  right: readonly GridPoint[],
  contourRouting?: ContourRoutingContext,
): number {
  if (contourRouting === undefined) {
    return countBends(left) - countBends(right) || left.length - right.length;
  }
  const leftPacking = measureRoutePacking(left, contourRouting);
  const rightPacking = measureRoutePacking(right, contourRouting);
  return leftPacking.boundingArea - rightPacking.boundingArea
    || leftPacking.contourArea - rightPacking.contourArea
    || countBends(left) - countBends(right)
    || leftPacking.contourGap - rightPacking.contourGap
    || left.length - right.length;
}

function measureRoutePacking(
  route: readonly GridPoint[],
  contourRouting: ContourRoutingContext,
): {
  readonly boundingArea: number;
  readonly contourArea: number;
  readonly contourGap: number;
} {
  const occupied = new Map(contourRouting.referencePoints.map((point) => [gridKey(point), point]));
  for (const point of route) occupied.set(gridKey(point), point);
  const cells = [...occupied.values()];
  if (cells.length === 0) return { boundingArea: 0, contourArea: 0, contourGap: 0 };
  const minX = Math.min(...cells.map((point) => point.x));
  const minY = Math.min(...cells.map((point) => point.y));
  const maxX = Math.max(...cells.map((point) => point.x));
  const maxY = Math.max(...cells.map((point) => point.y));
  const corners = cells.flatMap((point) => [
    { x: point.x, y: point.y },
    { x: point.x + 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x + 1, y: point.y + 1 },
  ]);
  return {
    boundingArea: (maxX - minX + 1) * (maxY - minY + 1),
    contourArea: measureConvexHullArea(corners),
    contourGap: route.reduce((sum, point) =>
      sum + Math.max(0, (contourRouting.distanceByCell.get(gridKey(point)) ?? 1) - 1), 0),
  };
}

function countBends(points: readonly GridPoint[]): number {
  let bends = 0;
  for (let index = 2; index < points.length; index += 1) {
    const a = points[index - 2]!;
    const b = points[index - 1]!;
    const c = points[index]!;
    if ((b.x - a.x) !== (c.x - b.x) || (b.y - a.y) !== (c.y - b.y)) bends += 1;
  }
  return bends;
}

function portKey(endpoint: DevicePortEndpoint): string {
  return `${endpoint.entityId}:${endpoint.portGroupId}:${endpoint.portId}`;
}

function gridKey(point: GridPoint): string {
  return `${point.x},${point.y}`;
}

function parseGridKey(key: string): GridPoint {
  const separator = key.indexOf(",");
  return {
    x: Number(key.slice(0, separator)),
    y: Number(key.slice(separator + 1)),
  };
}

function searchKey(point: GridPoint, direction: number): string {
  return `${point.x},${point.y},${direction}`;
}

function manhattan(left: GridPoint, right: GridPoint): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function computePoweredEntityIds(
  blueprint: BlueprintDocument,
  registry: RegistryContract,
): Set<string> {
  const definitionById = new Map(registry.entityDefinitions.map((definition) => [definition.id, definition]));
  const entities = blueprint.entityOrder.flatMap((id) => {
    const entity = blueprint.entities[id];
    return entity === undefined ? [] : [entity];
  });
  const powerRanges = entities.flatMap((entity) => {
    const definition = definitionById.get(entity.definitionId);
    if (definition === undefined) return [];
    const range = resolvePowerRangeGridRect({ entity, definition });
    return range === null ? [] : [range];
  });
  return new Set(entities.flatMap((entity) => {
    const definition = definitionById.get(entity.definitionId);
    if (definition === undefined) return [];
    const rect = resolveEntityGridRect({ entity, definition });
    return powerRanges.some((range) => areGridRectsIntersecting(range, rect)) ? [entity.id] : [];
  }));
}

function blueprintToWorldDocument(blueprint: ReturnType<typeof createBlueprintDocument>): WorldDocument {
  return {
    schemaVersion: 1,
    documentKey: blueprint.blueprintId,
    baseId: blueprint.baseId,
    meta: {
      id: `blueprint-${blueprint.blueprintId}`,
      name: blueprint.name,
      createdAt: blueprint.createdAt,
      updatedAt: blueprint.updatedAt,
    },
    entities: blueprint.entities,
    entityOrder: [...blueprint.entityOrder],
    slotLinks: [...blueprint.slotLinks],
    documentSettings: {
      viewport: { center: { x: 0, y: 0 }, gridSize: 1, displayRotation: 0 },
      powerMode: "infinite",
    },
  };
}

function validateRequest(request: HeadlessOptimizationRequest): void {
  if (!Number.isInteger(request.width) || request.width <= 0 || !Number.isInteger(request.height) || request.height <= 0) {
    throw new Error(`width and height must be positive integers, received ${request.width}x${request.height}`);
  }
  if (!Array.isArray(request.targets) || request.targets.length === 0) {
    throw new Error("At least one production target is required");
  }
  if (
    request.routingClearance !== undefined
    && (!Number.isInteger(request.routingClearance) || request.routingClearance < 1)
  ) {
    throw new Error(`routingClearance must be a positive integer, received ${request.routingClearance}`);
  }
  if (request.frontageConstraint !== undefined
    && request.frontageConstraint !== "soft"
    && request.frontageConstraint !== "hard") {
    throw new Error(`frontageConstraint must be soft or hard, received ${String(request.frontageConstraint)}`);
  }
  for (const [recipeId, deviceCount] of Object.entries(request.minimumRecipeDeviceCounts ?? {})) {
    if (!Number.isInteger(deviceCount) || deviceCount <= 0) {
      throw new Error(
        `minimumRecipeDeviceCounts.${recipeId} must be a positive integer, received ${deviceCount}`,
      );
    }
  }
  if (request.allowRecipeOutputWaste !== undefined
    && (!Array.isArray(request.allowRecipeOutputWaste)
      || request.allowRecipeOutputWaste.some((recipeId) =>
        typeof recipeId !== "string" || recipeId.length === 0))) {
    throw new Error("allowRecipeOutputWaste must contain only non-empty recipe IDs");
  }
  if (request.search?.initialLayout !== undefined
    && request.search.initialLayout !== "auto"
    && request.search.initialLayout !== "topology-sequential") {
    throw new Error(
      `search.initialLayout must be auto or topology-sequential, received ${String(request.search.initialLayout)}`,
    );
  }
  if (request.search?.scope !== undefined
    && request.search.scope !== "local"
    && request.search.scope !== "global") {
    throw new Error(`search.scope must be local or global, received ${String(request.search.scope)}`);
  }
  if (request.search?.globalNeighborhoods !== undefined
    && request.search.globalNeighborhoods !== "layer-interlock"
    && request.search.globalNeighborhoods !== "all") {
    throw new Error(
      "search.globalNeighborhoods must be layer-interlock or all, received "
        + String(request.search.globalNeighborhoods),
    );
  }
  if (
    request.search?.iterations !== undefined
    && (!Number.isInteger(request.search.iterations) || request.search.iterations < 0 || request.search.iterations > 500)
  ) {
    throw new Error(`search.iterations must be an integer from 0 to 500, received ${request.search.iterations}`);
  }
  if (
    request.search?.routingVariants !== undefined
    && (!Number.isInteger(request.search.routingVariants)
      || request.search.routingVariants < 1
      || request.search.routingVariants > 9)
  ) {
    throw new Error(
      `search.routingVariants must be an integer from 1 to 9, received ${request.search.routingVariants}`,
    );
  }
  if (request.search?.seed !== undefined && !Number.isInteger(request.search.seed)) {
    throw new Error(`search.seed must be an integer, received ${request.search.seed}`);
  }
  if (
    request.search?.refinementCandidates !== undefined
    && (!Number.isInteger(request.search.refinementCandidates)
      || request.search.refinementCandidates < 1
      || request.search.refinementCandidates > 48)
  ) {
    throw new Error(
      `search.refinementCandidates must be an integer from 1 to 48, received ${request.search.refinementCandidates}`,
    );
  }
  if (
    request.search?.cpSat?.maxSeconds !== undefined
    && (!Number.isFinite(request.search.cpSat.maxSeconds)
      || request.search.cpSat.maxSeconds <= 0
      || request.search.cpSat.maxSeconds > 30)
  ) {
    throw new Error(`search.cpSat.maxSeconds must be in (0, 30], received ${request.search.cpSat.maxSeconds}`);
  }
  if (
    request.search?.cpSat?.candidates !== undefined
    && (!Number.isInteger(request.search.cpSat.candidates)
      || request.search.cpSat.candidates < 1
      || request.search.cpSat.candidates > 12)
  ) {
    throw new Error(`search.cpSat.candidates must be an integer from 1 to 12, received ${request.search.cpSat.candidates}`);
  }
  if (
    request.certification?.boundingArea?.maxSeconds !== undefined
    && (!Number.isFinite(request.certification.boundingArea.maxSeconds)
      || request.certification.boundingArea.maxSeconds <= 0
      || request.certification.boundingArea.maxSeconds > 30)
  ) {
    throw new Error(
      "certification.boundingArea.maxSeconds must be in (0, 30], received "
        + request.certification.boundingArea.maxSeconds,
    );
  }
  for (const target of request.targets) {
    if (target.itemId.trim() === "" || !Number.isFinite(target.perMinute) || target.perMinute <= 0) {
      throw new Error(`Invalid production target: ${JSON.stringify(target)}`);
    }
  }
}

function isFree(grid: Uint8Array, stride: number, x: number, y: number, width: number, height: number): boolean {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      if (grid[row * stride + column] !== 0) return false;
    }
  }
  return true;
}

function occupy(grid: Uint8Array, stride: number, x: number, y: number, width: number, height: number): void {
  for (let row = y; row < y + height; row += 1) {
    grid.fill(1, row * stride + x, row * stride + x + width);
  }
}

function comparePacking(left: PackingResult, right: PackingResult): number {
  const leftUnloaderCount = left.devices.filter((device) => device.kind === "warehouse-port").length;
  const rightUnloaderCount = right.devices.filter((device) => device.kind === "warehouse-port").length;
  const leftBounds = measureFactoryFootprintBounds(left.devices);
  const rightBounds = measureFactoryFootprintBounds(right.devices);
  if (leftUnloaderCount !== 1 && rightUnloaderCount !== 1) {
    return compareScore(
      [
        leftBounds.width * leftBounds.height,
        Math.max(leftBounds.width, leftBounds.height),
        leftBounds.height,
        leftBounds.width,
      ],
      [
        rightBounds.width * rightBounds.height,
        Math.max(rightBounds.width, rightBounds.height),
        rightBounds.height,
        rightBounds.width,
      ],
    );
  }
  const leftCompactness = measureLayoutCompactness(left.devices);
  const rightCompactness = measureLayoutCompactness(right.devices);
  // A sole unloader defines one unambiguous narrow frontage and should guide
  // cheap packing selection directly. Multi-unloader layouts use dedicated
  // frontage neighborhoods; ranking their unrouted intermediate states by
  // overflow here can discard the enabler move needed by a coupled repair.
  const leftFrontage = leftUnloaderCount === 1 ? measureFrontageOverflowCells(left.devices) : 0;
  const rightFrontage = rightUnloaderCount === 1 ? measureFrontageOverflowCells(right.devices) : 0;
  return compareScore(
    [
      leftFrontage,
      leftBounds.width * leftBounds.height,
      measureConvexContourArea(left.devices),
      leftCompactness.enclosedVoidCellCount,
      leftCompactness.boundingVoidCellCount,
      Math.max(leftBounds.width, leftBounds.height),
      leftBounds.height,
      leftBounds.width,
    ],
    [
      rightFrontage,
      rightBounds.width * rightBounds.height,
      measureConvexContourArea(right.devices),
      rightCompactness.enclosedVoidCellCount,
      rightCompactness.boundingVoidCellCount,
      Math.max(rightBounds.width, rightBounds.height),
      rightBounds.height,
      rightBounds.width,
    ],
  );
}

function compareLocalPacking(left: PackingResult, right: PackingResult): number {
  const leftPhysical = left.devices.filter((device) => device.kind !== "warehouse-bus");
  const rightPhysical = right.devices.filter((device) => device.kind !== "warehouse-bus");
  const leftBounds = measureFactoryFootprintBounds(leftPhysical);
  const rightBounds = measureFactoryFootprintBounds(rightPhysical);
  const leftCompactness = measureLayoutCompactness(leftPhysical);
  const rightCompactness = measureLayoutCompactness(rightPhysical);
  return compareScore(
    [
      measureFrontageOverflowCells(leftPhysical),
      leftBounds.width * leftBounds.height,
      measureConvexContourArea(leftPhysical),
      leftCompactness.enclosedVoidCellCount,
      leftCompactness.boundingVoidCellCount,
    ],
    [
      measureFrontageOverflowCells(rightPhysical),
      rightBounds.width * rightBounds.height,
      measureConvexContourArea(rightPhysical),
      rightCompactness.enclosedVoidCellCount,
      rightCompactness.boundingVoidCellCount,
    ],
  );
}

/**
 * Split one refinement round's expensive routing budget between elite bases.
 * The current winner receives half (rounded up); alternatives share the rest.
 * The returned budgets always sum to the requested total.
 */
export function allocateRefinementCandidateBudgets(
  totalCandidateBudget: number,
  requestedBaseCount: number,
): number[] {
  const total = Math.max(0, Math.floor(totalCandidateBudget));
  const baseCount = Math.min(total, Math.max(0, Math.floor(requestedBaseCount)));
  if (baseCount === 0) return [];
  if (baseCount === 1) return [total];

  const budgets = [Math.ceil(total / 2)];
  let remaining = total - budgets[0]!;
  for (let index = 1; index < baseCount; index += 1) {
    const remainingBases = baseCount - index;
    const budget = Math.ceil(remaining / remainingBases);
    budgets.push(budget);
    remaining -= budget;
  }
  return budgets;
}

function compareRoutedLayouts(left: RoutedLayoutCandidate, right: RoutedLayoutCandidate): number {
  return compareObjectiveVectors(
    buildRoutedObjectiveVector(left),
    buildRoutedObjectiveVector(right),
  );
}

/**
 * Select archive indexes from candidates already sorted by objective quality.
 * Half of the capacity is reserved for the strongest states; the rest uses
 * deterministic farthest-point sampling to preserve distinct layout basins.
 */
export function selectQualityDiverseIndexes(
  pairwiseDistances: readonly (readonly number[])[],
  maximum: number,
  requestedQualitySlots = Math.ceil(maximum / 2),
): number[] {
  const capacity = Math.min(
    pairwiseDistances.length,
    Math.max(0, Math.floor(maximum)),
  );
  if (capacity === 0) return [];
  const qualitySlots = Math.min(
    capacity,
    Math.max(1, Math.floor(requestedQualitySlots)),
  );
  const selected = Array.from({ length: qualitySlots }, (_, index) => index);
  const selectedSet = new Set(selected);
  while (selected.length < capacity) {
    let nextIndex = -1;
    let nextDistance = -1;
    for (let candidateIndex = 0; candidateIndex < pairwiseDistances.length; candidateIndex += 1) {
      if (selectedSet.has(candidateIndex)) continue;
      const minimumDistance = Math.min(...selected.map((selectedIndex) =>
        pairwiseDistances[candidateIndex]?.[selectedIndex] ?? 0));
      if (minimumDistance > nextDistance) {
        nextIndex = candidateIndex;
        nextDistance = minimumDistance;
      }
    }
    if (nextIndex < 0) break;
    selected.push(nextIndex);
    selectedSet.add(nextIndex);
  }
  return selected;
}

function retainRoutedEliteCandidate(
  archive: Map<string, RoutedLayoutCandidate>,
  candidate: RoutedLayoutCandidate,
  maximum: number,
): RoutedLayoutCandidate {
  const signature = packingSignature(candidate.packing);
  const previous = archive.get(signature);
  if (previous === undefined || compareRoutedLayouts(candidate, previous) < 0) {
    archive.set(signature, candidate);
  }

  const ordered = [...archive.entries()]
    .sort((left, right) => compareRoutedLayouts(left[1], right[1]));
  const pairwiseDistances = ordered.map(([, left]) =>
    ordered.map(([, right]) => measurePackingDiversity(left.packing, right.packing)));
  const selectedIndexes = selectQualityDiverseIndexes(
    pairwiseDistances,
    Math.max(1, maximum),
  );
  archive.clear();
  for (const index of selectedIndexes) {
    const [key, value] = ordered[index]!;
    archive.set(key, value);
  }
  return ordered[0]![1];
}

function selectDiverseRoutedEliteBases(
  candidates: readonly RoutedLayoutCandidate[],
  maximum: number,
): RoutedLayoutCandidate[] {
  if (maximum <= 0 || candidates.length === 0) return [];
  const ordered = [...candidates].sort(compareRoutedLayouts);
  const selected = [ordered[0]!];
  while (selected.length < maximum && selected.length < ordered.length) {
    let next: RoutedLayoutCandidate | null = null;
    let nextDistance = -1;
    for (const candidate of ordered) {
      if (selected.includes(candidate)) continue;
      const distance = Math.min(...selected.map((base) =>
        measurePackingDiversity(candidate.packing, base.packing)));
      if (distance > nextDistance) {
        next = candidate;
        nextDistance = distance;
      }
    }
    if (next === null) break;
    selected.push(next);
  }
  return selected;
}

function measurePackingDiversity(left: PackingResult, right: PackingResult): number {
  const rightById = new Map(right.devices.map((device) => [device.id, device]));
  let distance = 0;
  for (const device of left.devices) {
    const other = rightById.get(device.id);
    if (other === undefined) {
      distance += device.width + device.height + 1;
      continue;
    }
    distance += Math.abs(device.position.x - other.position.x)
      + Math.abs(device.position.y - other.position.y)
      + (device.rotation === other.rotation ? 0 : 1);
  }
  return distance;
}

function measureEliteArchiveMaxDistance(candidates: readonly RoutedLayoutCandidate[]): number {
  let maximum = 0;
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      maximum = Math.max(
        maximum,
        measurePackingDiversity(
          candidates[leftIndex]!.packing,
          candidates[rightIndex]!.packing,
        ),
      );
    }
  }
  return maximum;
}

function compareFrontageRepairCandidates(
  left: RoutedLayoutCandidate,
  right: RoutedLayoutCandidate,
): number {
  return left.frontageOverflowCellCount - right.frontageOverflowCellCount
    || compareRoutedLayouts(left, right)
    || packingSignature(left.packing).localeCompare(packingSignature(right.packing));
}

/**
 * Preserve one strong state from each destroy/repair family before filling by
 * score. A blocker-moving state may temporarily have the same frontage
 * overflow and a worse bounding box than its parent, yet unlock the next move.
 */
function selectFrontageRepairBeam(
  candidates: readonly RoutedLayoutCandidate[],
  maximum: number,
): RoutedLayoutCandidate[] {
  if (maximum <= 0) return [];
  const ordered = [...candidates].sort(compareFrontageRepairCandidates);
  const selected = new Map<string, RoutedLayoutCandidate>();
  const seenFamilies = new Set<string>();
  for (const candidate of ordered) {
    const family = frontageRepairFamily(candidate.packing);
    if (seenFamilies.has(family)) continue;
    seenFamilies.add(family);
    selected.set(packingSignature(candidate.packing), candidate);
    if (selected.size >= maximum) return [...selected.values()];
  }
  for (const candidate of ordered) {
    selected.set(packingSignature(candidate.packing), candidate);
    if (selected.size >= maximum) break;
  }
  return [...selected.values()].sort(compareFrontageRepairCandidates);
}

function frontageRepairFamily(packing: PackingResult): string {
  const label = packing.debugLabel ?? "initial";
  const parts = label.split(":");
  if (parts[0] === "boundary-backtrack") return parts.slice(0, 3).join(":");
  if (parts[0] === "slot-ejection") return parts.slice(0, 2).join(":");
  if (parts[0] === "cluster-translate" || parts[0] === "cluster-repair") {
    return parts.slice(0, 3).join(":");
  }
  if (parts[0] === "joint-storage-fanout") return parts.slice(0, 2).join(":");
  if (parts[0] === "route-failure-lns" || parts[0] === "route-failure-backtrack") {
    return parts.slice(0, 2).join(":");
  }
  return parts[0] ?? "initial";
}

/** Count the number of direction changes (turns) across all routed connections. */
export function countTurnsAndCrossings(routing: {
  readonly connections: readonly { readonly points: readonly GridPoint[] }[];
  readonly entities: Readonly<Record<string, { readonly tags: readonly string[] }>>;
}): number {
  let turns = 0;
  for (const connection of routing.connections) {
    const points = connection.points;
    if (points.length < 3) continue;
    let prevDx = points[1]!.x - points[0]!.x;
    let prevDy = points[1]!.y - points[0]!.y;
    for (let i = 2; i < points.length; i += 1) {
      const dx = points[i]!.x - points[i - 1]!.x;
      const dy = points[i]!.y - points[i - 1]!.y;
      if (dx !== prevDx || dy !== prevDy) {
        turns += 1;
        prevDx = dx;
        prevDy = dy;
      }
    }
  }
  const crossings = Object.values(routing.entities).filter((entity) =>
    entity.tags.includes("logistics:crossing")).length;
  return turns + crossings;
}

/** Build an objective vector from a routed layout candidate using the frozen metrics. */
function buildRoutedObjectiveVector(candidate: RoutedLayoutCandidate): ObjectiveVector {
  return {
    hardViolations: 0,
    frontageOverflow: candidate.frontageOverflowCellCount,
    powerDevices: candidate.minimumPowerDeviceCount,
    boundingArea: candidate.bounds.width * candidate.bounds.height,
    contourArea: candidate.contourArea,
    enclosedVoid: candidate.enclosedVoidCellCount,
    contourVoid: candidate.contourVoidArea,
    boundingVoid: candidate.boundingVoidCellCount,
    logisticsCells: candidate.routing.devices.length,
    turnsAndCrossings: countTurnsAndCrossings(candidate.routing),
    maxSide: Math.max(candidate.bounds.width, candidate.bounds.height),
  };
}

/**
 * Lexicographically compare two objective vectors using the given (or default) priority order.
 * Returns negative when left wins, positive when right wins, zero when equal.
 */
export function compareObjectiveVectors(
  left: ObjectiveVector,
  right: ObjectiveVector,
  objective?: LayoutObjective,
): number {
  const priorities = objective?.priorities ?? DEFAULT_LAYOUT_OBJECTIVE.priorities;
  for (const metric of priorities) {
    const diff = left[metric] - right[metric];
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Return the minimal material-connection set incident to any moved device ID.
 * Connections are included when their source or target device ID is in the moved set.
 * Connection IDs are sorted, reasons are combined (moved-source / moved-target).
 * Does not mutate input.
 */
export function computeAffectedConnections(
  connections: readonly AffectedConnectionDescriptor[],
  movedDeviceIds: ReadonlySet<string>,
): AffectedConnectionSet {
  const reasonsById = new Map<string, Set<string>>();

  for (const conn of connections) {
    const reasons: string[] = [];
    if (conn.sourceDeviceId !== null && movedDeviceIds.has(conn.sourceDeviceId)) {
      reasons.push("moved-source");
    }
    if (conn.targetDeviceId !== null && movedDeviceIds.has(conn.targetDeviceId)) {
      reasons.push("moved-target");
    }
    if (reasons.length > 0) {
      const combined = reasonsById.get(conn.id) ?? new Set<string>();
      for (const reason of reasons) combined.add(reason);
      reasonsById.set(conn.id, combined);
    }
  }

  const connectionIds = [...reasonsById.keys()].sort();
  const reasonsByConnectionId = Object.fromEntries(connectionIds.map((id) => [
    id,
    ["moved-source", "moved-target"].filter((reason) => reasonsById.get(id)!.has(reason)),
  ]));
  return { connectionIds, reasonsByConnectionId };
}

function packingSignature(packing: PackingResult): string {
  return [...packing.devices]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((device) => `${device.id}@${device.position.x},${device.position.y},${device.rotation}`)
    .join("|");
}

function findMovedDeviceIds(
  previousDevices: readonly HeadlessPlacedDevice[],
  nextDevices: readonly HeadlessPlacedDevice[],
): Set<string> {
  const previousById = new Map(previousDevices.map((device) => [device.id, device]));
  const moved = new Set<string>();
  for (const device of nextDevices) {
    const previous = previousById.get(device.id);
    if (previous === undefined
      || previous.position.x !== device.position.x
      || previous.position.y !== device.position.y
      || previous.rotation !== device.rotation
      || previous.width !== device.width
      || previous.height !== device.height) moved.add(device.id);
  }
  for (const previous of previousDevices) {
    if (!nextDevices.some((device) => device.id === previous.id)) moved.add(previous.id);
  }
  return moved;
}

function mutateOrdering(
  ordering: readonly DeviceRequest[],
  random: () => number,
  iteration: number,
): DeviceRequest[] {
  const result = [...ordering];
  if (result.length < 2) return result;
  const first = Math.floor(random() * result.length);
  let second = Math.floor(random() * result.length);
  if (second === first) second = (second + 1) % result.length;
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  switch (iteration % 3) {
    case 1: {
      const [item] = result.splice(first, 1);
      if (item !== undefined) result.splice(second, 0, item);
      break;
    }
    case 2:
      result.splice(low, high - low + 1, ...result.slice(low, high + 1).reverse());
      break;
    default:
      [result[first], result[second]] = [result[second]!, result[first]!];
      break;
  }
  return result;
}

function createDeterministicRandom(seed: number): () => number {
  let state = normalizeSearchSeed(seed);
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function normalizeSearchSeed(seed: number): number {
  const normalized = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 1;
  return normalized === 0 ? 0x9e3779b9 : normalized;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deviceCenter(device: HeadlessPlacedDevice): GridPoint {
  return {
    x: device.position.x + (device.width - 1) / 2,
    y: device.position.y + (device.height - 1) / 2,
  };
}

function directionAxis(direction: number): "horizontal" | "vertical" {
  return direction === 0 || direction === 2 ? "horizontal" : "vertical";
}

function pathCellAxis(cell: LogisticsPathCell): "horizontal" | "vertical" | null {
  if (cell.shape !== "straight" || cell.fromEdge === null) return null;
  return cell.fromEdge === "EAST" || cell.fromEdge === "WEST" ? "horizontal" : "vertical";
}

function compareScore(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function createStableBlueprintId(
  request: HeadlessOptimizationRequest,
  devices: readonly HeadlessPlacedDevice[],
): string {
  const source = JSON.stringify({
    request: { ...request, certification: undefined },
    devices,
  });
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `headless-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function cloneRecord(value: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
