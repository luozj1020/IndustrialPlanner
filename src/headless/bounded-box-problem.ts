import type { EntityDefinition } from "@/domain/registry/types/entity-definition";
import type { GridRotation } from "@/domain/shared/grid";
import { resolveDevicePortEndpoints } from "@/editor/logistics/logistics-utils";
import { rotateGridEdge } from "@/shared/geometry/port";

import type { BoundedBoxMasterDevice } from "./bounded-box-master";
import type { HeadlessOptimizationRequest, HeadlessPlacedDevice } from "./types";

/** The later global phase must not silently expand the sequential constructor. */
export function resolveBoundedBoxWarmStartRequest(
  request: HeadlessOptimizationRequest,
): HeadlessOptimizationRequest {
  return request.search?.boundedBox?.enabled === true ? {
    ...request,
    search: { ...request.search, scope: "local", boundedBox: undefined },
  } : request;
}

/** Search inventory, including the generator's chosen (not globally fixed) bus count. */
export function createBoundedBoxDevices(options: {
  readonly requests: readonly {
    readonly id: string;
    readonly definition: EntityDefinition;
    readonly kind: string;
    readonly config: Record<string, unknown>;
    readonly inputs: ReadonlyMap<string, number>;
    readonly outputs: ReadonlyMap<string, number>;
    readonly allowOutputWaste?: boolean;
  }[];
  readonly incumbent: readonly HeadlessPlacedDevice[];
  readonly allowRotate: boolean;
  readonly itemKind: (itemId: string) => "belt" | "pipe";
  readonly laneCapacity: (itemId: string) => number;
}): readonly BoundedBoxMasterDevice[] {
  const hintById = new Map(options.incumbent.map((device) => [device.id, device]));
  // Normalize only the warm-start hint, never the feasible domain. Include all
  // incumbent entities (also uncharged buses, belts and power) so the suggested
  // translation does not move any physical entity above the map boundary.
  const hintShiftY = options.incumbent.length === 0 ? 0
    : Math.max(0, Math.min(...options.incumbent.map((device) => device.position.y)));
  const rotations: readonly GridRotation[] = options.allowRotate ? [0, 90, 180, 270] : [0];
  return options.requests.map((request): BoundedBoxMasterDevice => {
    const hint = hintById.get(request.id);
    const warehouseRole = request.kind === "warehouse-port" ? "port"
      : request.kind === "warehouse-bus"
        ? request.definition.id === "item_port_log_hongs_bus_source" ? "source" : "segment"
        : undefined;
    const busEdges: NonNullable<BoundedBoxMasterDevice["busEdges"]> = Object.fromEntries(
      warehouseRole === "port" ? rotations.map((rotation) => {
        const materialEdge = request.definition.portGroups[0]?.ports[0]?.edge;
        if (materialEdge === undefined) throw new Error(`Missing warehouse material edge: ${request.id}`);
        return [rotation, rotateGridEdge(materialEdge, ((rotation + 180) % 360) as GridRotation)];
      }) : [],
    );
    const requirements: NonNullable<BoundedBoxMasterDevice["portRequirements"]>[number][] = [];
    for (const direction of ["input", "output"] as const) {
      const rates = direction === "input" ? request.inputs : request.outputs;
      for (const kind of ["belt", "pipe"] as const) {
        const requiredCount = [...rates].reduce((sum, [itemId, rate]) => {
          if (options.itemKind(itemId) !== kind || rate <= 0) return sum;
          // Preserve allocation freedom: do not count current producer/consumer pairs.
          return sum + (direction === "output" && request.allowOutputWaste === true
            ? 1 : Math.max(1, Math.ceil((rate - 0.000001) / options.laneCapacity(itemId))));
        }, 0);
        if (requiredCount === 0) continue;
        const offsetsByPort = new Map<string, Record<number, { readonly x: number; readonly y: number }>>();
        for (const rotation of rotations) {
          const entity = {
            id: request.id, definitionId: request.definition.id,
            position: { x: 0, y: 0 }, rotation, config: request.config, tags: [],
          };
          for (const endpoint of resolveDevicePortEndpoints({
            entity, definition: request.definition, kind, direction, pointerGridPoint: entity.position,
          })) {
            const key = `${endpoint.portGroupId}:${endpoint.portId}`;
            const offsets = offsetsByPort.get(key) ?? {};
            offsets[rotation] = endpoint.outsideGridPoint;
            offsetsByPort.set(key, offsets);
          }
        }
        requirements.push({
          requiredCount,
          ports: [...offsetsByPort.values()].map((offsets) => ({ offsets })),
        });
      }
    }
    return {
      id: request.id,
      ...request.definition.footprint,
      charged: request.kind !== "warehouse-bus",
      ...(warehouseRole === undefined ? {} : { warehouseRole }),
      ...(warehouseRole === "port" ? { busEdges } : {}),
      ...(requirements.length === 0 ? {} : { portRequirements: requirements }),
      ...(hint === undefined ? {} : {
        hintPlacement: { x: hint.position.x, y: hint.position.y - hintShiftY, rotation: hint.rotation },
      }),
    };
  });
}
