#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createRegistryContract } from "@/registry";
import type { BlueprintDocument } from "@/domain/document/blueprint-document";

import { buildHeadlessMaterialGraph, optimizeHeadlessLayout } from "./layout-optimizer";
import { renderMaterialGraphSvg } from "./material-graph-svg";
import { renderBlueprintSvg } from "./svg-renderer";
import type { HeadlessOptimizationRequest } from "./types";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const registry = createRegistryContract();

  if (command === "items") {
    const query = (args[0] ?? "").toLowerCase();
    const rows = registry.itemDefinitions
      .filter((item) => query === "" || item.id.toLowerCase().includes(query) || item.nameKey.toLowerCase().includes(query))
      .map((item) => ({ id: item.id, nameKey: item.nameKey, tags: item.tags }));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  if (command === "recipes") {
    const itemId = args[0];
    if (itemId === undefined) throw new Error("Usage: recipes <output-item-id>");
    const rows = registry.recipeDefinitions
      .filter((recipe) => recipe.outputs.some((output) => output.itemId === itemId))
      .map((recipe) => ({
        id: recipe.id,
        machineId: recipe.machineId,
        durationSeconds: recipe.durationSeconds,
        inputs: recipe.inputs,
        outputs: recipe.outputs,
      }));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  if (command === "optimize") {
    const inputPath = args[0];
    if (inputPath === undefined) throw new Error("Usage: optimize <request.json> [--output blueprint.json] [--report report.json] [--svg layout.svg]");
    const outputPath = readOption(args, "--output") ?? "optimized-blueprint.json";
    const reportPath = readOption(args, "--report");
    const svgPath = readOption(args, "--svg");
    const request = JSON.parse(await readFile(resolve(inputPath), "utf8")) as HeadlessOptimizationRequest;
    const result = optimizeHeadlessLayout(request, registry);
    await writeFile(resolve(outputPath), `${JSON.stringify(result.blueprint, null, 2)}\n`, "utf8");
    if (reportPath !== undefined) {
      await writeFile(resolve(reportPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (svgPath !== undefined) {
      await writeFile(resolve(svgPath), renderBlueprintSvg(result.blueprint, registry), "utf8");
    }
    process.stdout.write(`${JSON.stringify({
      output: resolve(outputPath),
      ...(svgPath === undefined ? {} : { visualization: resolve(svgPath) }),
      used: `${result.layout.usedWidth}x${result.layout.usedHeight}`,
      boundingArea: result.layout.boundingArea,
      boundingAreaLowerBound: result.optimality.boundingArea.lowerBound,
      boundingAreaAbsoluteGap: result.optimality.boundingArea.absoluteGap,
      boundingAreaRelativeGap: result.optimality.boundingArea.relativeGap,
      boundingAreaOptimalityStatus: result.optimality.boundingArea.status,
      physicalUsed: `${result.layout.physicalUsedWidth}x${result.layout.physicalUsedHeight}`,
      physicalBoundingArea: result.layout.physicalBoundingArea,
      contourArea: result.layout.contourArea,
      contourVoidArea: result.layout.contourVoidArea,
      boundingVoidCells: result.layout.boundingVoidCellCount,
      enclosedVoidCells: result.layout.enclosedVoidCellCount,
      frontageOverflowCells: result.layout.frontageOverflowCellCount,
      equipmentArea: result.layout.equipmentArea,
      utilization: result.layout.utilization,
      productionDevices: result.layout.productionDeviceCount,
      logisticsDevices: result.layout.logisticsDeviceCount,
      beltCells: result.layout.beltCellCount,
      areaExcludedBeltCells: result.layout.areaExcludedBeltCellCount,
      pipeCells: result.layout.pipeCellCount,
      storageDevices: result.layout.storageDeviceCount,
      warehousePorts: result.layout.warehousePortCount,
      warehouseBusSegments: result.layout.warehouseBusCount,
      powerDevices: result.layout.powerDeviceCount,
      minimumPowerDevices: result.layout.minimumPowerDeviceCount,
      routedConnections: result.validation.routedConnectionCount,
      search: result.search,
      topologyErrors: result.validation.errorCount,
      productionConnectivityVerified: result.validation.productionConnectivityVerified,
      productionThroughputVerified: result.validation.productionThroughputVerified,
      powerCoverageVerified: result.validation.powerCoverageVerified,
    }, null, 2)}\n`);
    return;
  }

  if (command === "graph") {
    const inputPath = args[0];
    if (inputPath === undefined) {
      throw new Error("Usage: graph <request.json> [--output material-graph.svg] [--json material-graph.json]");
    }
    const outputPath = readOption(args, "--output") ?? replaceJsonExtension(inputPath, "-material-graph.svg");
    const jsonPath = readOption(args, "--json");
    const request = JSON.parse(await readFile(resolve(inputPath), "utf8")) as HeadlessOptimizationRequest;
    const graph = buildHeadlessMaterialGraph(request, registry);
    await writeFile(resolve(outputPath), renderMaterialGraphSvg(graph), "utf8");
    if (jsonPath !== undefined) {
      await writeFile(resolve(jsonPath), `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`${JSON.stringify({
      visualization: resolve(outputPath),
      ...(jsonPath === undefined ? {} : { graph: resolve(jsonPath) }),
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      components: graph.components.length,
    }, null, 2)}\n`);
    return;
  }

  if (command === "render") {
    const inputPath = args[0];
    if (inputPath === undefined) throw new Error("Usage: render <blueprint.json> [--output layout.svg]");
    const outputPath = readOption(args, "--output") ?? replaceJsonExtension(inputPath, ".svg");
    const blueprint = JSON.parse(await readFile(resolve(inputPath), "utf8")) as BlueprintDocument;
    if (typeof blueprint.name !== "string" || !Array.isArray(blueprint.entityOrder) || typeof blueprint.entities !== "object") {
      throw new Error(`Invalid blueprint document: ${inputPath}`);
    }
    await writeFile(resolve(outputPath), renderBlueprintSvg(blueprint, registry), "utf8");
    process.stdout.write(`${JSON.stringify({ visualization: resolve(outputPath) }, null, 2)}\n`);
    return;
  }

  process.stdout.write([
    "IndustrialPlanner headless optimizer",
    "",
    "  items [query]",
    "  recipes <output-item-id>",
    "  graph <request.json> [--output material-graph.svg] [--json material-graph.json]",
    "  optimize <request.json> [--output blueprint.json] [--report report.json] [--svg layout.svg]",
    "  render <blueprint.json> [--output layout.svg]",
    "",
  ].join("\n"));
}

function replaceJsonExtension(path: string, extension: string): string {
  return path.toLowerCase().endsWith(".json") ? `${path.slice(0, -5)}${extension}` : `${path}${extension}`;
}

function readOption(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`headless optimizer: ${message}\n`);
  process.exitCode = 1;
});
