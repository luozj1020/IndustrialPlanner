import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { GridPoint, GridRotation } from "@/domain/shared/grid";
import type { SimulationCompileDiagnostic } from "@/simulation/types";
import type {
  CertifiedAreaRelaxationResult,
  CertifiedAreaRelaxationStatus,
} from "./certified-area-relaxation";

/** Metrics that drive lexicographic layout comparison, in priority order. */
export type LayoutObjectiveMetric =
  | "hardViolations"
  | "frontageOverflow"
  | "powerDevices"
  | "boundingArea"
  | "contourArea"
  | "enclosedVoid"
  | "contourVoid"
  | "boundingVoid"
  | "logisticsCells"
  | "turnsAndCrossings"
  | "maxSide";

/** Explicit priority ordering for lexicographic routed-layout comparison. */
export interface LayoutObjective {
  readonly priorities: readonly LayoutObjectiveMetric[];
}

/** Immutable map from each objective metric to its numeric value. */
export type ObjectiveVector = Readonly<Record<LayoutObjectiveMetric, number>>;

/** The frozen default objective with production priority order. */
export const DEFAULT_LAYOUT_OBJECTIVE: LayoutObjective = Object.freeze({
  priorities: Object.freeze([
    "hardViolations",
    "frontageOverflow",
    "boundingArea",
    "contourArea",
    "turnsAndCrossings",
    "logisticsCells",
    "contourVoid",
    "enclosedVoid",
    "boundingVoid",
    "maxSide",
    "powerDevices",
  ]) as readonly LayoutObjectiveMetric[],
});

/** Descriptor for a material connection used in affected-connection queries. */
export interface AffectedConnectionDescriptor {
  readonly id: string;
  readonly sourceDeviceId: string | null;
  readonly targetDeviceId: string | null;
}

/** Result of computing which connections are incident to moved device IDs. */
export interface AffectedConnectionSet {
  /** Sorted unique IDs of connections incident to any moved device. */
  readonly connectionIds: readonly string[];
  /** Per-connection reason list ("moved-source" / "moved-target"). */
  readonly reasonsByConnectionId: Readonly<Record<string, readonly string[]>>;
}

/** Classification and geometry of a target-specific equipment insertion slot. */
export interface Slot {
  readonly id: string;
  readonly kind: "empty" | "logistics-occupied" | "potential";
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly rotation: GridRotation;
  readonly blockingDeviceIds: readonly string[];
  readonly occupiedLogisticsIds: readonly string[];
  readonly score: SlotScore;
}

/** Geometry-only proxy used to rank slots before expensive routing. */
export interface SlotScore {
  readonly fitWaste: number;
  readonly portAccessibility: number;
  readonly proximity: number;
  readonly boundaryReductionPotential: number;
  readonly clearanceCost: number;
}

/** Hard limits for deterministic bounded ejection-chain search. */
export interface EjectionChainConfig {
  readonly maxDepth: number;
  readonly beamWidth: number;
  readonly maxStates: number;
  readonly maxTranslation: number;
  readonly timeBudgetMs: number;
  readonly maxPotentialBlockers?: number;
}

/** Limits for progressively expanding a local logistics rip-up set. */
export interface RipUpConfig {
  readonly maxConnections: number;
  readonly maxAttempts: number;
  /** Keep retrying the fully ripped set when each failure changes route priority. */
  readonly retryExhaustedSet?: boolean;
  readonly maxCbsDepth: number;
  readonly maxCbsStates: number;
  readonly timeBudgetMs: number;
}

/** Observable outcome of a bounded local reroute attempt sequence. */
export interface RipUpResult {
  readonly status: "success" | "exhausted" | "max-connections" | "time-budget";
  readonly rippedConnectionIds: readonly string[];
  readonly preservedConnectionIds: readonly string[];
  readonly attempts: number;
}

/** A cell prohibition applied to one connection in bounded CBS. */
export interface CbsConstraint {
  readonly connectionId: string;
  readonly x: number;
  readonly y: number;
}

/** Serializable bounded-CBS search node. */
export interface CbsNode {
  readonly pathsByConnectionId: Readonly<Record<string, readonly { readonly x: number; readonly y: number }[]>>;
  readonly constraints: readonly CbsConstraint[];
  readonly cost: number;
  readonly depth: number;
}

export interface HeadlessTarget {
  readonly itemId: string;
  readonly perMinute: number;
}

export interface HeadlessSupply extends HeadlessTarget {
  readonly infinite?: boolean;
}

export interface HeadlessOptimizationRequest {
  readonly width: number;
  readonly height: number;
  readonly targets: readonly HeadlessTarget[];
  readonly supplies?: readonly HeadlessSupply[];
  readonly infiniteItemIds?: readonly string[];
  readonly recipeChoices?: Readonly<Record<string, string>>;
  /** Minimum placed instances for selected recipes; excess capacity is shared evenly across those instances. */
  readonly minimumRecipeDeviceCounts?: Readonly<Record<string, number>>;
  /** Recipes rounded up to whole full-speed machines; unconsumed output may be discarded. */
  readonly allowRecipeOutputWaste?: readonly string[];
  readonly baseId?: string;
  readonly name?: string;
  readonly allowRotate?: boolean;
  /** Reserve one-cell routing corridors around production equipment. Defaults to 1. */
  readonly routingClearance?: number;
  /** Treat the warehouse-unloader frontage span as a soft objective or hard feasibility bound. */
  readonly frontageConstraint?: "soft" | "hard";
  readonly search?: {
    /** Initial equipment construction. topology-sequential starts from the graph-derived warehouse spine only. */
    readonly initialLayout?: "auto" | "topology-sequential";
    /** local excludes map-wide fan-out relocation, ejection chains, and CP-SAT/global rebuild neighborhoods. */
    readonly scope?: "local" | "global";
    /** Limit global scope to the width-proved layer-interlock stage, or enable every global neighborhood. */
    readonly globalNeighborhoods?: "layer-interlock" | "all";
    /** Number of deterministic large-neighborhood order mutations. Defaults to 16. */
    readonly iterations?: number;
    /** Reproducible pseudo-random seed. Defaults to a hash of the request. */
    readonly seed?: number;
    /** Fast-path connection orderings. Total recovery cap remains 9. Defaults to 3. */
    readonly routingVariants?: number;
    /** Fast-path/refinement beam; an all-failed initial beam may add up to 8 candidates. Defaults to 12. */
    readonly refinementCandidates?: number;
    /** Optional local OR-Tools CP-SAT seed layouts. Falls back to deterministic LNS when unavailable. */
    readonly cpSat?: {
      readonly enabled?: boolean;
      /** Shared wall-clock solver budget for the complete CP-SAT candidate batch. */
      readonly maxSeconds?: number;
      /** Maximum candidate variants attempted within maxSeconds. */
      readonly candidates?: number;
    };
  };
  /** Proof-only budgets, deliberately separate from candidate-search settings. */
  readonly certification?: {
    readonly boundingArea?: {
      /** Wall-clock budget for Certified Area Relaxation v3a. Defaults to 2 seconds. */
      readonly maxSeconds?: number;
    };
  };
  readonly sourceConfig?: {
    readonly waterPolicy?: "use-byproduct" | "dump-byproduct";
    readonly acidPolicy?: "use-byproduct" | "dump-byproduct";
    readonly sewagePolicy?: "external-supply" | "self-produce";
  };
}

export interface HeadlessPlacedDevice {
  readonly id: string;
  readonly definitionId: string;
  readonly kind: "production" | "belt" | "pipe" | "storage" | "warehouse-port" | "warehouse-bus" | "power";
  readonly recipeId: string | null;
  readonly position: { readonly x: number; readonly y: number };
  readonly rotation: GridRotation;
  readonly width: number;
  readonly height: number;
}

/** Machine-readable CP-SAT execution status. */
export type CpSatStatus =
  | "disabled"
  | "executable-missing"
  | "dependency-missing"
  | "timeout"
  | "solver-failed"
  | "no-layouts"
  | "success";

/** Why the CP-SAT candidate batch stopped. */
export type CpSatStopReason = "completed" | "total-budget";

/** Python JSON output envelope for CP-SAT bridge results. */
export interface CpSatResultEnvelope {
  readonly layouts?: ReadonlyArray<ReadonlyArray<{
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly rotation: number;
    readonly width: number;
    readonly height: number;
  }>>;
  readonly status: CpSatStatus;
  readonly pythonVersion?: string;
  readonly orToolsVersion?: string;
  readonly attemptedCandidates?: number;
  readonly stoppedBy?: CpSatStopReason;
  readonly elapsedMs?: number;
  readonly errorMessage?: string;
}

/** A source port + target port pair attempted during routing. */
export interface RoutePortAttempt {
  readonly sourceGridPoint: { readonly x: number; readonly y: number };
  readonly targetGridPoint: { readonly x: number; readonly y: number };
}

/** A frontier blocker cell with its owner identity. */
export interface FrontierBlocker {
  readonly x: number;
  readonly y: number;
  readonly ownerDeviceId: string | null;
  readonly ownerKind: "production" | "logistics" | null;
}

/**
 * Placement-only proof that a failed lane cannot cross the immutable equipment
 * obstacle grid. Existing belts/pipes and route-order choices are deliberately
 * excluded, so this certificate may become a hard CP-SAT pose cut.
 */
export interface RoutePlacementConflictCertificate {
  readonly proof: "no-legal-endpoint" | "static-free-space-separator";
  readonly sourceIsBoundary: boolean;
  readonly targetIsBoundary: boolean;
  readonly sourceEndpointCount: number;
  readonly targetEndpointCount: number;
  /** Complete reachable-set size; only the count is serialized. */
  readonly reachableCellCount: number;
  /** Complete immutable separator size; only the count is serialized. */
  readonly separatorCellCount: number;
  /** Every movable pose that must remain fixed for the proof to stay valid. */
  readonly poseDeviceIds: readonly string[];
}

/** One undirected adjacency in a certified grid edge cut. */
export interface RouteCapacityCutEdge {
  readonly from: GridPoint;
  readonly to: GridPoint;
}

interface RouteCapacityConflictCertificateBase {
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly demand: number;
  readonly capacity: number;
  readonly deficit: number;
  readonly crossingLaneIds: readonly string[];
  /** Movable lane endpoints whose unchanged poses keep the cut demand mandatory. */
  readonly endpointPoseDeviceIds: readonly string[];
  /** Movable rectangles currently consuming slots on the certified cut. */
  readonly blockingPoseDeviceIds: readonly string[];
  /** Every movable endpoint/blocker pose that must remain fixed for the proof to stay valid. */
  readonly poseDeviceIds: readonly string[];
}

/**
 * Placement-only proof that a complete grid edge cut has fewer immutable free
 * crossing slots than the frozen material graph has mandatory lanes.
 */
export type RouteCapacityConflictCertificate = RouteCapacityConflictCertificateBase & (
  | {
    readonly proof: "static-cut-capacity";
    /** The cut lies between coordinate-1 and coordinate on the named axis. */
    readonly axis: "vertical" | "horizontal";
    readonly coordinate: number;
    /** Orthogonal cut offsets blocked by immutable equipment/frontage cells. */
    readonly fixedBlockedOffsets: readonly number[];
  }
  | {
    readonly proof: "static-general-cut-capacity";
    readonly axis: "general";
    readonly coordinate: null;
    /** Deterministic, complete boundary of the residual min-cut partition. */
    readonly cutEdges: readonly RouteCapacityCutEdge[];
    /** Edge indexes guaranteed blocked without fixing a movable device pose. */
    readonly fixedBlockedEdgeIndexes: readonly number[];
  }
);

/** Structured routing failure evidence bounded for determinism and JSON-safety. */
export interface RouteFailureEvidence {
  readonly itemId: string;
  readonly sourceDeviceId: string | null;
  readonly targetDeviceId: string | null;
  readonly kind: "belt" | "pipe";
  readonly attemptedPortPairs: readonly RoutePortAttempt[];
  /** Deterministically sorted grid points reachable from the source. */
  readonly reachableCells: readonly { readonly x: number; readonly y: number }[];
  /** Deterministically sorted frontier blocker cells with owner IDs. */
  readonly frontierBlockers: readonly FrontierBlocker[];
  /** Null when the frozen graph remains connected or lane allocation is mutable. */
  readonly placementConflict: RoutePlacementConflictCertificate | null;
  /** Null unless a frozen lane graph provably exceeds a complete static grid edge cut. */
  readonly capacityConflict: RouteCapacityConflictCertificate | null;
}

export type BoundingAreaOptimalityStatus =
  | "lower-bound-only"
  | "bounded"
  | "bounding-area-optimal"
  | "bound-unavailable";

/** Certified lower/upper bounds for the standalone charged bounding-area objective. */
export interface BoundingAreaOptimality {
  readonly status: BoundingAreaOptimalityStatus;
  readonly lowerBound?: number;
  /** Present only when the incumbent passes the complete strict routed-layout check. */
  readonly upperBound?: number;
  readonly absoluteGap?: number;
  readonly relativeGap?: number;
  readonly strictRoutedUpperBoundVerified: boolean;
  /** Individually valid bounds combined with max(), never by addition. */
  readonly lowerBoundSources: {
    readonly mandatoryDeviceArea?: number;
    readonly cpSatArea?: number;
  };
  readonly proof: {
    readonly constraintProfile: CertifiedAreaRelaxationResult["constraintProfile"];
    readonly objective: CertifiedAreaRelaxationResult["objective"];
    readonly solverStatus: CertifiedAreaRelaxationStatus;
    readonly rawBestObjectiveBound?: number;
    readonly certifiedIntegerLowerBound?: number;
    /** Placement-only witness from the relaxation; never a routed upper bound. */
    readonly masterIncumbentArea?: number;
    readonly pythonVersion?: string;
    readonly orToolsVersion?: string;
    readonly elapsedMs?: number;
  };
}

export interface HeadlessOptimizationResult {
  readonly blueprint: BlueprintDocument;
  readonly layout: {
    readonly limitWidth: number;
    readonly limitHeight: number;
    /** Charged width from the warehouse-unloader frontage; warehouse bus/base entities are excluded. */
    readonly usedWidth: number;
    /** Charged height anchored at the layout origin; warehouse shell depth remains part of construction height. */
    readonly usedHeight: number;
    readonly boundingArea: number;
    /** Physical footprint using frontage width while retaining origin-anchored construction height. */
    readonly physicalUsedWidth: number;
    readonly physicalUsedHeight: number;
    readonly physicalBoundingArea: number;
    readonly contourArea: number;
    /** Empty grid cells inside the axis-aligned bounding rectangle. */
    readonly boundingVoidCellCount: number;
    /** Empty cells fully enclosed by occupied cells and unreachable from the rectangle boundary. */
    readonly enclosedVoidCellCount: number;
    /** Convex contour area not occupied by a device or logistics cell. */
    readonly contourVoidArea: number;
    /** Non-bus occupied cells outside the warehouse-unloader frontage span. */
    readonly frontageOverflowCellCount: number;
    readonly equipmentArea: number;
    readonly utilization: number;
    readonly contourUtilization: number;
    readonly devices: readonly HeadlessPlacedDevice[];
    readonly productionDeviceCount: number;
    readonly logisticsDeviceCount: number;
    readonly beltCellCount: number;
    readonly areaExcludedBeltCellCount: number;
    readonly pipeCellCount: number;
    readonly storageDeviceCount: number;
    readonly warehousePortCount: number;
    readonly warehouseBusCount: number;
    readonly powerDeviceCount: number;
    /** Exact minimum number of non-overlapping diffusers covering every powered device. */
    readonly minimumPowerDeviceCount: number;
  };
  readonly production: {
    readonly targetCount: number;
    readonly recipeCount: number;
    readonly deviceCount: number;
    readonly unresolvedPerMinute: number;
  };
  readonly validation: {
    readonly topologyId: string;
    readonly deviceCount: number;
    readonly errorCount: number;
    readonly warningCount: number;
    readonly diagnostics: readonly SimulationCompileDiagnostic[];
    readonly routedConnectionCount: number;
    readonly internalConnectionCount: number;
    readonly boundaryConnectionCount: number;
    /** Planned material lanes after throughput splitting, without route geometry. */
    readonly materialConnections: readonly {
      readonly itemId: string;
      readonly kind: "belt" | "pipe";
      readonly perMinute: number;
      readonly sourceDeviceId: string | null;
      readonly targetDeviceId: string | null;
    }[];
    readonly productionConnectivityVerified: boolean;
    readonly productionThroughputVerified: boolean;
    readonly powerCoverageVerified: boolean;
    /** Bounded structured routing failure evidence captured during A* pathfinding. Empty when no failures occurred. */
    readonly routeFailureDiagnostics: readonly RouteFailureEvidence[];
  };
  readonly optimality: {
    readonly boundingArea: BoundingAreaOptimality;
  };
  readonly search: {
    readonly algorithm: "deterministic-lns-a-star" | "hybrid-cp-sat-lns-a-star";
    readonly initialLayout: "auto" | "topology-sequential";
    readonly scope: "local" | "global";
    readonly globalNeighborhoods: "layer-interlock" | "all";
    readonly seed: number;
    readonly requestedIterations: number;
    readonly packingCandidates: number;
    readonly routedCandidates: number;
    /** Material-routed candidates rejected only because no power placement covered every target. */
    readonly powerInfeasibleCandidates: number;
    /** User-requested route-order variants on the normal fast path. */
    readonly routingVariants: number;
    /** Maximum route-order variant count reached after bounded failure recovery. */
    readonly effectiveRoutingVariants: number;
    /** Additional packing candidates evaluated only after the requested beam found no solution. */
    readonly adaptiveCandidatesEvaluated: number;
    /** Additional route-order attempts made on the deepest initial failures. */
    readonly adaptiveRoutingAttempts: number;
    /** Fully routed feasible states retained for later multi-basin refinement. */
    readonly eliteStatesRetained: number;
    /** Maximum device-placement distance between any two retained elite states. */
    readonly eliteArchiveMaxDistance: number;
    /** Non-winning elite states used as refinement bases after the first round. */
    readonly alternativeRefinementBasesUsed: number;
    /** CP-SAT layouts emitted before the global-rebuild cheap funnel. */
    readonly globalRebuildCandidatesGenerated: number;
    /** Global-rebuild layouts that passed complete A* routing. */
    readonly globalRebuildCandidatesRouted: number;
    /** Global-rebuild layouts that improved the winning objective. */
    readonly globalRebuildCandidatesImproved: number;
    /** Distinct placement-proven routing conflicts learned as CP-SAT pose cuts. */
    readonly certifiedRouteFailureCutsLearned: number;
    /** Distinct generalized grid edge-cut capacity inequalities retained by CP-SAT. */
    readonly certifiedRouteCapacityCutsLearned: number;
    /** Objective-guided partial-rebuild layouts emitted before the cheap funnel. */
    readonly partialRebuildCandidatesGenerated: number;
    /** Partial-rebuild layouts that passed complete A* routing. */
    readonly partialRebuildCandidatesRouted: number;
    /** Partial-rebuild layouts that improved the winning objective. */
    readonly partialRebuildCandidatesImproved: number;
    /** Python-side wall time accumulated by bounded global-rebuild CP-SAT batches. */
    readonly globalRebuildCpSatElapsedMs: number;
    /** Width-feasible terminal/upstream layer-interlock placements emitted before routing. */
    readonly globalLayerInterlockCandidatesGenerated: number;
    /** Terminal/upstream layer families proved too wide before placement or A*. */
    readonly globalLayerInterlockWidthRejected: number;
    /** Layer-interlock placements that passed complete routing and power placement. */
    readonly globalLayerInterlockCandidatesRouted: number;
    /** Routed layer-interlock placements that strictly improved the incumbent. */
    readonly globalLayerInterlockCandidatesImproved: number;
    /** Bounded global layer-width planning passes attempted. */
    readonly globalLayerInterlockPasses: number;
    /** Strict improvements accepted from the global layer-interlock neighborhood. */
    readonly globalLayerInterlockTransitions: number;
    /** Why global layer-width planning stopped. */
    readonly globalLayerInterlockStoppedBy:
      | "disabled"
      | "fixed-point"
      | "width-infeasible"
      | "safety-bound";
    /** Attributed hotspot seeds and direct flow neighbors selected for partial rebuild. */
    readonly objectiveHotspotDeviceIds: readonly string[];
    readonly cpSatCandidates: number;
    /** Cheap-filtered initial candidates available before the expensive routing beam. */
    readonly initialCandidatesGenerated: number;
    /** Initial candidates retained for full A* routing. */
    readonly initialCandidatesSelected: number;
    /** Cheap-filtered warehouse candidates available before the expensive routing beam. */
    readonly warehouseCandidatesGenerated: number;
    /** Warehouse candidates retained for full A* routing, including the deterministic baseline. */
    readonly warehouseCandidatesSelected: number;
    readonly clusterCandidatesGenerated: number;
    readonly clusterCandidatesCheapRejected: number;
    readonly clusterCandidatesRouted: number;
    readonly clusterCandidatesAStarRejected: number;
    readonly clusterCandidatesImproved: number;
    /** Route-order variants whose evaluation actually started. */
    readonly routingVariantAttempts: number;
    /** Explicit local compactions rejected because their device rectangle already loses on area. */
    readonly localAreaLowerBoundRejected: number;
    /** Preservation-based local reroute calls, including failed calls. */
    readonly localRepairAttempts: number;
    /** Actual cold local reroutes after preservation was exhausted. */
    readonly localFullRerouteAttempts: number;
    /** Cold reroutes skipped by reusing an identical all-ripped failure state. */
    readonly localFullRipFailureStatesReused: number;
    /** Full local closure passes completed after the ordinary refinement beam. */
    readonly localConvergencePasses: number;
    /** Strict objective improvements accepted by exact cuts, section cuts, movement, or routing polish. */
    readonly localConvergenceTransitions: number;
    /** Why the local closure stopped; fixed-point is the normal converged result. */
    readonly localConvergenceStoppedBy: "disabled" | "fixed-point" | "safety-bound";
    /** Remaining fixed-geometry route variants omitted after the first feasible local compaction route. */
    readonly localRoutingVariantsSkippedAfterSuccess: number;
    /** Port pairs rejected by relaxed equipment-wall connectivity before strict A*. */
    readonly relaxedConnectivityRejectedPortPairs: number;
    /** Topology-sequential feasibility seeds ranked before cold rerouting. */
    readonly seededInitialCandidatesRanked: number;
    /** Topology seeds that received every requested cold route variant. */
    readonly seededInitialCandidatesPolished: number;
    /** Cold topology-seed variants omitted; zero in quality-first complete evaluation. */
    readonly seededInitialColdVariantsSkipped: number;
    /** CP-SAT execution status for observability. */
    readonly cpSatStatus: CpSatStatus;
    /** Python version reported by the CP-SAT bridge, if available. */
    readonly cpSatPythonVersion?: string;
    /** OR-Tools version reported by the CP-SAT bridge, if available. */
    readonly cpSatOrToolsVersion?: string;
    /** Configured wall-clock solver budget shared by the initial CP-SAT candidate batch. */
    readonly cpSatBudgetSeconds?: number;
    /** Candidate variants whose CP-SAT model construction was started. */
    readonly cpSatAttemptedCandidates?: number;
    /** Whether every requested variant ran or the shared budget was exhausted. */
    readonly cpSatStoppedBy?: CpSatStopReason;
    /** Python-side elapsed wall time for the initial CP-SAT candidate batch. */
    readonly cpSatElapsedMs?: number;
    /** Winning objective priority list and lexicographic vector. */
    readonly objective: {
      readonly priorities: readonly LayoutObjectiveMetric[];
      readonly vector: ObjectiveVector;
    };
  };
}

/** Geometry-free, instance-level material graph used to audit topology order. */
export interface HeadlessMaterialGraph {
  readonly name: string;
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: "production" | "storage" | "warehouse-port";
    readonly definitionId: string;
    readonly definitionNameKey: string;
    readonly recipeId: string | null;
    readonly componentId: string;
    readonly layer: number;
    readonly inputItemIds: readonly string[];
    readonly outputItemIds: readonly string[];
  }[];
  readonly edges: readonly {
    readonly sourceId: string;
    readonly targetId: string;
    readonly itemId: string;
    readonly laneCount: number;
  }[];
  readonly components: readonly {
    readonly id: string;
    readonly layer: number;
    readonly deviceIds: readonly string[];
    readonly cyclic: boolean;
  }[];
}
