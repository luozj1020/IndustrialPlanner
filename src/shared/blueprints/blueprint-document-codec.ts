import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { CacheLinkEndpointDefinition, SlotLinkDefinition, WorldEntity } from "@/domain/document/world-document";
import { migrateBlueprintEntityDeviceIds } from "@/shared/blueprint-device-id-migration";

export function normalizeBlueprintDocument(value: unknown): BlueprintDocument | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.schemaVersion !== 1
    || !isNonEmptyString(value.blueprintId)
    || !isNonEmptyString(value.version)
    || !isNonEmptyString(value.name)
    || typeof value.description !== "string"
    || !isNonEmptyString(value.baseId)
    || !isGridPoint(value.initialGridPoint)
    || !isRecord(value.entities)
    || !isStringArray(value.entityOrder)
    || !Array.isArray(value.slotLinks)
    || !isNonEmptyString(value.createdAt)
    || !isNonEmptyString(value.updatedAt)
  ) {
    return null;
  }

  const entities: Record<string, WorldEntity> = Object.create(null);
  for (const [id, entity] of Object.entries(value.entities)) {
    if (["__proto__", "prototype", "constructor"].includes(id) || !isWorldEntity(entity) || entity.id !== id) return null;
    entities[id] = entity;
  }
  if (
    new Set(value.entityOrder).size !== value.entityOrder.length
    || value.entityOrder.length !== Object.keys(entities).length
    || !value.entityOrder.every((id) => Object.hasOwn(entities, id))
  ) return null;
  const slotLinks: SlotLinkDefinition[] = [];
  const linkIds = new Set<string>();
  for (const link of value.slotLinks) {
    if (!isSlotLink(link, entities) || linkIds.has(link.id)) return null;
    linkIds.add(link.id);
    slotLinks.push(link);
  }

  return {
    schemaVersion: value.schemaVersion,
    blueprintId: value.blueprintId,
    version: value.version,
    name: value.name,
    description: value.description,
    baseId: value.baseId,
    initialGridPoint: value.initialGridPoint,
    entities: migrateBlueprintEntityDeviceIds(entities),
    entityOrder: [...value.entityOrder],
    slotLinks,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function isGridPoint(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y);
}

function isWorldEntity(value: unknown): value is WorldEntity {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.definitionId)
    && isGridPoint(value.position)
    && [0, 90, 180, 270].includes(value.rotation as number)
    && isRecord(value.config)
    && isStringArray(value.tags);
}

function isSlotLink(value: unknown, entities: Record<string, WorldEntity>): value is SlotLinkDefinition {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && (value.linkType === "share-all" || value.linkType === "share-cap")
    && isEndpoint(value.source, entities)
    && isEndpoint(value.target, entities);
}

function isEndpoint(value: unknown, entities: Record<string, WorldEntity>): value is CacheLinkEndpointDefinition {
  return isRecord(value)
    && isNonEmptyString(value.entityId)
    // Placement preserves these global references outside blueprint entities.
    && (Object.hasOwn(entities, value.entityId)
      || value.entityId === "warehouse"
      || value.entityId.startsWith("warehouse:")
      || value.entityId.startsWith("base-builtin:"))
    && isNonEmptyString(value.storageSlotGroupId)
    && isNonEmptyString(value.slotId);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
