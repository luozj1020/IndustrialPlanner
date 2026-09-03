#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createRegistryContract } from "../registry";
import type { BlueprintDocument } from "../domain/document/blueprint-document";

import { buildHeadlessMaterialGraph, optimizeHeadlessLayout } from "./layout-optimizer";
import {
  benchmarkCertifiedAreaBounds,
  createCertifiedAreaBenchmarkCaseFromResult,
  DEFAULT_CERTIFIED_AREA_BENCHMARK_BUDGETS,
  formatCertifiedAreaBenchmarkMarkdown,
  type CertifiedAreaBenchmarkCase,
} from "./certified-area-benchmark";
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

  if (command === "benchmark-area") {
    const inputPath = args[0];
    if (inputPath === undefined) {
      throw new Error("Usage: benchmark-area <suite.json> [--output benchmark.json] [--format markdown|json]");
    }
    const suitePath = resolve(inputPath);
    const suite = parseAreaBenchmarkSuite(JSON.parse(
      await readFile(suitePath, "utf8"),
    ) as unknown);
    const format = readOption(args, "--format") ?? "markdown";
    if (format !== "markdown" && format !== "json") {
      throw new Error(`Unsupported benchmark format: ${format}`);
    }
    const budgetsSeconds = suite.budgetsSeconds ?? [
      ...DEFAULT_CERTIFIED_AREA_BENCHMARK_BUDGETS,
    ];
    if (suite.gapBudgetSeconds !== undefined
      && !budgetsSeconds.includes(suite.gapBudgetSeconds)) {
      throw new Error(
        `gapBudgetSeconds ${suite.gapBudgetSeconds} is not one of the benchmark budgets`,
      );
    }
    const bootstrapProofSeconds = Math.min(...budgetsSeconds);
    const benchmarkCases: CertifiedAreaBenchmarkCase[] = [];
    const definitionById = new Map(registry.entityDefinitions.map((definition) =>
      [definition.id, definition] as const));
    for (const benchmarkCase of suite.cases) {
      const requestPath = resolve(dirname(suitePath), benchmarkCase.request);
      process.stderr.write(`benchmark-area: optimizing ${benchmarkCase.name}\n`);
      const request = JSON.parse(
        await readFile(requestPath, "utf8"),
      ) as HeadlessOptimizationRequest;
      const graph = buildHeadlessMaterialGraph(request, registry);
      const lowerBoundOnlyCase: CertifiedAreaBenchmarkCase = {
        name: benchmarkCase.name,
        devices: graph.nodes
          .filter((node) => node.kind === "production" || node.kind === "storage")
          .map((node) => {
            const definition = definitionById.get(node.definitionId);
            if (definition === undefined) {
              throw new Error(`Benchmark case ${benchmarkCase.name} is missing definition ${node.definitionId}`);
            }
            return {
              id: node.id,
              width: definition.footprint.width,
              height: definition.footprint.height,
            };
          }),
        limitWidth: request.width,
        limitHeight: request.height,
        allowRotate: request.allowRotate ?? true,
      };
      const routedIncumbentStartedAt = Date.now();
      try {
        const result = optimizeHeadlessLayout({
          ...request,
          certification: {
            ...request.certification,
            boundingArea: {
              ...request.certification?.boundingArea,
              maxSeconds: bootstrapProofSeconds,
            },
          },
        }, registry);
        benchmarkCases.push(createCertifiedAreaBenchmarkCaseFromResult({
          name: benchmarkCase.name,
          result,
          registry,
          allowRotate: request.allowRotate ?? true,
          routedIncumbentElapsedMs: Date.now() - routedIncumbentStartedAt,
        }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isRoutedIncumbentUnavailable(message)) throw error;
        process.stderr.write(`benchmark-area: no strict UB for ${benchmarkCase.name}: ${message}\n`);
        benchmarkCases.push({
          ...lowerBoundOnlyCase,
          routedIncumbentFailure: message,
          routedIncumbentElapsedMs: Date.now() - routedIncumbentStartedAt,
        });
      }
    }
    const report = benchmarkCertifiedAreaBounds({
      cases: benchmarkCases,
      budgetsSeconds,
      ...(suite.gapBudgetSeconds === undefined
        ? {} : { gapBudgetSeconds: suite.gapBudgetSeconds }),
    });
    const outputPath = readOption(args, "--output");
    if (outputPath !== undefined) {
      await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    if (format === "markdown") {
      process.stdout.write(`${formatCertifiedAreaBenchmarkMarkdown(report)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
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
    "  benchmark-area <suite.json> [--output benchmark.json] [--format markdown|json]",
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

function isRoutedIncumbentUnavailable(message: string): boolean {
  return message.startsWith("Unable to satisfy warehouse frontage hard constraint")
    || message.startsWith("Material routing succeeded for ")
    || message.startsWith("Unable to fit ")
    || message.startsWith("Unable to route ");
}

interface AreaBenchmarkSuite {
  readonly budgetsSeconds?: readonly number[];
  readonly gapBudgetSeconds?: number;
  readonly cases: readonly {
    readonly name: string;
    readonly request: string;
  }[];
}

function parseAreaBenchmarkSuite(value: unknown): AreaBenchmarkSuite {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Area benchmark suite must be an object");
  }
  const source = value as Record<string, unknown>;
  const allowedKeys = new Set(["budgetsSeconds", "gapBudgetSeconds", "cases"]);
  const unexpectedKeys = Object.keys(source).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`Unsupported area benchmark suite fields: ${unexpectedKeys.join(",")}`);
  }
  const rawCases = source["cases"];
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error("Area benchmark suite cases must be a non-empty array");
  }
  const cases = rawCases.map((rawCase, index) => {
    if (typeof rawCase !== "object" || rawCase === null || Array.isArray(rawCase)) {
      throw new Error(`Area benchmark suite cases[${index}] must be an object`);
    }
    const entry = rawCase as Record<string, unknown>;
    const unexpectedCaseKeys = Object.keys(entry).filter((key) =>
      key !== "name" && key !== "request");
    if (unexpectedCaseKeys.length > 0
      || typeof entry["name"] !== "string" || entry["name"].length === 0
      || typeof entry["request"] !== "string" || entry["request"].length === 0) {
      throw new Error(`Invalid area benchmark suite case at index ${index}`);
    }
    return { name: entry["name"], request: entry["request"] };
  });
  if (new Set(cases.map((entry) => entry.name)).size !== cases.length) {
    throw new Error("Area benchmark suite case names must be unique");
  }
  const budgetsSeconds = source["budgetsSeconds"];
  if (budgetsSeconds !== undefined
    && (!Array.isArray(budgetsSeconds)
      || budgetsSeconds.length === 0
      || budgetsSeconds.some((budget) =>
        typeof budget !== "number"
        || !Number.isFinite(budget)
        || budget <= 0
        || budget > 30))) {
    throw new Error("Area benchmark suite budgetsSeconds must contain values in (0, 30]");
  }
  const gapBudgetSeconds = source["gapBudgetSeconds"];
  if (gapBudgetSeconds !== undefined
    && (typeof gapBudgetSeconds !== "number" || !Number.isFinite(gapBudgetSeconds))) {
    throw new Error("Area benchmark suite gapBudgetSeconds must be a finite number");
  }
  return {
    ...(budgetsSeconds === undefined ? {} : { budgetsSeconds: [...budgetsSeconds] as number[] }),
    ...(gapBudgetSeconds === undefined ? {} : { gapBudgetSeconds }),
    cases,
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`headless optimizer: ${message}\n`);
  process.exitCode = 1;
});
