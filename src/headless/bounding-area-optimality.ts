import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { RegistryContract } from "@/domain/registry/registry-contract";

import type { CertifiedAreaRelaxationResult } from "./certified-area-relaxation";
import type {
  BoundingAreaOptimality,
  CertifiedLogisticsFootprintLowerBound,
  HeadlessPlacedDevice,
} from "./types";
import { CERTIFIED_LOGISTICS_FOOTPRINT_PROFILE } from "./certified-logistics-footprint";
import { hasValidGeneratedWarehouseHubAdjacency } from "./warehouse-hub-validation";

export const DEFAULT_CERTIFIED_AREA_MAX_SECONDS = 2;

interface MandatoryAreaRectangle {
  readonly width: number;
  readonly height: number;
}

/** Sum of pairwise non-overlapping mandatory rectangle areas. */
export function measureMandatoryDeviceAreaLowerBound(
  devices: readonly MandatoryAreaRectangle[],
): number {
  let area = 0;
  for (const [index, device] of devices.entries()) {
    assertPositiveSafeInteger(device.width, `devices[${index}].width`);
    assertPositiveSafeInteger(device.height, `devices[${index}].height`);
    const deviceArea = device.width * device.height;
    if (!Number.isSafeInteger(deviceArea) || !Number.isSafeInteger(area + deviceArea)) {
      throw new Error("Mandatory device-area lower bound exceeds JavaScript's safe integer range");
    }
    area += deviceArea;
  }
  return area;
}

export interface StrictRoutedBoundingAreaUpperBoundOptions {
  readonly blueprint: BlueprintDocument;
  readonly registry: Pick<RegistryContract, "entityDefinitions">;
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly routedConnections: readonly {
    readonly id: string;
    readonly sourceDeviceId: string | null;
    readonly targetDeviceId: string | null;
  }[];
  /** Belt cells excluded only for unloader-to-production connections. */
  readonly areaExcludedDeviceIds: ReadonlySet<string>;
  readonly limitWidth: number;
  readonly limitHeight: number;
  readonly boundingArea: number;
  readonly topologyErrorCount: number;
  readonly productionConnectivityVerified: boolean;
  readonly productionThroughputVerified: boolean;
  readonly powerCoverageVerified: boolean;
  readonly frontageConstraint: "soft" | "hard";
  readonly frontageOverflowCellCount: number;
}

/**
 * Independently certify that the returned blueprint is a feasible routed area
 * incumbent. Search diagnostics are intentionally absent: failed historical
 * candidates cannot invalidate the selected incumbent.
 */
export function isStrictRoutedBoundingAreaUpperBound(
  options: StrictRoutedBoundingAreaUpperBoundOptions,
): boolean {
  if (options.topologyErrorCount !== 0
    || !options.productionConnectivityVerified
    || !options.productionThroughputVerified
    || !options.powerCoverageVerified
    || (options.frontageConstraint === "hard" && options.frontageOverflowCellCount !== 0)) {
    return false;
  }
  if (!Number.isSafeInteger(options.limitWidth) || options.limitWidth <= 0
    || !Number.isSafeInteger(options.limitHeight) || options.limitHeight <= 0
    || !Number.isSafeInteger(options.boundingArea) || options.boundingArea < 0) {
    return false;
  }

  const definitionById = new Map(options.registry.entityDefinitions.map((definition) =>
    [definition.id, definition] as const));
  const deviceById = new Map<string, HeadlessPlacedDevice>();
  for (const device of options.devices) {
    if (deviceById.has(device.id)
      || !isGridInteger(device.position.x)
      || !isGridInteger(device.position.y)
      || !Number.isSafeInteger(device.width) || device.width <= 0
      || !Number.isSafeInteger(device.height) || device.height <= 0
      || device.position.x + device.width > options.limitWidth
      || device.position.y + device.height > options.limitHeight) {
      return false;
    }
    const definition = definitionById.get(device.definitionId);
    const swapsAxes = device.rotation === 90 || device.rotation === 270;
    if (definition === undefined
      || (device.rotation !== 0 && device.rotation !== 90
        && device.rotation !== 180 && device.rotation !== 270)
      || device.width !== (swapsAxes ? definition.footprint.height : definition.footprint.width)
      || device.height !== (swapsAxes ? definition.footprint.width : definition.footprint.height)) {
      return false;
    }
    const entity = options.blueprint.entities[device.id];
    if (entity === undefined
      || entity.id !== device.id
      || entity.definitionId !== device.definitionId
      || entity.position.x !== device.position.x
      || entity.position.y !== device.position.y
      || entity.rotation !== device.rotation) {
      return false;
    }
    deviceById.set(device.id, device);
  }

  const blueprintEntityIds = Object.keys(options.blueprint.entities);
  const orderedEntityIds = new Set(options.blueprint.entityOrder);
  if (blueprintEntityIds.length !== options.devices.length
    || options.blueprint.entityOrder.length !== options.devices.length
    || orderedEntityIds.size !== options.devices.length
    || blueprintEntityIds.some((id) => !deviceById.has(id))
    || options.blueprint.entityOrder.some((id) => !deviceById.has(id))) {
    return false;
  }

  for (let leftIndex = 0; leftIndex < options.devices.length; leftIndex += 1) {
    const left = options.devices[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < options.devices.length; rightIndex += 1) {
      if (rectanglesOverlap(left, options.devices[rightIndex]!)) return false;
    }
  }

  if (!hasValidGeneratedWarehouseHubAdjacency({
    devices: options.devices,
    entityDefinitions: options.registry.entityDefinitions,
  })) return false;

  const eligibleAreaExcludedConnectionIds = new Set(options.routedConnections.flatMap((connection) => {
    const source = connection.sourceDeviceId === null
      ? undefined : deviceById.get(connection.sourceDeviceId);
    const target = connection.targetDeviceId === null
      ? undefined : deviceById.get(connection.targetDeviceId);
    return source?.definitionId === "item_port_unloader_1" && target?.kind === "production"
      ? [connection.id]
      : [];
  }));
  for (const deviceId of options.areaExcludedDeviceIds) {
    const device = deviceById.get(deviceId);
    const entity = options.blueprint.entities[deviceId];
    const connectionIds = entity?.tags.flatMap((tag) =>
      tag.startsWith("connection:") ? [tag.slice("connection:".length)] : []) ?? [];
    if (device?.kind !== "belt"
      || connectionIds.length === 0
      || connectionIds.some((id) => !eligibleAreaExcludedConnectionIds.has(id))) {
      return false;
    }
  }
  const chargedDevices = options.devices.filter((device) =>
    device.kind !== "warehouse-bus" && !options.areaExcludedDeviceIds.has(device.id));
  return measureChargedBoundingArea(chargedDevices) === options.boundingArea;
}

export function createBoundingAreaOptimalityReport(options: {
  readonly mandatoryDeviceAreaLowerBound?: number;
  readonly certifiedLogisticsFootprint?: CertifiedLogisticsFootprintLowerBound;
  readonly proof: CertifiedAreaRelaxationResult;
  readonly strictRoutedUpperBoundVerified: boolean;
  readonly routedBoundingArea: number;
}): BoundingAreaOptimality {
  const staticLowerBound = validateOptionalArea(
    options.mandatoryDeviceAreaLowerBound,
    "mandatory device-area lower bound",
  );
  const logisticsCellLowerBound = validateLogisticsFootprint(
    options.certifiedLogisticsFootprint,
  );
  const deviceAndLogisticsLowerBound = staticLowerBound === undefined
    || logisticsCellLowerBound === undefined
    ? undefined
    : safeAreaSum(staticLowerBound, logisticsCellLowerBound);
  const cpSatLowerBound = validateOptionalArea(
    options.proof.certifiedIntegerLowerBound,
    "CP-SAT area lower bound",
  );
  const lowerBounds = [staticLowerBound, deviceAndLogisticsLowerBound, cpSatLowerBound]
    .filter((bound): bound is number => bound !== undefined);
  const lowerBound = lowerBounds.length === 0 ? undefined : Math.max(...lowerBounds);
  const upperBound = options.strictRoutedUpperBoundVerified
    ? validateArea(options.routedBoundingArea, "strict routed bounding area")
    : undefined;

  if (upperBound !== undefined && options.proof.status === "infeasible") {
    throw new Error(
      "Certified bounding-area invariant violated: the relaxation is infeasible but a strict routed incumbent exists",
    );
  }
  if (lowerBound !== undefined && upperBound !== undefined && lowerBound > upperBound) {
    throw new Error(
      `Certified bounding-area invariant violated: lower bound ${lowerBound} exceeds routed upper bound ${upperBound}`,
    );
  }

  const absoluteGap = lowerBound === undefined || upperBound === undefined
    ? undefined
    : upperBound - lowerBound;
  const relativeGap = absoluteGap === undefined || upperBound === undefined
    ? undefined
    : upperBound === 0 ? 0 : absoluteGap / upperBound;
  const status: BoundingAreaOptimality["status"] = lowerBound === undefined
    ? "bound-unavailable"
    : upperBound === undefined
      ? "lower-bound-only"
      : lowerBound === upperBound
        ? "bounding-area-optimal"
        : "bounded";

  return {
    status,
    ...(lowerBound === undefined ? {} : { lowerBound }),
    ...(upperBound === undefined ? {} : { upperBound }),
    ...(absoluteGap === undefined ? {} : { absoluteGap }),
    ...(relativeGap === undefined ? {} : { relativeGap }),
    strictRoutedUpperBoundVerified: options.strictRoutedUpperBoundVerified,
    lowerBoundSources: {
      ...(staticLowerBound === undefined ? {} : { mandatoryDeviceArea: staticLowerBound }),
      ...(deviceAndLogisticsLowerBound === undefined
        ? {} : { mandatoryDeviceAndLogisticsArea: deviceAndLogisticsLowerBound }),
      ...(cpSatLowerBound === undefined ? {} : { cpSatArea: cpSatLowerBound }),
    },
    ...(options.certifiedLogisticsFootprint === undefined
      ? {} : { certifiedLogisticsFootprint: options.certifiedLogisticsFootprint }),
    proof: {
      constraintProfile: options.proof.constraintProfile,
      objective: options.proof.objective,
      solverStatus: options.proof.status,
      ...(options.proof.rawBestObjectiveBound === undefined
        ? {} : { rawBestObjectiveBound: options.proof.rawBestObjectiveBound }),
      ...(cpSatLowerBound === undefined ? {} : { certifiedIntegerLowerBound: cpSatLowerBound }),
      ...(options.proof.masterIncumbentArea === undefined
        ? {} : { masterIncumbentArea: options.proof.masterIncumbentArea }),
      ...(options.proof.pythonVersion === undefined
        ? {} : { pythonVersion: options.proof.pythonVersion }),
      ...(options.proof.orToolsVersion === undefined
        ? {} : { orToolsVersion: options.proof.orToolsVersion }),
      ...(options.proof.elapsedMs === undefined ? {} : { elapsedMs: options.proof.elapsedMs }),
    },
  };
}

function validateLogisticsFootprint(
  proof: CertifiedLogisticsFootprintLowerBound | undefined,
): number | undefined {
  if (proof === undefined) return undefined;
  if (proof.constraintProfile !== CERTIFIED_LOGISTICS_FOOTPRINT_PROFILE) {
    throw new Error(`Unsupported certified logistics footprint profile: ${proof.constraintProfile}`);
  }
  for (const kind of ["belt", "pipe"] as const) {
    const input = validateArea(proof.inputLaneLowerBoundByKind[kind], `${kind} input lane lower bound`);
    const excluded = validateArea(
      proof.maximumAreaExcludedLaneCountByKind[kind],
      `${kind} maximum area-excluded lane count`,
    );
    const charged = validateArea(
      proof.chargedLaneLowerBoundByKind[kind],
      `${kind} charged lane lower bound`,
    );
    const cells = validateArea(
      proof.chargedCellLowerBoundByKind[kind],
      `${kind} charged cell lower bound`,
    );
    if (charged !== Math.max(0, input - excluded) || cells !== Math.ceil(charged / 2)) {
      throw new Error(`Certified ${kind} logistics footprint proof does not reconcile`);
    }
  }
  const total = validateArea(proof.chargedCellLowerBound, "charged logistics-cell lower bound");
  if (total !== proof.chargedCellLowerBoundByKind.belt
      + proof.chargedCellLowerBoundByKind.pipe) {
    throw new Error("Certified logistics footprint total does not reconcile");
  }
  return total;
}

function safeAreaSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error("Mandatory device-and-logistics area lower bound exceeds the safe integer range");
  }
  return result;
}

function measureChargedBoundingArea(devices: readonly HeadlessPlacedDevice[]): number {
  if (devices.length === 0) return 0;
  const minimumX = Math.min(...devices.map((device) => device.position.x));
  const maximumX = Math.max(...devices.map((device) => device.position.x + device.width));
  const maximumY = Math.max(...devices.map((device) => device.position.y + device.height));
  return (maximumX - minimumX) * maximumY;
}

function rectanglesOverlap(left: HeadlessPlacedDevice, right: HeadlessPlacedDevice): boolean {
  return left.position.x < right.position.x + right.width
    && left.position.x + left.width > right.position.x
    && left.position.y < right.position.y + right.height
    && left.position.y + left.height > right.position.y;
}

function isGridInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateOptionalArea(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : validateArea(value, label);
}

function validateArea(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer, received ${value}`);
  }
  return value;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer, received ${value}`);
  }
}
