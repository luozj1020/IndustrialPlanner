import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GridEdge, GridPoint, GridRotation } from "@/domain/shared/grid";

export const BOUNDED_BOX_MASTER_PROFILE = "bounded-box-placement-v1" as const;

export interface BoundedBoxMasterPlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: GridRotation;
}

export interface BoundedBoxMasterDevice {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Uncharged auxiliary entities use the whole physical map. */
  readonly charged?: boolean;
  readonly warehouseRole?: "source" | "segment" | "port";
  readonly busEdges?: Readonly<Partial<Record<GridRotation, GridEdge>>>;
  /** Necessary one-cell accessibility; unused physical ports may be masked. */
  readonly portRequirements?: readonly {
    readonly requiredCount: number;
    readonly ports: readonly {
      readonly offsets: Readonly<Partial<Record<GridRotation, GridPoint>>>;
    }[];
  }[];
  readonly hintPlacement?: Pick<BoundedBoxMasterPlacement, "x" | "y" | "rotation">;
}

export type BoundedBoxMasterStatus =
  | "success"
  | "master-infeasible"
  | "unknown"
  | "executable-missing"
  | "dependency-missing"
  | "timeout"
  | "solver-failed";

export type BoundedBoxMasterStopReason =
  | "candidate-limit"
  | "exhausted"
  | "total-budget";

export interface BoundedBoxMasterResult {
  readonly constraintProfile: typeof BOUNDED_BOX_MASTER_PROFILE;
  readonly status: BoundedBoxMasterStatus;
  readonly placements: readonly (readonly BoundedBoxMasterPlacement[])[];
  readonly pythonVersion?: string;
  readonly orToolsVersion?: string;
  readonly attemptedCandidates?: number;
  readonly stoppedBy?: BoundedBoxMasterStopReason;
  readonly elapsedMs?: number;
}

export interface BoundedBoxMasterOptions {
  readonly devices: readonly BoundedBoxMasterDevice[];
  /** Physical map width. Charged rectangles may translate inside this domain. */
  readonly mapWidth: number;
  readonly mapHeight: number;
  /** Maximum charged horizontal span and origin-anchored height. */
  readonly boxWidth: number;
  readonly boxHeight: number;
  readonly allowRotate: boolean;
  readonly maxSeconds: number;
  readonly candidateCount: number;
  readonly seed: number;
  /** Test/embedding seam; production callers use the adjacent Python module. */
  readonly scriptPath?: string;
}

const FAILURE_PRIORITY: Readonly<Record<
  Extract<BoundedBoxMasterStatus,
    "executable-missing" | "dependency-missing" | "timeout" | "solver-failed">,
  number
>> = {
  "executable-missing": 0,
  "dependency-missing": 1,
  "solver-failed": 2,
  timeout: 3,
};

/**
 * Enumerate placement witnesses for one fixed charged box.
 *
 * This is deliberately a satisfaction model: it has no weighted or geometric
 * proxy objective, no macro constraints, no escape-depth halo, no learned cut,
 * and no cross-device permutation symmetry. `master-infeasible` describes only
 * this placement master in M1; callers must not report full routing UNSAT.
 */
export function solveBoundedBoxMaster(
  options: BoundedBoxMasterOptions,
): BoundedBoxMasterResult {
  validateOptions(options);
  if (options.devices.length === 0) {
    return {
      constraintProfile: BOUNDED_BOX_MASTER_PROFILE,
      status: "success",
      placements: [[]],
      attemptedCandidates: 1,
      stoppedBy: "exhausted",
      elapsedMs: 0,
    };
  }

  const scriptPath = options.scriptPath ?? resolveMasterScriptPath();
  const input = JSON.stringify({
    constraintProfile: BOUNDED_BOX_MASTER_PROFILE,
    devices: options.devices.map((device) => ({
      id: device.id,
      width: device.width,
      height: device.height,
      ...(device.charged === undefined ? {} : { charged: device.charged }),
      ...(device.warehouseRole === undefined ? {} : { warehouseRole: device.warehouseRole }),
      ...(device.busEdges === undefined ? {} : { busEdges: device.busEdges }),
      ...(device.portRequirements === undefined ? {} : {
        portRequirements: device.portRequirements.map((requirement) => ({
          requiredCount: requirement.requiredCount,
          ports: requirement.ports.map((port) => ({ offsets: port.offsets })),
        })),
      }),
      ...serializeUsableHint(device, options),
    })),
    mapWidth: options.mapWidth,
    mapHeight: options.mapHeight,
    boxWidth: options.boxWidth,
    boxHeight: options.boxHeight,
    allowRotate: options.allowRotate,
    maxSeconds: options.maxSeconds,
    candidateCount: options.candidateCount,
    seed: options.seed,
  });
  const executables = [
    process.env["INDUSTRIAL_PLANNER_PYTHON"],
    "python3",
    "python",
  ].filter((value, index, all): value is string =>
    value !== undefined && value.length > 0 && all.indexOf(value) === index);

  let aggregateFailure: Extract<BoundedBoxMasterStatus,
    "executable-missing" | "dependency-missing" | "timeout" | "solver-failed">
    = "executable-missing";
  let aggregatePythonVersion: string | undefined;
  let aggregateOrToolsVersion: string | undefined;
  for (const executable of executables) {
    const result = spawnSync(executable, [scriptPath], {
      input,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: Math.ceil(options.maxSeconds * 1_000 + 15_000),
    });
    if (result.error !== undefined
      && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    const processErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (result.signal !== null || processErrorCode === "ETIMEDOUT") {
      aggregateFailure = selectFailure(aggregateFailure, "timeout");
      continue;
    }
    if (result.error !== undefined || result.status !== 0) {
      aggregateFailure = selectFailure(aggregateFailure, "solver-failed");
      continue;
    }
    if (result.stdout.trim().length === 0) {
      aggregateFailure = selectFailure(aggregateFailure, "solver-failed");
      continue;
    }

    try {
      const parsed = parseEnvelope(
        JSON.parse(result.stdout) as Record<string, unknown>,
        options,
      );
      aggregatePythonVersion = parsed.pythonVersion ?? aggregatePythonVersion;
      aggregateOrToolsVersion = parsed.orToolsVersion ?? aggregateOrToolsVersion;
      if (parsed.status === "success"
        || parsed.status === "master-infeasible"
        || parsed.status === "unknown") return parsed;
      aggregateFailure = selectFailure(aggregateFailure, parsed.status);
    } catch {
      aggregateFailure = selectFailure(aggregateFailure, "solver-failed");
    }
  }

  return {
    constraintProfile: BOUNDED_BOX_MASTER_PROFILE,
    status: aggregateFailure,
    placements: [],
    ...(aggregatePythonVersion === undefined ? {} : { pythonVersion: aggregatePythonVersion }),
    ...(aggregateOrToolsVersion === undefined ? {} : { orToolsVersion: aggregateOrToolsVersion }),
  };
}

function resolveMasterScriptPath(): string {
  try {
    return fileURLToPath(new URL("./bounded-box-master.py", import.meta.url));
  } catch {
    return resolve(process.cwd(), "src/headless/bounded-box-master.py");
  }
}

function serializeUsableHint(
  device: BoundedBoxMasterDevice,
  options: BoundedBoxMasterOptions,
): { readonly hintPlacement?: BoundedBoxMasterDevice["hintPlacement"] } {
  const hint = device.hintPlacement;
  if (hint === undefined) return {};
  const rotation = hint.rotation;
  if (!isGridRotation(rotation) || (!options.allowRotate && rotation !== 0)) return {};
  const swapsFootprint = rotation === 90 || rotation === 270;
  const width = swapsFootprint ? device.height : device.width;
  const height = swapsFootprint ? device.width : device.height;
  if (!Number.isSafeInteger(hint.x)
    || !Number.isSafeInteger(hint.y)
    || hint.x < 0
    || hint.y < 0
    || hint.x + width > options.mapWidth
    || hint.y + height > (device.charged === false ? options.mapHeight : options.boxHeight)) return {};
  return { hintPlacement: { x: hint.x, y: hint.y, rotation } };
}

function validateOptions(options: BoundedBoxMasterOptions): void {
  requirePositiveInteger(options.mapWidth, "mapWidth");
  requirePositiveInteger(options.mapHeight, "mapHeight");
  requirePositiveInteger(options.boxWidth, "boxWidth");
  requirePositiveInteger(options.boxHeight, "boxHeight");
  if (options.boxWidth > options.mapWidth || options.boxHeight > options.mapHeight) {
    throw new Error("Bounded box must fit inside the physical map dimensions");
  }
  if (typeof options.allowRotate !== "boolean") {
    throw new Error("allowRotate must be a boolean");
  }
  if (!Number.isFinite(options.maxSeconds)
    || options.maxSeconds <= 0
    || options.maxSeconds > 30) {
    throw new Error(`maxSeconds must be in (0, 30], received ${options.maxSeconds}`);
  }
  if (!Number.isSafeInteger(options.candidateCount)
    || options.candidateCount < 1
    || options.candidateCount > 64) {
    throw new Error(`candidateCount must be an integer from 1 to 64, received ${options.candidateCount}`);
  }
  if (!Number.isSafeInteger(options.seed)) {
    throw new Error(`seed must be a safe integer, received ${options.seed}`);
  }
  const ids = new Set<string>();
  for (const device of options.devices) {
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new Error("Bounded-box device IDs must be non-empty strings");
    }
    if (ids.has(device.id)) throw new Error(`Duplicate bounded-box device ID: ${device.id}`);
    ids.add(device.id);
    requirePositiveInteger(device.width, `${device.id}.width`);
    requirePositiveInteger(device.height, `${device.id}.height`);
  }
}

function parseEnvelope(
  value: Record<string, unknown>,
  options: BoundedBoxMasterOptions,
): BoundedBoxMasterResult {
  if (value["constraintProfile"] !== BOUNDED_BOX_MASTER_PROFILE) {
    throw new Error("Unexpected bounded-box master profile");
  }
  const status = value["status"];
  if (!isStatus(status)) throw new Error("Unexpected bounded-box master status");
  const pythonVersion = optionalString(value["pythonVersion"]);
  const orToolsVersion = optionalString(value["orToolsVersion"]);
  const attemptedCandidates = optionalNonNegativeInteger(value["attemptedCandidates"]);
  const stoppedBy = isStopReason(value["stoppedBy"]) ? value["stoppedBy"] : undefined;
  const elapsedMs = optionalNonNegativeFiniteNumber(value["elapsedMs"]);
  const rawPlacements = value["placements"];
  if (!Array.isArray(rawPlacements)) throw new Error("placements must be an array");
  if (rawPlacements.length > options.candidateCount) {
    throw new Error("Placement witness count exceeds the requested limit");
  }
  const placements = rawPlacements.map((candidate) =>
    parseAndValidatePlacement(candidate, options));
  if (status === "success" && placements.length === 0) {
    throw new Error("Successful bounded-box master returned no placement witness");
  }
  if (status !== "success" && placements.length > 0) {
    throw new Error("Failed bounded-box master returned placement witnesses");
  }
  return {
    constraintProfile: BOUNDED_BOX_MASTER_PROFILE,
    status,
    placements,
    ...(pythonVersion === undefined ? {} : { pythonVersion }),
    ...(orToolsVersion === undefined ? {} : { orToolsVersion }),
    ...(attemptedCandidates === undefined ? {} : { attemptedCandidates }),
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  };
}

function parseAndValidatePlacement(
  value: unknown,
  options: BoundedBoxMasterOptions,
): readonly BoundedBoxMasterPlacement[] {
  if (!Array.isArray(value)) throw new Error("placement witness must be an array");
  const deviceById = new Map(options.devices.map((device) => [device.id, device]));
  const seenIds = new Set<string>();
  const placements = value.map((entry): BoundedBoxMasterPlacement => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("placement entry must be an object");
    }
    const candidate = entry as Record<string, unknown>;
    const id = candidate["id"];
    const x = candidate["x"];
    const y = candidate["y"];
    const width = candidate["width"];
    const height = candidate["height"];
    const rotation = candidate["rotation"];
    if (typeof id !== "string" || seenIds.has(id)) {
      throw new Error("placement IDs must be unique strings");
    }
    const device = deviceById.get(id);
    if (device === undefined) throw new Error(`Unknown placement device ${id}`);
    seenIds.add(id);
    if (typeof x !== "number" || typeof y !== "number"
      || typeof width !== "number" || typeof height !== "number"
      || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)
      || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || !isGridRotation(rotation)) {
      throw new Error(`Malformed placement for ${id}`);
    }
    if (!options.allowRotate && rotation !== 0) {
      throw new Error(`Rotation is disabled for ${id}`);
    }
    const swapsFootprint = rotation === 90 || rotation === 270;
    const expectedWidth = swapsFootprint ? device.height : device.width;
    const expectedHeight = swapsFootprint ? device.width : device.height;
    if (width !== expectedWidth || height !== expectedHeight) {
      throw new Error(`Rotated dimensions do not match ${id}`);
    }
    if (x < 0 || y < 0
      || x + width > options.mapWidth
      || y + height > options.mapHeight
      || (device.charged !== false && y + height > options.boxHeight)) {
      throw new Error(`Placement ${id} lies outside its bounded domain`);
    }
    return { id, x, y, width, height, rotation };
  });
  if (seenIds.size !== options.devices.length) {
    throw new Error("Placement witness does not contain every bounded-box device");
  }
  const charged = placements.filter((placement) => deviceById.get(placement.id)!.charged !== false);
  const minimumX = Math.min(...charged.map((placement) => placement.x));
  const maximumX = Math.max(...charged.map((placement) => placement.x + placement.width));
  if (maximumX - minimumX > options.boxWidth) {
    throw new Error("Placement witness exceeds the charged horizontal span");
  }
  for (let leftIndex = 0; leftIndex < placements.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < placements.length; rightIndex += 1) {
      const left = placements[leftIndex]!;
      const right = placements[rightIndex]!;
      if (left.x < right.x + right.width
        && left.x + left.width > right.x
        && left.y < right.y + right.height
        && left.y + left.height > right.y) {
        throw new Error(`Placement witness overlaps ${left.id} and ${right.id}`);
      }
    }
  }
  return placements;
}

function selectFailure(
  current: Extract<BoundedBoxMasterStatus,
    "executable-missing" | "dependency-missing" | "timeout" | "solver-failed">,
  candidate: BoundedBoxMasterStatus,
): typeof current {
  if (candidate === "success" || candidate === "master-infeasible" || candidate === "unknown") {
    return current;
  }
  return FAILURE_PRIORITY[candidate] > FAILURE_PRIORITY[current] ? candidate : current;
}

function isStatus(value: unknown): value is BoundedBoxMasterStatus {
  return value === "success"
    || value === "master-infeasible"
    || value === "unknown"
    || value === "executable-missing"
    || value === "dependency-missing"
    || value === "timeout"
    || value === "solver-failed";
}

function isStopReason(value: unknown): value is BoundedBoxMasterStopReason {
  return value === "candidate-limit" || value === "exhausted" || value === "total-budget";
}

function isGridRotation(value: unknown): value is GridRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function optionalNonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer, received ${value}`);
  }
  return value;
}
