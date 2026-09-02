import type { HeadlessMaterialGraph } from "./types";

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
  const pointByNodeId = new Map<string, { readonly x: number; readonly y: number }>();
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
    `<defs><marker id="arrow" markerWidth="14" markerHeight="14" refX="11" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,10 L12,5 z" fill="#f8fafc" stroke="#0891b2" stroke-width="1"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="#0b1120"/>`,
    `<text x="${marginX}" y="32" fill="#f8fafc" font-family="sans-serif" font-size="20" font-weight="700">${escapeXml(graph.name)}</text>`,
    `<text x="${marginX}" y="56" fill="#94a3b8" font-family="sans-serif" font-size="13">Geometry-free device material graph · arrows are allocated logistics lanes</text>`,
  ];
  layers.forEach((layer, layerIndex) => {
    output.push(`<text x="${marginX + layerIndex * layerGap + nodeWidth / 2}" y="80" text-anchor="middle" fill="#64748b" font-family="monospace" font-size="13">LAYER ${layer}</text>`);
  });
  for (const edge of graph.edges) {
    const source = pointByNodeId.get(edge.sourceId);
    const target = pointByNodeId.get(edge.targetId);
    if (source === undefined || target === undefined) continue;
    const startX = source.x + nodeWidth;
    const startY = source.y + nodeHeight / 2;
    const nodeEntryGap = 12;
    const endX = target.x - nodeEntryGap;
    const endY = target.y + nodeHeight / 2;
    const bendX = target.x > source.x ? (startX + endX) / 2 : startX + 54;
    const destinationX = target.x > source.x
      ? endX
      : target.x + nodeWidth + nodeEntryGap;
    const directionChevron = target.x > source.x
      ? `M${destinationX - 13},${endY - 8} L${destinationX},${endY} L${destinationX - 13},${endY + 8}`
      : `M${destinationX + 13},${endY - 8} L${destinationX},${endY} L${destinationX + 13},${endY + 8}`;
    output.push(
      `<path d="M${startX},${startY} C${bendX},${startY} ${bendX},${endY} ${destinationX},${endY}" fill="none" stroke="#67e8f9" stroke-opacity="0.72" stroke-width="${Math.min(7, 2 + edge.laneCount)}" marker-end="url(#arrow)"/>`,
      `<path d="${directionChevron}" fill="none" stroke="#f8fafc" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
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
    const label = (node.recipeId ?? node.definitionId).replace(/^r_/, "");
    const flow = [
      node.inputItemIds.length > 0 ? `in: ${node.inputItemIds.map(shortItemId).join(", ")}` : "",
      node.outputItemIds.length > 0 ? `out: ${node.outputItemIds.map(shortItemId).join(", ")}` : "",
    ].filter(Boolean).join("  ");
    output.push(
      `<rect x="${point.x}" y="${point.y}" width="${nodeWidth}" height="${nodeHeight}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="${component?.cyclic === true ? 3 : 1.5}"/>`,
      `<text x="${point.x + 14}" y="${point.y + 24}" fill="#f8fafc" font-family="sans-serif" font-size="13" font-weight="700">${escapeXml(shorten(label, 42))}</text>`,
      `<text x="${point.x + 14}" y="${point.y + 47}" fill="#cbd5e1" font-family="monospace" font-size="11">${escapeXml(node.id)} · ${escapeXml(node.componentId)}${component?.cyclic === true ? " · SCC" : ""}</text>`,
      `<text x="${point.x + 14}" y="${point.y + 70}" fill="#94a3b8" font-family="monospace" font-size="10">${escapeXml(shorten(flow, 52))}</text>`,
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
