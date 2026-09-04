import type { EntityDefinition } from "../domain/registry/types/entity-definition";
import type { GridEdge } from "../domain/shared/grid";
import { rotateGridEdge } from "../shared/geometry/port";

import type { HeadlessPlacedDevice } from "./types";

const WAREHOUSE_BUS_SEGMENT_DEFINITION_ID = "item_port_log_hongs_bus";
const WAREHOUSE_BUS_SOURCE_DEFINITION_ID = "item_port_log_hongs_bus_source";

/**
 * Validate the warehouse hub assembled by the headless planner.
 *
 * This mirrors the game-facing placement behaviors used by the editor: every
 * bus segment must belong to the source's edge-connected component, and every
 * generated warehouse port must touch that component on the side opposite its
 * rotated material port. It deliberately does not assume the search solver's
 * current horizontal shell, origin, ordering, or two-ports-per-segment layout.
 */
export function hasValidGeneratedWarehouseHubAdjacency(options: {
  readonly devices: readonly HeadlessPlacedDevice[];
  readonly entityDefinitions: readonly EntityDefinition[];
}): boolean {
  const definitionById = new Map(options.entityDefinitions.map((definition) =>
    [definition.id, definition] as const));
  const busDevices = options.devices.filter((device) => device.kind === "warehouse-bus");
  const busSources = busDevices.filter((device) =>
    device.definitionId === WAREHOUSE_BUS_SOURCE_DEFINITION_ID);
  const busSegments = busDevices.filter((device) =>
    device.definitionId === WAREHOUSE_BUS_SEGMENT_DEFINITION_ID);
  const warehousePorts = options.devices.filter((device) => device.kind === "warehouse-port");

  if (busDevices.length !== busSources.length + busSegments.length) return false;
  if (busSources.length === 0) {
    return busSegments.length === 0 && warehousePorts.length === 0;
  }
  if (busSources.length !== 1) return false;

  const busSource = busSources[0]!;
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

  const connectedBus = [busSource, ...busSegments];
  return warehousePorts.every((port) => {
    const definition = definitionById.get(port.definitionId);
    const basePortEdge = definition?.portGroups[0]?.ports[0]?.edge;
    if (basePortEdge === undefined) return false;
    const requiredBusEdge = oppositeGridEdge(rotateGridEdge(basePortEdge, port.rotation));
    return connectedBus.some((candidate) =>
      isRectangleAdjacentOnEdge(port, candidate, requiredBusEdge));
  });
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
