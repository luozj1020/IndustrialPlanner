#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { BlueprintDocument } from "../domain/document/blueprint-document";
import { createWorldDocument, type WorldEntity } from "../domain/document/world-document";
import type { GridPoint } from "../domain/shared/grid";
import type { LogisticsDraftEndpoint } from "../domain/shared/logistics";
import {
  createEntityDefinitionMap,
  resolveDevicePortEndpoints,
  resolveLogisticsDefinitionId,
  resolveLogisticsPathCells,
} from "../editor/logistics/logistics-utils";
import { createRegistryContract } from "../registry";
import { compileSimulationTopology } from "../simulation/topology-compiler";

type DevicePortEndpoint = Extract<LogisticsDraftEndpoint, { readonly type: "device-port" }>;

interface ManualRoute {
  readonly id: string;
  readonly itemId: string;
  readonly sourceId: string;
  readonly sourcePort: number;
  readonly targetId: string;
  readonly targetPort: number;
  /** Inclusive orthogonal polyline, expressed as sparse bend points. */
  readonly bends: readonly GridPoint[];
}

const MANUAL_LOGISTICS_DEVICES: readonly WorldEntity[] = [];

// These routes are deliberately authored as geometry, not discovered by a router.
// Port indices use the stable sorted endpoint order printed by `--ports`.
const MANUAL_ROUTES: readonly ManualRoute[] = [
  // Warehouse unloaders face west. Every ore lane occupies exactly the shared
  // one-cell gap between its unloader and grinder.
  ...[1, 2, 3, 4, 5, 6].map((number): ManualRoute => ({
    id: `ore-${number}`,
    itemId: "item_originium_ore",
    sourceId: `warehouse-unloader-${number}`,
    sourcePort: 0,
    targetId: `opt-2-${number}`,
    targetPort: 2,
    bends: [],
  })),

  // Two ore grinders feed one thickener. These are also one-cell direct lanes.
  { id: "powder-1a", itemId: "item_originium_powder", sourceId: "opt-2-1", sourcePort: 0, targetId: "opt-6-1", targetPort: 0, bends: [] },
  { id: "powder-1b", itemId: "item_originium_powder", sourceId: "opt-2-2", sourcePort: 0, targetId: "opt-6-1", targetPort: 3, bends: [] },
  { id: "powder-2a", itemId: "item_originium_powder", sourceId: "opt-2-3", sourcePort: 0, targetId: "opt-6-2", targetPort: 0, bends: [] },
  { id: "powder-2b", itemId: "item_originium_powder", sourceId: "opt-2-4", sourcePort: 0, targetId: "opt-6-2", targetPort: 3, bends: [] },
  { id: "powder-3a", itemId: "item_originium_powder", sourceId: "opt-2-5", sourcePort: 0, targetId: "opt-6-3", targetPort: 0, bends: [] },
  { id: "powder-3b", itemId: "item_originium_powder", sourceId: "opt-2-6", sourcePort: 0, targetId: "opt-6-3", targetPort: 3, bends: [] },

  // Three finished lanes enter the three protocol-storage inputs independently.
  { id: "dense-upper", itemId: "item_originium_enr_powder", sourceId: "opt-6-1", sourcePort: 5, targetId: "warehouse-storage-1", targetPort: 0, bends: [] },
  { id: "dense-middle", itemId: "item_originium_enr_powder", sourceId: "opt-6-2", sourcePort: 2, targetId: "warehouse-storage-1", targetPort: 1, bends: [] },
  { id: "dense-lower", itemId: "item_originium_enr_powder", sourceId: "opt-6-3", sourcePort: 0, targetId: "warehouse-storage-1", targetPort: 2, bends: [] },

  // Moss loop: upper planter sustains the seed collector, collector feeds both
  // planters, and the lower planter's surplus enters the crusher directly.
  { id: "moss-cycle", itemId: "item_plant_moss_3", sourceId: "cycle-moss-planter-1", sourcePort: 4, targetId: "cycle-moss-seed-collector-1", targetPort: 0, bends: [] },
  { id: "seed-upper", itemId: "item_plant_moss_seed_3", sourceId: "cycle-moss-seed-collector-1", sourcePort: 0, targetId: "cycle-moss-planter-1", targetPort: 4, bends: [] },
  { id: "seed-lower", itemId: "item_plant_moss_seed_3", sourceId: "cycle-moss-seed-collector-1", sourcePort: 4, targetId: "cycle-moss-planter-2", targetPort: 0, bends: [] },
  { id: "moss-crusher", itemId: "item_plant_moss_3", sourceId: "cycle-moss-planter-2", sourcePort: 4, targetId: "opt-1-1", targetPort: 2, bends: [{ x: 5, y: 22 }, { x: 16, y: 22 }] },

  // The crusher produces 90/min while one belt carries 30/min. These are three
  // independent end-to-end lanes; crossings become two-channel connectors and
  // never merge the streams.
  { id: "moss-powder-lower", itemId: "item_plant_moss_powder_3", sourceId: "opt-1-1", sourcePort: 0, targetId: "opt-6-3", targetPort: 5, bends: [] },
  { id: "moss-powder-middle", itemId: "item_plant_moss_powder_3", sourceId: "opt-1-1", sourcePort: 1, targetId: "opt-6-2", targetPort: 5, bends: [{ x: 15, y: 11 }] },
  { id: "moss-powder-upper", itemId: "item_plant_moss_powder_3", sourceId: "opt-1-1", sourcePort: 2, targetId: "opt-6-1", targetPort: 5, bends: [{ x: 16, y: 5 }] },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputPath = resolve(args.find((value) => !value.startsWith("--"))
    ?? "examples/headless/manual-dense-equipment-blueprint.json");
  const outputPath = resolve(readOption(args, "--output")
    ?? "examples/headless/manual-dense-logistics-blueprint.json");
  const blueprint = JSON.parse(await readFile(inputPath, "utf8")) as BlueprintDocument;
  const registry = createRegistryContract();
  const definitions = createEntityDefinitionMap(registry.entityDefinitions);
  for (const manual of MANUAL_LOGISTICS_DEVICES) {
    const definition = definitions.get(manual.definitionId);
    if (definition === undefined) throw new Error(`Unknown definition: ${manual.definitionId}`);
    blueprint.entities[manual.id] = {
      ...manual,
      config: { ...(definition.placementDefaults?.config ?? {}) },
      tags: ["manual-logistics", "item:item_moss_powder"],
    };
    blueprint.entityOrder.push(manual.id);
  }

  if (args.includes("--ports")) {
    const only = readOption(args, "--only");
    const rows = blueprint.entityOrder.filter((id) => only === undefined || id.includes(only)).map((id) => {
      const entity = blueprint.entities[id]!;
      const definition = definitions.get(entity.definitionId);
      if (definition === undefined) throw new Error(`Unknown definition: ${entity.definitionId}`);
      return {
        id,
        definitionId: entity.definitionId,
        input: sortedPorts(resolveDevicePortEndpoints({
          entity, definition, kind: "belt", direction: "input", pointerGridPoint: entity.position,
        })).map(formatPort),
        output: sortedPorts(resolveDevicePortEndpoints({
          entity, definition, kind: "belt", direction: "output", pointerGridPoint: entity.position,
        })).map(formatPort),
      };
    });
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  const document = createWorldDocument({ baseId: blueprint.baseId });
  document.entities = { ...blueprint.entities };
  document.entityOrder = [...blueprint.entityOrder];
  document.slotLinks = [...blueprint.slotLinks];
  const occupied = new Map<string, { entityId: string; axis: "horizontal" | "vertical" | null }>();
  let beltCount = 0;

  for (const route of MANUAL_ROUTES) {
    const source = selectPort(route.sourceId, "output", route.sourcePort);
    const target = selectPort(route.targetId, "input", route.targetPort);
    const points = expandPolyline([source.outsideGridPoint, ...route.bends, target.outsideGridPoint]);
    const cells = resolveLogisticsPathCells({
      kind: "belt", points, source, target, document,
      entityDefinitionMap: definitions, replacingEntity: null, replacingDefinition: null,
    });
    for (const [index, cell] of cells.entries()) {
      const key = gridKey(cell.gridPoint);
      const axis = cell.fromEdge === "WEST" && cell.toEdge === "EAST"
        || cell.fromEdge === "EAST" && cell.toEdge === "WEST" ? "horizontal"
        : cell.fromEdge === "NORTH" && cell.toEdge === "SOUTH"
          || cell.fromEdge === "SOUTH" && cell.toEdge === "NORTH" ? "vertical" : null;
      const prior = occupied.get(key);
      if (prior !== undefined) {
        if (axis === null || prior.axis === null || axis === prior.axis) {
          throw new Error(`Invalid shared belt cell ${key}: ${prior.entityId} / ${route.id}`);
        }
        const entity = document.entities[prior.entityId]!;
        document.entities[prior.entityId] = {
          ...entity,
          definitionId: "item_log_connector",
          rotation: 0,
          tags: [...entity.tags, `manual-crossing:${route.id}`],
        };
        continue;
      }
      const id = `manual-belt-${route.id}-${index + 1}`;
      const definitionId = resolveLogisticsDefinitionId({ kind: "belt", shape: cell.shape });
      const definition = definitions.get(definitionId);
      const entity: WorldEntity = {
        id, definitionId, position: { ...cell.gridPoint }, rotation: cell.rotation,
        config: { ...(definition?.placementDefaults?.config ?? {}) },
        tags: ["manual-logistics", `route:${route.id}`, `item:${route.itemId}`],
      };
      document.entities[id] = entity;
      document.entityOrder.push(id);
      occupied.set(key, { entityId: id, axis });
      beltCount += 1;
    }
  }

  const output: BlueprintDocument = {
    ...blueprint,
    blueprintId: "manual-dense-logistics-v1",
    name: "Manual full-speed triple dense originium layout",
    description: "Equipment and every belt route are hand-authored. Moss powder uses three independent 30/min lanes; no automatic pathfinder is used.",
    entities: document.entities,
    entityOrder: document.entityOrder,
    updatedAt: new Date().toISOString(),
  };
  const topology = compileSimulationTopology({
    document,
    registry,
    poweredEntityIds: new Set(document.entityOrder),
  });
  const errors = topology.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(`Topology has ${errors.length} errors:\n${JSON.stringify(errors, null, 2)}`);
  }
  const incomingByEntity = new Map<string, number>();
  for (const connection of Object.values(topology.physicalConnections)) {
    const targetPort = topology.ports[connection.targetPortId];
    const targetEntityId = targetPort === undefined
      ? undefined
      : topology.devices[targetPort.deviceId]?.sourceEntityId;
    if (targetEntityId !== undefined && targetEntityId !== null) {
      incomingByEntity.set(targetEntityId, (incomingByEntity.get(targetEntityId) ?? 0) + 1);
    }
  }
  const requiredIncoming = new Map<string, number>([
    ...[1, 2, 3, 4, 5, 6].map((number) => [`opt-2-${number}`, 1] as const),
    ["opt-6-1", 3], ["opt-6-2", 3], ["opt-6-3", 3],
    ["cycle-moss-planter-1", 1], ["cycle-moss-planter-2", 1],
    ["cycle-moss-seed-collector-1", 1], ["opt-1-1", 1],
    ["warehouse-storage-1", 3],
  ]);
  const disconnected = [...requiredIncoming].filter(([id, required]) =>
    (incomingByEntity.get(id) ?? 0) < required);
  if (disconnected.length > 0) {
    throw new Error(`Required inputs are disconnected: ${JSON.stringify(disconnected)}`);
  }
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    routes: MANUAL_ROUTES.length,
    beltCells: beltCount,
    physicalConnections: topology.ordering.physicalConnectionOrder.length,
    topologyErrors: errors.length,
    topologyWarnings: topology.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    requiredInputsConnected: true,
  }, null, 2)}\n`);

  function selectPort(entityId: string, direction: "input" | "output", index: number): DevicePortEndpoint {
    const entity = document.entities[entityId];
    if (entity === undefined) throw new Error(`Unknown route entity: ${entityId}`);
    const definition = definitions.get(entity.definitionId);
    if (definition === undefined) throw new Error(`Unknown definition: ${entity.definitionId}`);
    const ports = sortedPorts(resolveDevicePortEndpoints({
      entity, definition, kind: "belt", direction, pointerGridPoint: entity.position,
    }));
    const port = ports[index];
    if (port === undefined) throw new Error(`Missing ${direction} port ${index} on ${entityId}`);
    return port;
  }
}

function sortedPorts(ports: readonly DevicePortEndpoint[]): DevicePortEndpoint[] {
  return [...ports].sort((left, right) =>
    left.outsideGridPoint.y - right.outsideGridPoint.y
    || left.outsideGridPoint.x - right.outsideGridPoint.x
    || left.portGroupId.localeCompare(right.portGroupId)
    || left.portId.localeCompare(right.portId));
}

function formatPort(port: DevicePortEndpoint): object {
  return { outside: port.outsideGridPoint, inside: port.insideGridPoint, edge: port.edge,
    group: port.portGroupId, port: port.portId };
}

function expandPolyline(bends: readonly GridPoint[]): GridPoint[] {
  const result: GridPoint[] = [];
  for (const bend of bends) {
    const previous = result[result.length - 1];
    if (previous === undefined) {
      result.push({ ...bend });
      continue;
    }
    if (previous.x !== bend.x && previous.y !== bend.y) {
      throw new Error(`Diagonal manual segment: ${gridKey(previous)} -> ${gridKey(bend)}`);
    }
    const dx = Math.sign(bend.x - previous.x);
    const dy = Math.sign(bend.y - previous.y);
    while (result[result.length - 1]!.x !== bend.x || result[result.length - 1]!.y !== bend.y) {
      const head = result[result.length - 1]!;
      result.push({ x: head.x + dx, y: head.y + dy });
    }
  }
  return result;
}

function gridKey(point: GridPoint): string {
  return `${point.x},${point.y}`;
}

function readOption(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
