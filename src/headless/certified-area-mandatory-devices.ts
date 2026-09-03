import type { EntityDefinition } from "@/domain/registry/types/entity-definition";

import type {
  CertifiedAreaMandatoryRectangleKind,
  CertifiedAreaRelaxationDevice,
} from "./certified-area-relaxation";

export interface CertifiedAreaMandatoryEntity {
  readonly id: string;
  readonly kind: "production" | "storage" | "warehouse-port";
  readonly definitionId: string;
}

const MANDATORY_POWER_DEVICE_ID = "certified-minimum-power-diffuser-1";

/**
 * Build the v3a globally mandatory charged-rectangle set.
 *
 * Production devices, protocol storage, and warehouse unloaders are fixed by
 * the frozen production/lane graph. If any such entity requires power, every
 * complete game-valid layout also contains at least one non-overlapping power
 * diffuser. Positions and the actual (possibly larger) diffuser count remain
 * free, so this is a relaxation rather than an incumbent-derived restriction.
 */
export function createCertifiedAreaMandatoryDevices(options: {
  readonly entities: readonly CertifiedAreaMandatoryEntity[];
  readonly entityDefinitions: readonly EntityDefinition[];
}): CertifiedAreaRelaxationDevice[] {
  const definitionById = new Map(options.entityDefinitions.map((definition) =>
    [definition.id, definition] as const));
  const ids = new Set<string>();
  const devices = options.entities.map((entity): CertifiedAreaRelaxationDevice => {
    if (ids.has(entity.id)) {
      throw new Error(`Duplicate mandatory certified entity ID: ${entity.id}`);
    }
    ids.add(entity.id);
    const definition = definitionById.get(entity.definitionId);
    if (definition === undefined) {
      throw new Error(`Missing mandatory certified entity definition ${entity.definitionId}`);
    }
    return {
      id: entity.id,
      width: definition.footprint.width,
      height: definition.footprint.height,
      category: entity.kind,
    };
  });

  const requiresPower = options.entities.some((entity) =>
    definitionById.get(entity.definitionId)?.requiresPower === true);
  if (!requiresPower) return devices;
  if (ids.has(MANDATORY_POWER_DEVICE_ID)) {
    throw new Error(`Reserved certified device ID is already used: ${MANDATORY_POWER_DEVICE_ID}`);
  }
  const powerDefinition = definitionById.get("item_port_power_diffuser_1");
  if (powerDefinition === undefined || powerDefinition.powerRange === undefined) {
    throw new Error("Missing mandatory power diffuser definition for certified relaxation");
  }
  return [
    ...devices,
    {
      id: MANDATORY_POWER_DEVICE_ID,
      width: powerDefinition.footprint.width,
      height: powerDefinition.footprint.height,
      category: "minimum-power",
    },
  ];
}

export function measureCertifiedAreaByCategory(
  devices: readonly CertifiedAreaRelaxationDevice[],
): Partial<Record<CertifiedAreaMandatoryRectangleKind, number>> {
  const result: Partial<Record<CertifiedAreaMandatoryRectangleKind, number>> = {};
  for (const device of devices) {
    if (device.category === undefined) continue;
    result[device.category] = (result[device.category] ?? 0) + device.width * device.height;
  }
  return result;
}
