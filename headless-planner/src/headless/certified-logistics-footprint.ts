import type { ItemDomain } from "../domain/registry/types/entity-definition";

import type {
  CertifiedLogisticsFootprintLowerBound,
  CertifiedLogisticsKind,
  HeadlessMaterialGraph,
} from "./types";

export const CERTIFIED_LOGISTICS_FOOTPRINT_PROFILE =
  "certified-logistics-footprint-v1" as const;

const LOGISTICS_KINDS = ["belt", "pipe"] as const;

/**
 * Derive a placement- and allocation-independent floor on charged logistics cells.
 *
 * For one consumer/item pair, every frozen graph edge represents no more flow
 * than that consumer's fixed demand. Its largest lane count is therefore a
 * lower bound even when a routed solve reallocates the other producers. Lane
 * counts from different consumer/item pairs are additive. Each generated
 * warehouse unloader can make at most one solid lane area-free, so subtracting
 * every unloader is a safe upper bound on the exemption. Finally, the game's
 * routed-layout model permits at most two same-kind, orthogonally crossing
 * lanes in one cell and never permits belt/pipe cell sharing.
 */
export function measureCertifiedLogisticsFootprintLowerBound(options: {
  readonly graph: Pick<HeadlessMaterialGraph, "nodes" | "edges">;
  readonly resolveItemDomain: (itemId: string) => ItemDomain;
}): CertifiedLogisticsFootprintLowerBound {
  const nodeById = new Map<string, HeadlessMaterialGraph["nodes"][number]>();
  for (const [index, node] of options.graph.nodes.entries()) {
    if (node.id.length === 0) throw new Error(`Material graph node ${index} has an empty ID`);
    if (nodeById.has(node.id)) throw new Error(`Duplicate material graph node ID: ${node.id}`);
    nodeById.set(node.id, node);
  }

  const inputLaneFloorByTargetItem = new Map<string, {
    readonly kind: CertifiedLogisticsKind;
    readonly laneCount: number;
  }>();
  for (const [index, edge] of options.graph.edges.entries()) {
    const source = nodeById.get(edge.sourceId);
    const target = nodeById.get(edge.targetId);
    if (source === undefined || target === undefined) {
      throw new Error(`Material graph edge ${index} references a missing endpoint`);
    }
    if (edge.itemId.length === 0) throw new Error(`Material graph edge ${index} has an empty item ID`);
    assertPositiveSafeInteger(edge.laneCount, `material graph edge ${index} laneCount`);
    if (!source.outputItemIds.includes(edge.itemId)
      || !target.inputItemIds.includes(edge.itemId)) {
      throw new Error(`Material graph edge ${index} is inconsistent with its endpoint items`);
    }
    const kind = toLogisticsKind(options.resolveItemDomain(edge.itemId));
    const key = `${edge.targetId}\u0000${edge.itemId}`;
    const previous = inputLaneFloorByTargetItem.get(key);
    inputLaneFloorByTargetItem.set(key, {
      kind,
      laneCount: Math.max(previous?.laneCount ?? 0, edge.laneCount),
    });
  }

  const inputLaneLowerBoundByKind = emptyKindCounts();
  for (const floor of inputLaneFloorByTargetItem.values()) {
    inputLaneLowerBoundByKind[floor.kind] = safeAdd(
      inputLaneLowerBoundByKind[floor.kind],
      floor.laneCount,
      "input lane lower bound",
    );
  }

  const maximumAreaExcludedLaneCountByKind = emptyKindCounts();
  for (const node of options.graph.nodes) {
    if (node.definitionId !== "item_port_unloader_1") continue;
    if (node.kind !== "warehouse-port") {
      throw new Error(`Warehouse unloader ${node.id} is not a warehouse-port node`);
    }
    if (node.outputItemIds.length !== 1
      || options.resolveItemDomain(node.outputItemIds[0]!) !== "solid") {
      throw new Error(`Warehouse unloader ${node.id} must expose exactly one solid item`);
    }
    maximumAreaExcludedLaneCountByKind.belt = safeAdd(
      maximumAreaExcludedLaneCountByKind.belt,
      1,
      "maximum area-excluded lane count",
    );
  }

  const chargedLaneLowerBoundByKind = emptyKindCounts();
  const chargedCellLowerBoundByKind = emptyKindCounts();
  for (const kind of LOGISTICS_KINDS) {
    chargedLaneLowerBoundByKind[kind] = Math.max(
      0,
      inputLaneLowerBoundByKind[kind] - maximumAreaExcludedLaneCountByKind[kind],
    );
    chargedCellLowerBoundByKind[kind] = Math.ceil(chargedLaneLowerBoundByKind[kind] / 2);
  }
  const chargedCellLowerBound = safeAdd(
    chargedCellLowerBoundByKind.belt,
    chargedCellLowerBoundByKind.pipe,
    "charged logistics-cell lower bound",
  );

  return {
    constraintProfile: CERTIFIED_LOGISTICS_FOOTPRINT_PROFILE,
    inputLaneLowerBoundByKind,
    maximumAreaExcludedLaneCountByKind,
    chargedLaneLowerBoundByKind,
    chargedCellLowerBoundByKind,
    chargedCellLowerBound,
  };
}

function emptyKindCounts(): Record<CertifiedLogisticsKind, number> {
  return { belt: 0, pipe: 0 };
}

function toLogisticsKind(domain: ItemDomain): CertifiedLogisticsKind {
  return domain === "solid" ? "belt" : "pipe";
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceeds JavaScript's safe integer range`);
  }
  return result;
}
