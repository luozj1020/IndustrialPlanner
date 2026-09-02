import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { WorldEntity } from "@/domain/document/world-document";
import type { EntityDefinition } from "@/domain/registry/types/entity-definition";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { GridEdge } from "@/domain/shared/grid";
import type { LogisticsKind } from "@/domain/shared/logistics";
import { resolveDevicePortEndpoints } from "@/editor/logistics/logistics-utils";
import { resolvePowerRangeGridRect } from "@/shared/geometry/power-range";

export interface SvgRenderOptions {
  readonly cellSize?: number;
  readonly showGrid?: boolean;
  readonly showLabels?: boolean;
  readonly showPowerRanges?: boolean;
}

interface RenderBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function renderBlueprintSvg(
  blueprint: BlueprintDocument,
  registry: RegistryContract,
  options: SvgRenderOptions = {},
): string {
  const cellSize = options.cellSize ?? 52;
  const showGrid = options.showGrid ?? true;
  const showLabels = options.showLabels ?? true;
  const showPowerRanges = options.showPowerRanges ?? true;
  const definitionMap = new Map(registry.entityDefinitions.map((definition) => [definition.id, definition]));
  const entities = blueprint.entityOrder
    .map((id) => blueprint.entities[id])
    .filter((entity): entity is WorldEntity => entity !== undefined);
  const bounds = measureBounds(entities, definitionMap, showPowerRanges);
  const paddingCells = 1;
  const legendHeight = 56;
  const gridWidth = Math.max(1, bounds.maxX - bounds.minX);
  const gridHeight = Math.max(1, bounds.maxY - bounds.minY);
  const width = (gridWidth + paddingCells * 2) * cellSize;
  const height = (gridHeight + paddingCells * 2) * cellSize + legendHeight;
  const originX = (paddingCells - bounds.minX) * cellSize;
  const originY = (paddingCells - bounds.minY) * cellSize + legendHeight;
  const output: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${escapeXml(blueprint.name)}</title>`,
    `<defs>`,
    `<marker id="arrow-belt" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#f7b955"/></marker>`,
    `<marker id="arrow-pipe" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#38bdf8"/></marker>`,
    `<pattern id="power-range-hatch" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M-4,4 L4,-4 M0,16 L16,0 M12,20 L20,12" fill="none" stroke="#164e63" stroke-width="3"/></pattern>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="#10151d"/>`,
    `<text x="${cellSize}" y="30" fill="#f2f5f8" font-family="sans-serif" font-size="18" font-weight="700">${escapeXml(blueprint.name)}</text>`,
    `<g font-family="sans-serif" font-size="12" fill="#cbd5e1">`,
    `<rect x="${cellSize}" y="39" width="13" height="13" rx="2" fill="#475569"/><text x="${cellSize + 19}" y="50">Production</text>`,
    `<line x1="${cellSize + 110}" y1="46" x2="${cellSize + 140}" y2="46" stroke="#f7b955" stroke-width="5"/><text x="${cellSize + 148}" y="50">Belt</text>`,
    `<line x1="${cellSize + 210}" y1="46" x2="${cellSize + 240}" y2="46" stroke="#38bdf8" stroke-width="5"/><text x="${cellSize + 248}" y="50">Pipe</text>`,
    `<rect x="${cellSize + 315}" y="39" width="13" height="13" rx="2" fill="#38bdf8" fill-opacity="0.14" stroke="#7dd3fc" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${cellSize + 334}" y="50">Power range</text>`,
    `</g>`,
  ];

  if (showGrid) {
    output.push(`<g stroke="#263241" stroke-width="1">`);
    for (let x = 0; x <= gridWidth; x += 1) {
      const pixelX = originX + (bounds.minX + x) * cellSize;
      output.push(`<line x1="${pixelX}" y1="${originY + bounds.minY * cellSize}" x2="${pixelX}" y2="${originY + bounds.maxY * cellSize}"/>`);
    }
    for (let y = 0; y <= gridHeight; y += 1) {
      const pixelY = originY + (bounds.minY + y) * cellSize;
      output.push(`<line x1="${originX + bounds.minX * cellSize}" y1="${pixelY}" x2="${originX + bounds.maxX * cellSize}" y2="${pixelY}"/>`);
    }
    output.push(`</g>`);
  }

  if (showPowerRanges) {
    output.push(`<g data-layer="power-ranges">`);
    for (const entity of entities) {
      const definition = definitionMap.get(entity.definitionId);
      if (definition === undefined) continue;
      const range = resolvePowerRangeGridRect({ entity, definition });
      if (range === null) continue;
      const x = originX + range.x * cellSize;
      const y = originY + range.y * cellSize;
      const width = range.width * cellSize;
      const height = range.height * cellSize;
      output.push(
        `<g data-power-source="${escapeXml(entity.id)}">`,
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="url(#power-range-hatch)" stroke="#7dd3fc" stroke-width="2.5" stroke-dasharray="10 7"/>`,
        `<text x="${x + 8}" y="${y + 18}" fill="#bae6fd" font-family="monospace" font-size="11">Power ${escapeXml(entity.id)} · ${range.width}×${range.height}</text>`,
        `</g>`,
      );
    }
    output.push(`</g>`);
  }

  for (const entity of entities) {
    const definition = definitionMap.get(entity.definitionId);
    if (definition === undefined) continue;
    const logisticsKind = resolveRenderLogisticsKind(entity.definitionId, registry);
    if (logisticsKind === null) {
      output.push(renderProductionEntity(entity, definition, originX, originY, cellSize, showLabels));
    } else {
      output.push(renderLogisticsEntity(entity, definition, logisticsKind, originX, originY, cellSize));
    }
  }

  output.push(`</svg>`);
  return `${output.join("\n")}\n`;
}

function resolveRenderLogisticsKind(definitionId: string, registry: RegistryContract): LogisticsKind | null {
  const dedicated = registry.queries.resolveDedicatedLogisticsKind(definitionId);
  if (dedicated !== null) return dedicated;
  if (definitionId.startsWith("item_log_")) return "belt";
  if (definitionId.startsWith("item_pipe_")) return "pipe";
  return null;
}

function renderProductionEntity(
  entity: WorldEntity,
  definition: EntityDefinition,
  originX: number,
  originY: number,
  cellSize: number,
  showLabels: boolean,
): string {
  const footprint = rotatedFootprint(definition, entity.rotation);
  const x = originX + entity.position.x * cellSize;
  const y = originY + entity.position.y * cellSize;
  const width = footprint.width * cellSize;
  const height = footprint.height * cellSize;
  const recipe = entity.tags.find((tag) => tag.startsWith("recipe:"))?.slice(7) ?? "";
  const label = recipe === "" ? entity.definitionId : recipe.replace(/^r_/, "");
  const parts = [
    `<g>`,
    `<rect x="${x + 2}" y="${y + 2}" width="${width - 4}" height="${height - 4}" rx="8" fill="#334155" stroke="#94a3b8" stroke-width="2"/>`,
  ];
  if (showLabels) {
    parts.push(
      `<text x="${x + width / 2}" y="${y + height / 2 - 4}" text-anchor="middle" fill="#f8fafc" font-family="sans-serif" font-size="${Math.min(13, cellSize / 4)}" font-weight="700">${escapeXml(shorten(label, Math.max(14, footprint.width * 7)))}</text>`,
      `<text x="${x + width / 2}" y="${y + height / 2 + 14}" text-anchor="middle" fill="#94a3b8" font-family="monospace" font-size="11">${escapeXml(entity.id)}</text>`,
    );
  }
  for (const kind of ["belt", "pipe"] as const) {
    const color = kind === "belt" ? "#f7b955" : "#38bdf8";
    for (const direction of ["input", "output"] as const) {
      for (const endpoint of resolveDevicePortEndpoints({
        entity,
        definition,
        kind,
        direction,
        pointerGridPoint: entity.position,
      })) {
        const cx = originX + (endpoint.insideGridPoint.x + 0.5) * cellSize;
        const cy = originY + (endpoint.insideGridPoint.y + 0.5) * cellSize;
        parts.push(`<circle cx="${cx}" cy="${cy}" r="4" fill="${direction === "input" ? "#10151d" : color}" stroke="${color}" stroke-width="2"/>`);
      }
    }
  }
  parts.push(`</g>`);
  return parts.join("\n");
}

function renderLogisticsEntity(
  entity: WorldEntity,
  definition: EntityDefinition,
  kind: LogisticsKind,
  originX: number,
  originY: number,
  cellSize: number,
): string {
  const centerX = originX + (entity.position.x + 0.5) * cellSize;
  const centerY = originY + (entity.position.y + 0.5) * cellSize;
  const color = kind === "belt" ? "#f7b955" : "#38bdf8";
  if (entity.definitionId.endsWith("_connector")) {
    const distance = cellSize * 0.45;
    return [
      `<g>`,
      `<rect x="${originX + entity.position.x * cellSize + 3}" y="${originY + entity.position.y * cellSize + 3}" width="${cellSize - 6}" height="${cellSize - 6}" rx="5" fill="${kind === "belt" ? "#3b3020" : "#173449"}" stroke="${color}" stroke-width="2"/>`,
      `<line x1="${centerX - distance}" y1="${centerY}" x2="${centerX + distance}" y2="${centerY}" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`,
      `<line x1="${centerX}" y1="${centerY - distance}" x2="${centerX}" y2="${centerY + distance}" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`,
      `<circle cx="${centerX}" cy="${centerY}" r="5" fill="#10151d" stroke="${color}" stroke-width="2"/>`,
      `</g>`,
    ].join("\n");
  }
  const input = resolveDevicePortEndpoints({
    entity, definition, kind, direction: "input", pointerGridPoint: entity.position,
  })[0];
  const output = resolveDevicePortEndpoints({
    entity, definition, kind, direction: "output", pointerGridPoint: entity.position,
  })[0];
  if (input === undefined || output === undefined) return "";
  const from = edgePoint(centerX, centerY, input.edge, cellSize * 0.45);
  const to = edgePoint(centerX, centerY, output.edge, cellSize * 0.45);
  return [
    `<g>`,
    `<rect x="${originX + entity.position.x * cellSize + 3}" y="${originY + entity.position.y * cellSize + 3}" width="${cellSize - 6}" height="${cellSize - 6}" rx="5" fill="${kind === "belt" ? "#3b3020" : "#173449"}"/>`,
    `<polyline points="${from.x},${from.y} ${centerX},${centerY} ${to.x},${to.y}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow-${kind})"/>`,
    `</g>`,
  ].join("\n");
}

function measureBounds(
  entities: readonly WorldEntity[],
  definitionMap: ReadonlyMap<string, EntityDefinition>,
  includePowerRanges: boolean,
): RenderBounds {
  if (entities.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const entity of entities) {
    const definition = definitionMap.get(entity.definitionId);
    if (definition === undefined) continue;
    const footprint = rotatedFootprint(definition, entity.rotation);
    minX = Math.min(minX, entity.position.x);
    minY = Math.min(minY, entity.position.y);
    maxX = Math.max(maxX, entity.position.x + footprint.width);
    maxY = Math.max(maxY, entity.position.y + footprint.height);
    if (includePowerRanges) {
      const range = resolvePowerRangeGridRect({ entity, definition });
      if (range !== null) {
        minX = Math.min(minX, range.x);
        minY = Math.min(minY, range.y);
        maxX = Math.max(maxX, range.x + range.width);
        maxY = Math.max(maxY, range.y + range.height);
      }
    }
  }
  return Number.isFinite(minX)
    ? { minX, minY, maxX, maxY }
    : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
}

function rotatedFootprint(definition: EntityDefinition, rotation: WorldEntity["rotation"]): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: definition.footprint.height, height: definition.footprint.width }
    : definition.footprint;
}

function edgePoint(x: number, y: number, edge: GridEdge, distance: number): { x: number; y: number } {
  switch (edge) {
    case "NORTH": return { x, y: y - distance };
    case "EAST": return { x: x + distance, y };
    case "SOUTH": return { x, y: y + distance };
    case "WEST": return { x: x - distance, y };
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]!);
}

function shorten(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
