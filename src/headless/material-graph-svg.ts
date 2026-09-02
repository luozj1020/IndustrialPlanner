import type { HeadlessMaterialGraph } from "./types";

interface GraphPoint {
  readonly x: number;
  readonly y: number;
}

export function renderMaterialGraphSvg(graph: HeadlessMaterialGraph): string {
  const nodeWidth = 300;
  const nodeHeight = 90;
  const layerGap = 370;
  const rowGap = 120;
  const marginX = 60;
  const headerHeight = 90;
  const layers = [...new Set(graph.nodes.map((node) => node.layer))].sort((a, b) => a - b);
  const nodesByLayer = new Map(layers.map((layer) => [
    layer,
    graph.nodes.filter((node) => node.layer === layer),
  ]));
  const maximumRows = Math.max(1, ...[...nodesByLayer.values()].map((nodes) => nodes.length));
  const width = marginX * 2 + Math.max(1, layers.length) * layerGap;
  const height = headerHeight + maximumRows * rowGap + 70;
  const pointByNodeId = new Map<string, GraphPoint>();
  layers.forEach((layer, layerIndex) => {
    const nodes = nodesByLayer.get(layer) ?? [];
    const layerHeight = Math.max(0, (nodes.length - 1) * rowGap + nodeHeight);
    const top = headerHeight + Math.max(0, (maximumRows * rowGap - layerHeight) / 2);
    nodes.forEach((node, rowIndex) => {
      pointByNodeId.set(node.id, {
        x: marginX + layerIndex * layerGap,
        y: top + rowIndex * rowGap,
      });
    });
  });
  const componentById = new Map(graph.components.map((component) => [component.id, component]));
  const output = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${escapeXml(graph.name)} — material graph</title>`,
    `<defs>`,
    `<marker id="material-arrow" markerWidth="14" markerHeight="14" refX="11" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,10 L12,5 z" fill="#f8fafc" stroke="#0891b2" stroke-width="1"/></marker>`,
    `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#020617" flood-opacity="0.55"/></filter>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="#0b1120"/>`,
    `<text x="${marginX}" y="32" fill="#f8fafc" font-family="sans-serif" font-size="20" font-weight="700">${escapeXml(graph.name)}</text>`,
    `<text x="${marginX}" y="56" fill="#94a3b8" font-family="sans-serif" font-size="13">Geometry-free device material graph · arrows are allocated logistics lanes</text>`,
  ];
  layers.forEach((layer, layerIndex) => {
    output.push(
      `<text x="${marginX + layerIndex * layerGap + nodeWidth / 2}" y="80" text-anchor="middle" fill="#64748b" font-family="monospace" font-size="13">LAYER ${layer}</text>`,
    );
  });

  const parallelEdgeIndex = new Map<string, number>();
  for (const edge of graph.edges) {
    const source = pointByNodeId.get(edge.sourceId);
    const target = pointByNodeId.get(edge.targetId);
    if (source === undefined || target === undefined) continue;
    const pairKey = `${edge.sourceId}->${edge.targetId}`;
    const offsetIndex = parallelEdgeIndex.get(pairKey) ?? 0;
    parallelEdgeIndex.set(pairKey, offsetIndex + 1);
    const offset = offsetIndex * 10;
    const startX = source.x + nodeWidth;
    const startY = source.y + nodeHeight / 2 + offset;
    const nodeEntryGap = 12;
    const endX = target.x - nodeEntryGap;
    const endY = target.y + nodeHeight / 2 + offset;
    let path: string;
    let labelX: number;
    let labelY: number;
    let directionChevron: string;
    if (target.x > source.x) {
      const bend = Math.max(50, (endX - startX) / 2);
      path = `M${startX},${startY} C${startX + bend},${startY} ${endX - bend},${endY} ${endX},${endY}`;
      labelX = (startX + endX) / 2;
      labelY = (startY + endY) / 2 - 7;
      directionChevron = `M${endX - 13},${endY - 8} L${endX},${endY} L${endX - 13},${endY + 8}`;
    } else {
      const loopX = Math.max(startX, target.x + nodeWidth) + 54 + offsetIndex * 12;
      const backwardEndX = target.x + nodeWidth + nodeEntryGap;
      path = `M${startX},${startY} C${loopX},${startY} ${loopX},${endY} ${backwardEndX},${endY}`;
      labelX = loopX;
      labelY = (startY + endY) / 2 - 7;
      directionChevron = `M${backwardEndX + 13},${endY - 8} L${backwardEndX},${endY} L${backwardEndX + 13},${endY + 8}`;
    }
    output.push(
      `<path d="${path}" fill="none" stroke="#67e8f9" stroke-opacity="0.72" stroke-width="${Math.min(7, 2 + edge.laneCount)}" marker-end="url(#material-arrow)"/>`,
      `<path d="${directionChevron}" fill="none" stroke="#f8fafc" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
      `<text x="${labelX}" y="${labelY}" text-anchor="middle" fill="#bae6fd" stroke="#0b1120" stroke-width="4" paint-order="stroke" font-family="monospace" font-size="11">→ ${escapeXml(shortItemId(edge.itemId))} · ${edge.laneCount} lane${edge.laneCount === 1 ? "" : "s"}</text>`,
    );
  }

  for (const node of graph.nodes) {
    const point = pointByNodeId.get(node.id)!;
    const component = componentById.get(node.componentId);
    const fill = node.kind === "warehouse-port"
      ? "#164e63"
      : node.kind === "storage"
        ? "#4c1d95"
        : "#1e293b";
    const stroke = component?.cyclic === true ? "#fb923c" : "#94a3b8";
    const primaryLabel = node.recipeId === null
      ? node.definitionId
      : node.recipeId.replace(/^r_/, "");
    const flowLabel = [
      node.inputItemIds.length > 0 ? `in: ${node.inputItemIds.map(shortItemId).join(", ")}` : "",
      node.outputItemIds.length > 0 ? `out: ${node.outputItemIds.map(shortItemId).join(", ")}` : "",
    ].filter(Boolean).join("  ");
    output.push(
      `<g filter="url(#shadow)">`,
      `<rect x="${point.x}" y="${point.y}" width="${nodeWidth}" height="${nodeHeight}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="${component?.cyclic === true ? 3 : 1.5}"/>`,
      `<text x="${point.x + 14}" y="${point.y + 22}" fill="#f8fafc" font-family="sans-serif" font-size="13" font-weight="700">${escapeXml(shorten(primaryLabel, 42))}</text>`,
      `<text x="${point.x + 14}" y="${point.y + 43}" fill="#cbd5e1" font-family="monospace" font-size="11">${escapeXml(node.id)} · ${escapeXml(node.componentId)}${component?.cyclic === true ? " · SCC" : ""}</text>`,
      `<text x="${point.x + 14}" y="${point.y + 65}" fill="#94a3b8" font-family="monospace" font-size="10">${escapeXml(shorten(flowLabel, 52))}</text>`,
      `<text x="${point.x + 14}" y="${point.y + 81}" fill="#64748b" font-family="monospace" font-size="9">${escapeXml(shorten(node.definitionId, 58))}</text>`,
      `</g>`,
    );
  }
  output.push(`</svg>`);
  return `${output.join("\n")}\n`;
}

function shortItemId(itemId: string): string {
  return itemId.replace(/^item_/, "");
}

function shorten(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
