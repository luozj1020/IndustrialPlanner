import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CERTIFIED_AREA_RELAXATION_PROFILE = "certified-area-relaxation-v1" as const;
export const CERTIFIED_AREA_RELAXATION_OBJECTIVE =
  "horizontal-span-times-origin-anchored-height" as const;

/** A globally mandatory, area-counted rectangle from the full problem. */
export interface CertifiedAreaRelaxationDevice {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export type CertifiedAreaRelaxationStatus =
  | "optimal"
  | "feasible"
  | "infeasible"
  | "unknown"
  | "executable-missing"
  | "dependency-missing"
  | "timeout"
  | "solver-failed";

export interface CertifiedAreaRelaxationResult {
  readonly constraintProfile: typeof CERTIFIED_AREA_RELAXATION_PROFILE;
  readonly objective: typeof CERTIFIED_AREA_RELAXATION_OBJECTIVE;
  readonly status: CertifiedAreaRelaxationStatus;
  /** OR-Tools' floating representation of the best minimization lower bound. */
  readonly rawBestObjectiveBound?: number;
  /** Exact integer inner-objective bound for the unit-coefficient area IntVar. */
  readonly certifiedIntegerLowerBound?: number;
  /** A placement-only incumbent. It is not a routed upper bound. */
  readonly masterIncumbentArea?: number;
  readonly pythonVersion?: string;
  readonly orToolsVersion?: string;
  readonly elapsedMs?: number;
}

export interface CertifiedAreaRelaxationOptions {
  readonly devices: readonly CertifiedAreaRelaxationDevice[];
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly allowRotate: boolean;
  readonly maxSeconds: number;
  /** Test/embedding seam; production callers use the adjacent proof-only Python module. */
  readonly scriptPath?: string;
}

const FAILURE_PRIORITY: Readonly<Record<
  Extract<CertifiedAreaRelaxationStatus,
    "executable-missing" | "dependency-missing" | "timeout" | "solver-failed">,
  number
>> = {
  "executable-missing": 0,
  "dependency-missing": 1,
  "solver-failed": 2,
  timeout: 3,
};

/**
 * Solve the proof-only placement relaxation.
 *
 * The serialized DTO is deliberately reconstructed field-by-field. Search-only
 * properties attached by an untyped caller therefore cannot cross the proof
 * boundary into the Python model. The minimized relaxation is
 * (max(endX) - min(x)) * max(endY), so every full feasible layout maps to a
 * feasible master assignment whose objective does not exceed its charged area.
 */
export function solveCpSatAreaLowerBound(
  options: CertifiedAreaRelaxationOptions,
): CertifiedAreaRelaxationResult {
  validateOptions(options);
  if (options.devices.length === 0) {
    return {
      constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
      objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
      status: "optimal",
      rawBestObjectiveBound: 0,
      certifiedIntegerLowerBound: 0,
      masterIncumbentArea: 0,
      elapsedMs: 0,
    };
  }

  const scriptPath = options.scriptPath ?? resolveProofScriptPath();
  const input = JSON.stringify({
    constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
    objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
    devices: options.devices.map((device) => ({
      id: device.id,
      width: device.width,
      height: device.height,
    })),
    limitWidth: options.limitWidth,
    limitHeight: options.limitHeight,
    allowRotate: options.allowRotate,
    maxSeconds: options.maxSeconds,
  });
  const executables = [
    process.env["INDUSTRIAL_PLANNER_PYTHON"],
    "python3",
    "python",
  ].filter((value, index, all): value is string =>
    value !== undefined && value.length > 0 && all.indexOf(value) === index);

  let aggregateFailure: Extract<CertifiedAreaRelaxationStatus,
    "executable-missing" | "dependency-missing" | "timeout" | "solver-failed">
    = "executable-missing";
  let aggregatePythonVersion: string | undefined;
  let aggregateOrToolsVersion: string | undefined;
  for (const executable of executables) {
    const result = spawnSync(executable, [scriptPath], {
      input,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: Math.ceil(options.maxSeconds * 1_000 + 15_000),
    });
    if (result.error !== undefined
      && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    const processErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (result.signal !== null || processErrorCode === "ETIMEDOUT") {
      aggregateFailure = selectFailure(aggregateFailure, "timeout");
      continue;
    }
    if (result.stdout.trim().length === 0) {
      aggregateFailure = selectFailure(aggregateFailure, "solver-failed");
      continue;
    }

    try {
      const parsed = parseEnvelope(
        JSON.parse(result.stdout) as Record<string, unknown>,
        options.limitWidth * options.limitHeight,
      );
      aggregatePythonVersion = parsed.pythonVersion ?? aggregatePythonVersion;
      aggregateOrToolsVersion = parsed.orToolsVersion ?? aggregateOrToolsVersion;
      if (parsed.status === "optimal"
        || parsed.status === "feasible"
        || parsed.status === "infeasible"
        || parsed.status === "unknown") return parsed;
      aggregateFailure = selectFailure(aggregateFailure, parsed.status);
    } catch {
      aggregateFailure = selectFailure(aggregateFailure, "solver-failed");
    }
  }

  return {
    constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
    objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
    status: aggregateFailure,
    ...(aggregatePythonVersion === undefined ? {} : { pythonVersion: aggregatePythonVersion }),
    ...(aggregateOrToolsVersion === undefined ? {} : { orToolsVersion: aggregateOrToolsVersion }),
  };
}

function resolveProofScriptPath(): string {
  try {
    return fileURLToPath(new URL("./certified-area-relaxation.py", import.meta.url));
  } catch {
    // Vitest/Vite may rewrite import.meta.url to a non-file module URL. The
    // headless command still runs from the package root in that environment.
    return resolve(process.cwd(), "src/headless/certified-area-relaxation.py");
  }
}

function validateOptions(options: CertifiedAreaRelaxationOptions): void {
  assertPositiveSafeInteger(options.limitWidth, "limitWidth");
  assertPositiveSafeInteger(options.limitHeight, "limitHeight");
  if (!Number.isSafeInteger(options.limitWidth * options.limitHeight)) {
    throw new Error("Certified area domain exceeds JavaScript's safe integer range");
  }
  if (typeof options.allowRotate !== "boolean") {
    throw new Error("allowRotate must be a boolean");
  }
  if (!Number.isFinite(options.maxSeconds) || options.maxSeconds <= 0 || options.maxSeconds > 30) {
    throw new Error(`maxSeconds must be in (0, 30], received ${options.maxSeconds}`);
  }
  const ids = new Set<string>();
  for (const device of options.devices) {
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new Error("Certified relaxation device IDs must be non-empty strings");
    }
    if (ids.has(device.id)) throw new Error(`Duplicate certified relaxation device ID: ${device.id}`);
    ids.add(device.id);
    assertPositiveSafeInteger(device.width, `${device.id}.width`);
    assertPositiveSafeInteger(device.height, `${device.id}.height`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer, received ${value}`);
  }
}

function parseEnvelope(
  value: Record<string, unknown>,
  maximumArea: number,
): CertifiedAreaRelaxationResult {
  if (value["constraintProfile"] !== CERTIFIED_AREA_RELAXATION_PROFILE) {
    throw new Error("Unexpected certified relaxation profile");
  }
  if (value["objective"] !== CERTIFIED_AREA_RELAXATION_OBJECTIVE) {
    throw new Error("Unexpected certified relaxation objective");
  }
  const status = value["status"];
  if (!isStatus(status)) throw new Error("Unexpected certified relaxation status");
  const pythonVersion = optionalString(value["pythonVersion"]);
  const orToolsVersion = optionalString(value["orToolsVersion"]);
  const elapsedMs = optionalNonnegativeNumber(value["elapsedMs"]);
  const base = {
    constraintProfile: CERTIFIED_AREA_RELAXATION_PROFILE,
    objective: CERTIFIED_AREA_RELAXATION_OBJECTIVE,
    status,
    ...(pythonVersion === undefined ? {} : { pythonVersion }),
    ...(orToolsVersion === undefined ? {} : { orToolsVersion }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  } as const;
  if (status === "infeasible"
    || status === "executable-missing"
    || status === "dependency-missing"
    || status === "timeout"
    || status === "solver-failed") return base;

  const rawBestObjectiveBound = optionalNonnegativeNumber(value["rawBestObjectiveBound"]);
  const certifiedIntegerLowerBound = optionalAreaInteger(
    value["certifiedIntegerLowerBound"], maximumArea,
  );
  const masterIncumbentArea = optionalAreaInteger(value["masterIncumbentArea"], maximumArea);
  if (rawBestObjectiveBound === undefined || certifiedIntegerLowerBound === undefined) {
    throw new Error("Solver did not return a certified objective bound");
  }
  if (Math.abs(rawBestObjectiveBound - certifiedIntegerLowerBound) > 1e-6) {
    throw new Error("Float and exact integer objective bounds disagree");
  }
  if ((status === "optimal" || status === "feasible") && masterIncumbentArea === undefined) {
    throw new Error("Solver status requires a master incumbent");
  }
  if (masterIncumbentArea !== undefined
    && certifiedIntegerLowerBound > masterIncumbentArea) {
    throw new Error("Certified lower bound exceeds the master incumbent");
  }
  if (status === "optimal" && certifiedIntegerLowerBound !== masterIncumbentArea) {
    throw new Error("Optimal relaxation must close its own objective gap");
  }
  return {
    ...base,
    rawBestObjectiveBound,
    certifiedIntegerLowerBound,
    ...(masterIncumbentArea === undefined ? {} : { masterIncumbentArea }),
  };
}

function isStatus(value: unknown): value is CertifiedAreaRelaxationStatus {
  return value === "optimal"
    || value === "feasible"
    || value === "infeasible"
    || value === "unknown"
    || value === "executable-missing"
    || value === "dependency-missing"
    || value === "timeout"
    || value === "solver-failed";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalAreaInteger(value: unknown, maximumArea: number): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximumArea
    ? value
    : undefined;
}

function selectFailure<T extends Extract<CertifiedAreaRelaxationStatus,
  "executable-missing" | "dependency-missing" | "timeout" | "solver-failed">>(
  left: T,
  right: T,
): T {
  return FAILURE_PRIORITY[right] > FAILURE_PRIORITY[left] ? right : left;
}
