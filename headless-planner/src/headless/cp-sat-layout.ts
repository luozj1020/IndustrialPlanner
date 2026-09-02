import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { GridEdge, GridPoint, GridRotation } from "../domain/shared/grid";
import type { CpSatStatus, CpSatStopReason, LayoutObjectiveMetric } from "./types";

export interface CpSatLayoutPortRequirement {
  readonly direction: "input" | "output";
  readonly requiredCount: number;
  /** Consecutive in-bounds cells that must remain free along the port normal. */
  readonly escapeDepth: number;
  readonly ports: readonly {
    readonly id: string;
    readonly offsets: Readonly<Partial<Record<GridRotation, GridPoint>>>;
    readonly escapeEdges: Readonly<Partial<Record<GridRotation, GridEdge>>>;
  }[];
}

export interface CpSatLayoutDevice {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly portRequirements?: readonly CpSatLayoutPortRequirement[];
  readonly hintPlacement?: {
    readonly x: number;
    readonly y: number;
    readonly rotation: GridRotation;
  };
  /** Keep an anchor outside the destroyed LNS cluster at its incumbent pose. */
  readonly fixedPlacement?: {
    readonly x: number;
    readonly y: number;
    readonly rotation: GridRotation;
  };
}

export interface CpSatLayoutObstacle {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CpSatLayoutEdge {
  readonly sourceId: string;
  readonly targetId: string;
  /** Material carried by this edge. Kept distinct so different logistics lanes are not merged. */
  readonly itemId: string;
  /** Number of independent belt/pipe lanes required at full throughput. */
  readonly laneCount: number;
  readonly weight: number;
  readonly sourceEdges: Readonly<Partial<Record<GridRotation, GridEdge>>>;
  readonly targetEdges: Readonly<Partial<Record<GridRotation, GridEdge>>>;
}

export interface CpSatLayoutCluster {
  readonly terminalId: string;
  readonly producerIds: readonly string[];
  readonly sharedUpstreamIds: readonly string[];
}

export interface CpSatLayoutPlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: GridRotation;
  readonly width: number;
  readonly height: number;
}

export interface CpSatLayoutResult {
  readonly layouts: readonly CpSatLayoutPlacement[][];
  readonly status: CpSatStatus;
  readonly pythonVersion?: string;
  readonly orToolsVersion?: string;
  /** Number of candidate variants whose model construction was started. */
  readonly attemptedCandidates?: number;
  /** Whether every requested variant ran or the shared batch budget was exhausted. */
  readonly stoppedBy?: CpSatStopReason;
  /** Python-side wall time for the complete candidate batch. */
  readonly elapsedMs?: number;
}

/** Frozen CP-SAT proxy weights corresponding to the representable layout metrics. */
export const DEFAULT_CP_SAT_OBJECTIVE_WEIGHTS = Object.freeze({
  boundingArea: 1,
  maxSide: 1,
  logisticsCells: 1,
}) satisfies Readonly<Partial<Record<LayoutObjectiveMetric, number>>>;

const CP_SAT_FAILURE_PRIORITY: Readonly<Record<Exclude<CpSatStatus, "disabled" | "success" | "no-layouts">, number>> = {
  "executable-missing": 0,
  "dependency-missing": 1,
  "solver-failed": 2,
  timeout: 3,
};

export function solveCpSatLayouts(options: {
  readonly devices: readonly CpSatLayoutDevice[];
  readonly fixedObstacles?: readonly CpSatLayoutObstacle[];
  readonly edges: readonly CpSatLayoutEdge[];
  readonly clusters: readonly CpSatLayoutCluster[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly routingClearance: number;
  readonly allowRotate: boolean;
  readonly maxSeconds: number;
  readonly candidateCount: number;
  readonly seed: number;
  /** A* rejected pose subsets; each cut requires at least one listed device to change pose. */
  readonly forbiddenLayouts?: readonly (readonly CpSatLayoutPlacement[])[];
  /** Optional named weights for CP-SAT proxy terms mapped to objective metric names.
   *  When absent, Python uses backward-compatible defaults matching the pre-slice formula. */
  readonly objectiveWeights?: Readonly<Partial<Record<LayoutObjectiveMetric, number>>>;
  /** Test/embedding seam; production callers use the adjacent Python module. */
  readonly scriptPath?: string;
}): CpSatLayoutResult {
  if (options.devices.length === 0) {
    return { layouts: [], status: "no-layouts" };
  }
  const scriptPath = options.scriptPath ?? fileURLToPath(new URL("./cp-sat-layout.py", import.meta.url));
  const executables = [
    process.env["INDUSTRIAL_PLANNER_PYTHON"],
    "python3",
    "python",
  ].filter((value, index, all): value is string =>
    value !== undefined && value.length > 0 && all.indexOf(value) === index);
  const input = JSON.stringify(options);

  let aggregateFailure: Exclude<CpSatStatus, "disabled" | "success" | "no-layouts"> = "executable-missing";
  let aggregatePythonVersion: string | undefined;
  let aggregateOrToolsVersion: string | undefined;
  for (const executable of executables) {
    // Python shares maxSeconds across the entire candidate batch. This outer
    // guard allows interpreter startup/JSON overhead without multiplying the
    // wall-clock limit by candidateCount.
    const timeoutMs = Math.ceil(Math.max(0.1, options.maxSeconds) * 1_000 + 15_000);
    const result = spawnSync(executable, [scriptPath], {
      input,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
    });

    // Executable not found (ENOENT)
    if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
        console.error(`[cp-sat:${executable}] executable not found`);
      }
      continue;
    }

    const processErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (result.signal !== null || processErrorCode === "ETIMEDOUT") {
      aggregateFailure = selectCpSatFailure(aggregateFailure, "timeout");
      if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
        console.error(`[cp-sat:${executable}] killed by signal ${result.signal}`);
      }
      continue;
    }

    // Parse the Python JSON envelope
    if (result.stdout.trim().length === 0) {
      if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
        console.error(`[cp-sat:${executable}] empty stdout, stderr: ${result.stderr.trim()}`);
      }
      continue;
    }

    try {
      const parsed = JSON.parse(result.stdout) as {
        readonly layouts?: readonly CpSatLayoutPlacement[][];
        readonly status?: string;
        readonly pythonVersion?: string;
        readonly orToolsVersion?: string;
        readonly errorMessage?: string;
        readonly attemptedCandidates?: number;
        readonly stoppedBy?: string;
        readonly elapsedMs?: number;
      };

      const status = normalizeCpSatStatus(parsed.status, result.status);
      const layouts = parsed.layouts ?? [];
      const attemptedCandidates = Number.isInteger(parsed.attemptedCandidates)
        && (parsed.attemptedCandidates ?? -1) >= 0
        ? parsed.attemptedCandidates
        : undefined;
      const stoppedBy = parsed.stoppedBy === "completed" || parsed.stoppedBy === "total-budget"
        ? parsed.stoppedBy
        : undefined;
      const elapsedMs = Number.isFinite(parsed.elapsedMs) && (parsed.elapsedMs ?? -1) >= 0
        ? parsed.elapsedMs
        : undefined;

      if ((layouts.length === 0)
        && status === "success"
        && process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
        console.error(`[cp-sat:${executable}] solver returned no feasible layouts`);
      }

      if (status === "success"
        || status === "no-layouts"
        || (status === "timeout" && stoppedBy === "total-budget")) {
        return {
          layouts,
          status,
          pythonVersion: parsed.pythonVersion,
          orToolsVersion: parsed.orToolsVersion,
          ...(attemptedCandidates === undefined ? {} : { attemptedCandidates }),
          ...(stoppedBy === undefined ? {} : { stoppedBy }),
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
        };
      }
      aggregateFailure = selectCpSatFailure(aggregateFailure, status);
      aggregatePythonVersion = parsed.pythonVersion ?? aggregatePythonVersion;
      aggregateOrToolsVersion = parsed.orToolsVersion ?? aggregateOrToolsVersion;
    } catch {
      aggregateFailure = selectCpSatFailure(aggregateFailure, "solver-failed");
      if (process.env["INDUSTRIAL_PLANNER_TRACE_ROUTING"] === "1") {
        console.error(`[cp-sat:${executable}] failed to parse JSON output`);
      }
      continue;
    }
  }

  return {
    layouts: [],
    status: aggregateFailure,
    pythonVersion: aggregatePythonVersion,
    orToolsVersion: aggregateOrToolsVersion,
  };
}

export function normalizeCpSatStatus(
  parsedStatus: string | undefined,
  exitCode: number | null,
): CpSatStatus {
  // Python can emit structured status; use it when available
  if (parsedStatus === "disabled") return "disabled";
  if (parsedStatus === "executable-missing") return "executable-missing";
  if (parsedStatus === "dependency-missing") return "dependency-missing";
  if (parsedStatus === "timeout") return "timeout";
  if (parsedStatus === "solver-failed") return "solver-failed";
  if (parsedStatus === "success") return "success";
  if (parsedStatus === "no-layouts") return "no-layouts";

  // Fallback: interpret exit code
  if (exitCode === 2) return "dependency-missing";
  if (exitCode !== 0) return "solver-failed";

  return "success";
}

function selectCpSatFailure(
  current: Exclude<CpSatStatus, "disabled" | "success" | "no-layouts">,
  candidate: CpSatStatus,
): Exclude<CpSatStatus, "disabled" | "success" | "no-layouts"> {
  if (candidate === "disabled" || candidate === "success" || candidate === "no-layouts") return current;
  return CP_SAT_FAILURE_PRIORITY[candidate] > CP_SAT_FAILURE_PRIORITY[current] ? candidate : current;
}
