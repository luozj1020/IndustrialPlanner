import {
  createParetoMaximalBoxFrontier,
  orderBoxFrontierForWarmStart,
  type BoxDimensions,
} from "./box-frontier";
import {
  solveBoundedBoxMaster,
  type BoundedBoxMasterDevice,
  type BoundedBoxMasterOptions,
  type BoundedBoxMasterPlacement,
  type BoundedBoxMasterResult,
  type BoundedBoxMasterStatus,
} from "./bounded-box-master";

export const BOUNDED_BOX_SAT_SEARCH_PROFILE = "bounded-box-sat-search-m1" as const;

export const DEFAULT_BOUNDED_BOX_SEARCH = Object.freeze({
  maxBoxes: 8,
  maxSecondsPerBox: 1,
  candidatesPerBox: 4,
});

export interface BoundedBoxPlacementEvaluation {
  /** A complete route and power witness whose charged footprint fits the box. */
  readonly routedWitness: boolean;
  /** The witness became a strictly better incumbent under the production objective. */
  readonly improved: boolean;
}

export interface BoundedBoxSearchAttempt {
  readonly box: BoxDimensions;
  readonly masterStatus: BoundedBoxMasterStatus;
  readonly placementCount: number;
  readonly elapsedMs?: number;
  readonly routedWitnesses: number;
}

export interface BoundedBoxSatSearchResult {
  readonly constraintProfile: typeof BOUNDED_BOX_SAT_SEARCH_PROFILE;
  readonly status: "improved" | "no-routed-improvement" | "empty-frontier" | "master-unavailable";
  /** Complete maximal staircase before the user-configured attempt cap. */
  readonly frontierSize: number;
  readonly boxesSelected: number;
  readonly boxesAttempted: number;
  readonly masterPlacementsEvaluated: number;
  readonly routedWitnesses: number;
  readonly improvements: number;
  readonly warmStartUpperBound: number;
  readonly boxesSat: number;
  readonly boxesUnknown: number;
  readonly elapsedMs: number;
  readonly timeToFirstImprovementMs?: number;
  readonly masterStatusCounts: Readonly<Record<BoundedBoxMasterStatus, number>>;
  readonly attempts: readonly BoundedBoxSearchAttempt[];
  readonly improvedBox?: BoxDimensions;
}

export interface BoundedBoxSatSearchOptions {
  readonly devices: readonly BoundedBoxMasterDevice[];
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly incumbentBox: { readonly width: number; readonly height: number };
  readonly incumbentArea: number;
  readonly minimumArea: number;
  readonly allowRotate: boolean;
  readonly maxBoxes?: number;
  readonly maxSecondsPerBox?: number;
  readonly candidatesPerBox?: number;
  readonly seed: number;
  readonly evaluatePlacement: (options: {
    readonly box: BoxDimensions;
    readonly placement: readonly BoundedBoxMasterPlacement[];
    readonly placementIndex: number;
  }) => BoundedBoxPlacementEvaluation;
  /** Deterministic test seam. */
  readonly solveMaster?: (options: BoundedBoxMasterOptions) => BoundedBoxMasterResult;
}

/**
 * Search the better-than-incumbent staircase for a fully routed SAT witness.
 *
 * M1 intentionally has no UNSAT result. Even a `master-infeasible` attempt is
 * retained only as diagnostic evidence until routing separation and exhaustive
 * box closure are introduced in later milestones.
 */
export function searchBetterBoundedBoxPlacements(
  options: BoundedBoxSatSearchOptions,
): BoundedBoxSatSearchResult {
  const started = Date.now();
  requirePositiveInteger(options.mapWidth, "mapWidth");
  requirePositiveInteger(options.mapHeight, "mapHeight");
  requirePositiveInteger(options.incumbentBox.width, "incumbentBox.width");
  requirePositiveInteger(options.incumbentBox.height, "incumbentBox.height");
  requirePositiveInteger(options.incumbentArea, "incumbentArea");
  requireNonNegativeInteger(options.minimumArea, "minimumArea");
  const maxBoxes = requireBoundedInteger(
    options.maxBoxes ?? DEFAULT_BOUNDED_BOX_SEARCH.maxBoxes,
    "maxBoxes",
    1,
    64,
  );
  const candidatesPerBox = requireBoundedInteger(
    options.candidatesPerBox ?? DEFAULT_BOUNDED_BOX_SEARCH.candidatesPerBox,
    "candidatesPerBox",
    1,
    64,
  );
  const maxSecondsPerBox = options.maxSecondsPerBox
    ?? DEFAULT_BOUNDED_BOX_SEARCH.maxSecondsPerBox;
  if (!Number.isFinite(maxSecondsPerBox)
    || maxSecondsPerBox <= 0
    || maxSecondsPerBox > 30) {
    throw new Error(
      `maxSecondsPerBox must be in (0, 30], received ${maxSecondsPerBox}`,
    );
  }
  if (!Number.isSafeInteger(options.seed)) {
    throw new Error(`seed must be a safe integer, received ${options.seed}`);
  }

  const chargedDevices = options.devices.filter((device) => device.charged !== false);
  const minimumWidth = chargedDevices.reduce((maximum, device) => Math.max(
    maximum,
    options.allowRotate ? Math.min(device.width, device.height) : device.width,
  ), 1);
  const minimumHeight = chargedDevices.reduce((maximum, device) => Math.max(
    maximum,
    options.allowRotate ? Math.min(device.width, device.height) : device.height,
  ), 1);
  const frontier = orderBoxFrontierForWarmStart(
    createParetoMaximalBoxFrontier({
      maxArea: options.incumbentArea - 1,
      maxWidth: options.mapWidth,
      maxHeight: options.mapHeight,
      minArea: options.minimumArea,
      minWidth: minimumWidth,
      minHeight: minimumHeight,
    }),
    options.incumbentBox,
  );
  const selectedBoxes = frontier.slice(0, maxBoxes);
  const masterStatusCounts = createMasterStatusCounts();
  const attempts: BoundedBoxSearchAttempt[] = [];
  let masterPlacementsEvaluated = 0;
  let routedWitnesses = 0;
  let improvements = 0;
  const solveMaster = options.solveMaster ?? solveBoundedBoxMaster;
  let masterUnavailable = false;

  for (const [boxIndex, box] of selectedBoxes.entries()) {
    const masterResult = solveMaster({
      devices: options.devices,
      mapWidth: options.mapWidth,
      mapHeight: options.mapHeight,
      boxWidth: box.width,
      boxHeight: box.height,
      allowRotate: options.allowRotate,
      maxSeconds: maxSecondsPerBox,
      candidateCount: candidatesPerBox,
      seed: deriveBoxSeed(options.seed, box, boxIndex),
    });
    masterStatusCounts[masterResult.status] += 1;
    attempts.push({
      box,
      masterStatus: masterResult.status,
      placementCount: masterResult.placements.length,
      routedWitnesses: 0,
      ...(masterResult.elapsedMs === undefined ? {} : { elapsedMs: masterResult.elapsedMs }),
    });
    if (masterResult.status === "executable-missing"
      || masterResult.status === "dependency-missing"
      || masterResult.status === "solver-failed") {
      masterUnavailable = true;
      break;
    }
    for (const [placementIndex, placement] of masterResult.placements.entries()) {
      masterPlacementsEvaluated += 1;
      const evaluation = options.evaluatePlacement({ box, placement, placementIndex });
      if (evaluation.improved && !evaluation.routedWitness) {
        throw new Error("A bounded-box improvement requires a strict routed witness");
      }
      if (evaluation.routedWitness) {
        routedWitnesses += 1;
        const previous = attempts[attempts.length - 1]!;
        attempts[attempts.length - 1] = { ...previous, routedWitnesses: previous.routedWitnesses + 1 };
      }
      if (!evaluation.improved) continue;
      improvements += 1;
      return {
        constraintProfile: BOUNDED_BOX_SAT_SEARCH_PROFILE,
        status: "improved",
        frontierSize: frontier.length,
        boxesSelected: selectedBoxes.length,
        boxesAttempted: attempts.length,
        masterPlacementsEvaluated,
        routedWitnesses,
        improvements,
        warmStartUpperBound: options.incumbentArea,
        boxesSat: attempts.filter((attempt) => attempt.routedWitnesses > 0).length,
        boxesUnknown: attempts.filter((attempt) => attempt.routedWitnesses === 0).length,
        elapsedMs: Date.now() - started,
        timeToFirstImprovementMs: Date.now() - started,
        masterStatusCounts,
        attempts,
        improvedBox: box,
      };
    }
  }

  return {
    constraintProfile: BOUNDED_BOX_SAT_SEARCH_PROFILE,
    status: frontier.length === 0
      ? "empty-frontier"
      : masterUnavailable
        ? "master-unavailable"
        : "no-routed-improvement",
    frontierSize: frontier.length,
    boxesSelected: selectedBoxes.length,
    boxesAttempted: attempts.length,
    masterPlacementsEvaluated,
    routedWitnesses,
    improvements,
    warmStartUpperBound: options.incumbentArea,
    boxesSat: attempts.filter((attempt) => attempt.routedWitnesses > 0).length,
    boxesUnknown: attempts.filter((attempt) => attempt.routedWitnesses === 0).length,
    elapsedMs: Date.now() - started,
    masterStatusCounts,
    attempts,
  };
}

function createMasterStatusCounts(): Record<BoundedBoxMasterStatus, number> {
  return {
    success: 0,
    "master-infeasible": 0,
    unknown: 0,
    "executable-missing": 0,
    "dependency-missing": 0,
    timeout: 0,
    "solver-failed": 0,
  };
}

function deriveBoxSeed(seed: number, box: BoxDimensions, boxIndex: number): number {
  const mixed = BigInt(seed)
    + BigInt(box.width) * 73_856_093n
    + BigInt(box.height) * 19_349_663n
    + BigInt(boxIndex) * 83_492_791n;
  return Number((mixed % 2_147_483_647n + 2_147_483_647n) % 2_147_483_647n);
}

function requirePositiveInteger(value: number, label: string): number {
  return requireBoundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function requireNonNegativeInteger(value: number, label: string): number {
  return requireBoundedInteger(value, label, 0, Number.MAX_SAFE_INTEGER);
}

function requireBoundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}, received ${value}`);
  }
  return value;
}
