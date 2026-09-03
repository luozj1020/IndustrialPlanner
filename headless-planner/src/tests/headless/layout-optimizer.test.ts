import { describe, expect, it } from "vitest";

import {
  assessLayerInterlockWidthFeasibility,
  allocateRefinementCandidateBudgets,
  boundedCbs,
  buildHeadlessMaterialGraph,
  buildTopologyComponents,
  compareObjectiveVectors,
  createEdgeStorageMovementCandidates,
  createHotspotTargetPortAssignments,
  createProvenStraightBeltCutCollapses,
  createRouteFailureCapacityCut,
  createRouteFailurePoseCut,
  createSameRowTerminalPlacements,
  detectSlots,
  discoverFlowClusters,
  enumerateFoldableFeedbackCycles,
  enumerateFoldedFeedbackShelfPlans,
  identifyFoldableFeedbackCycle,
  measureFactoryFootprintBounds,
  measureFrontageOverflowCells,
  mergeExclusiveFeedbackBranches,
  optimizeHeadlessLayout,
  packFoldedFeedbackShelves,
  rankObjectiveHotspots,
  resolveConflictingConnections,
  resolveRecipeDeviceLoadFractions,
  resolveNearestDownstreamMergeOrder,
  resolveWarehouseBranchPlacementLayers,
  resolveRequiredLogisticsLaneCount,
  ripUpAndReroute,
  searchEjectionChains,
  solveCyclicRecipeCounts,
  solveMinimumCoverage,
  selectObjectivePartialDestroyIds,
  selectEdgeStorageMovementBeam,
  selectTerminalRowInterlockBeam,
  selectQualityDiverseIndexes,
  selectUnattemptedRoutingVariants,
  translateRigidDeviceCluster,
} from "../../headless/layout-optimizer";
import type { HeadlessPlacedDevice } from "../../headless/types";
import { renderBlueprintSvg } from "../../headless/svg-renderer";
import { createRegistryContract } from "../../registry";
import { normalizeBlueprintDocument } from "../../shared/blueprints/blueprint-document-codec";
import {
  areGridRectsIntersecting,
  resolvePowerRangeGridRect,
} from "../../shared/geometry/power-range";

describe("headless layout optimizer", () => {
  const device = (
    id: string,
    x: number,
    y: number,
    width = 2,
    height = 2,
    kind: HeadlessPlacedDevice["kind"] = "production",
  ): HeadlessPlacedDevice => ({
    id,
    definitionId: `definition-${id}`,
    kind,
    recipeId: kind === "production" ? `recipe-${id}` : null,
    position: { x, y },
    rotation: 0,
    width,
    height,
  });

  it("assigns fractional recipe demand to full machines plus one remainder", () => {
    expect(resolveRecipeDeviceLoadFractions(5 / 3)[0]).toBe(1);
    expect(resolveRecipeDeviceLoadFractions(5 / 3)[1]).toBeCloseTo(2 / 3);
    expect(resolveRecipeDeviceLoadFractions(2)).toEqual([1, 1]);
    expect(resolveRecipeDeviceLoadFractions(0)).toEqual([]);
    expect(resolveRecipeDeviceLoadFractions(5 / 3, 5)).toHaveLength(5);
    for (const fraction of resolveRecipeDeviceLoadFractions(5 / 3, 5)) {
      expect(fraction).toBeCloseTo(1 / 3);
    }
    expect(resolveRecipeDeviceLoadFractions(5 / 3, 0, true)).toEqual([1, 1]);
  });

  it("delays only a warehouse-fed single-successor branch beside its consumer", () => {
    const source = { deviceIds: ["source"], layer: 1 };
    const branch = { deviceIds: ["branch"], layer: 1 };
    const shared = { deviceIds: ["shared"], layer: 1 };
    const middle = { deviceIds: ["middle"], layer: 2 };
    const terminal = { deviceIds: ["terminal"], layer: 3 };
    const layers = resolveWarehouseBranchPlacementLayers({
      components: [source, branch, shared, middle, terminal],
      edges: [
        { sourceId: "source", targetId: "middle" },
        { sourceId: "middle", targetId: "terminal" },
        { sourceId: "branch", targetId: "terminal" },
        { sourceId: "shared", targetId: "middle" },
        { sourceId: "shared", targetId: "terminal" },
      ],
      warehouseSuppliedDeviceIds: new Set(["source", "branch", "shared"]),
    });

    expect(layers.get(branch)).toBe(2);
    expect(layers.get(source)).toBe(1);
    expect(layers.get(shared)).toBe(1);
  });

  it("orders external supplies by their nearest downstream fan-in", () => {
    const edges = [
      { sourceId: "iron-a", targetId: "iron-powder" },
      { sourceId: "iron-powder", targetId: "thickener-a" },
      { sourceId: "moss-a", targetId: "thickener-a" },
      { sourceId: "originium-a", targetId: "thickener-b" },
      { sourceId: "moss-b", targetId: "thickener-b" },
      { sourceId: "thickener-a", targetId: "storage" },
      { sourceId: "thickener-b", targetId: "storage" },
    ];

    expect(resolveNearestDownstreamMergeOrder("iron-a", edges)).toEqual({
      anchorIds: ["thickener-a"],
      depth: 2,
    });
    expect(resolveNearestDownstreamMergeOrder("moss-a", edges)).toEqual({
      anchorIds: ["thickener-a"],
      depth: 1,
    });
    expect(resolveNearestDownstreamMergeOrder("moss-b", edges)).toEqual({
      anchorIds: ["thickener-b"],
      depth: 1,
    });
  });

  it("proves layer-interlock width before placement or routing", () => {
    expect(assessLayerInterlockWidthFeasibility({
      frontageWidth: 15,
      terminalLayerDeviceWidths: [6],
      insertedLayerDeviceWidths: [3, 3],
      requiredRoutingColumns: 2,
    })).toMatchObject({ feasible: true, requiredWidth: 14, residualWidth: 1 });
    expect(assessLayerInterlockWidthFeasibility({
      frontageWidth: 18,
      terminalLayerDeviceWidths: [6, 6, 6],
      insertedLayerDeviceWidths: [3],
      requiredRoutingColumns: 1,
    })).toMatchObject({
      feasible: false,
      requiredWidth: 22,
      reason: "terminal-layer-saturates-frontage",
    });
  });

  it("proves the minimum compatible coverage cardinality before geometric scoring", () => {
    const candidates = [
      { id: "ab", coveredTargetIds: ["a", "b"] },
      { id: "c", coveredTargetIds: ["c"] },
      { id: "a", coveredTargetIds: ["a"] },
      { id: "b", coveredTargetIds: ["b"] },
      { id: "c-alt", coveredTargetIds: ["c"] },
    ];
    const unconstrained = solveMinimumCoverage({
      targetIds: ["a", "b", "c"],
      candidates,
    });
    expect(unconstrained?.minimumCount).toBe(2);
    expect(new Set(unconstrained?.selectedCandidateIds)).toEqual(new Set(["ab", "c"]));
    const conflictConstrained = solveMinimumCoverage({
      targetIds: ["a", "b", "c"],
      candidates,
      areCompatible: (left, right) =>
        !([left.id, right.id].includes("ab")
          && [left.id, right.id].some((id) => id === "c" || id === "c-alt")),
    });
    expect(conflictConstrained?.minimumCount).toBe(3);
    expect(new Set(conflictConstrained?.selectedCandidateIds)).toEqual(new Set(["a", "b", "c"]));
  });

  it("materializes a proven straight-row clear as a contracted route seed", () => {
    const devices = [
      device("source", 1, 2, 2, 2),
      device("target", 1, 8, 2, 2, "storage"),
    ];
    const collapses = createProvenStraightBeltCutCollapses({
      devices,
      connections: [{
        id: "source-to-target",
        itemId: "item",
        kind: "belt",
        perMinute: 30,
        sourceDeviceId: "source",
        targetDeviceId: "target",
        points: [
          { x: 2, y: 4 },
          { x: 2, y: 5 },
          { x: 2, y: 6 },
          { x: 2, y: 7 },
        ],
      }],
      limitWidth: 12,
      limitHeight: 12,
    });
    const firstRow = collapses.find((collapse) =>
      collapse.axis === "horizontal" && collapse.coordinate === 5);

    expect(firstRow?.devices.map((item) => [item.id, item.position.y])).toEqual([
      ["source", 2],
      ["target", 7],
    ]);
    expect(firstRow?.connections[0]?.points).toEqual([
      { x: 2, y: 4 },
      { x: 2, y: 5 },
      { x: 2, y: 6 },
    ]);
    expect([...(firstRow?.movedDeviceIds ?? [])]).toEqual(["target"]);
    expect([...(firstRow?.invalidConnectionIds ?? [])]).toEqual([]);
  });

  it("moves and reorients terminal storage independently after its producer settles", () => {
    const devices = [
      device("producer", 5, 10, 6, 4),
      { ...device("storage", 2, 12, 3, 3, "storage"), rotation: 180 as const },
    ];
    const candidates = createEdgeStorageMovementCandidates({
      devices,
      routedConnections: [{ sourceDeviceId: "producer", targetDeviceId: "storage" }],
      limitWidth: 20,
      limitHeight: 30,
      allowRotate: true,
    });
    const compacted = candidates.find((candidate) =>
      candidate.storageDeviceId === "storage"
      && candidate.deltaX === 0
      && candidate.deltaY === -1
      && candidate.rotation === 0);

    expect(compacted?.devices.find((item) => item.id === "storage")).toMatchObject({
      position: { x: 2, y: 11 },
      rotation: 0,
    });
    expect(compacted?.devices.find((item) => item.id === "producer")).toMatchObject({
      position: { x: 5, y: 10 },
      rotation: 0,
    });
    expect(selectEdgeStorageMovementBeam({
      candidates,
      maximum: 12,
    })).toContain(compacted);
  });

  it("places a terminal beside a direct-upstream row through a one-cell port corridor", () => {
    const devices = [
      device("component-a", 0, 14, 3, 3),
      device("component-b", 3, 14, 3, 3),
      device("terminal", 5, 18, 6, 4),
      device("storage", 2, 19, 3, 3, "storage"),
    ];
    const candidates = createSameRowTerminalPlacements({
      devices,
      terminalDeviceId: "terminal",
      rowDeviceIds: ["component-a", "component-b"],
      limitWidth: 15,
      limitHeight: 30,
      allowRotate: true,
    });
    const rightFacing = candidates.find((candidate) => {
      const terminal = candidate.devices.find((item) => item.id === "terminal");
      return candidate.side === "right"
        && candidate.alignment === "top"
        && candidate.rotation === 90
        && terminal?.position.x === 7
        && terminal.position.y === 14
        && terminal.width === 4
        && terminal.height === 6;
    });

    expect(rightFacing).toBeDefined();
    expect(rightFacing?.devices.filter((item) =>
      item.id.startsWith("component-")).map((item) => item.position)).toEqual([
      { x: 0, y: 14 },
      { x: 3, y: 14 },
    ]);
    const spacedUnrotated = candidates.find((candidate) => {
      const terminal = candidate.devices.find((item) => item.id === "terminal");
      const second = candidate.devices.find((item) => item.id === "component-b");
      return candidate.side === "right"
        && candidate.alignment === "top"
        && candidate.rotation === 0
        && !candidate.rotationChanged
        && candidate.shiftedRowDeviceIds.join(",") === "component-b"
        && second?.position.x === 4
        && terminal?.position.x === 8
        && terminal.position.y === 14
        && terminal.width === 6
        && terminal.height === 4;
    });
    expect(spacedUnrotated).toBeDefined();
    const powerPocket = candidates.find((candidate) => {
      const terminal = candidate.devices.find((item) => item.id === "terminal");
      const second = candidate.devices.find((item) => item.id === "component-b");
      return candidate.side === "right"
        && candidate.alignment === "top"
        && candidate.rotation === 0
        && second?.position.x === 4
        && second.position.y === 16
        && terminal?.position.x === 8
        && terminal.position.y === 14;
    });
    expect(powerPocket?.rowDeviceOffsets).toEqual([
      { deviceId: "component-b", deltaX: 1, deltaY: 2 },
    ]);

    const fartherRowCandidates = createSameRowTerminalPlacements({
      devices: [
        device("component-a", 0, 14, 3, 3),
        device("component-b", 3, 14, 3, 3),
        device("far-a", 6, 4, 3, 3),
        device("far-b", 9, 4, 3, 3),
        device("far-c", 12, 4, 3, 3),
        device("terminal", 5, 24, 6, 4),
      ],
      terminalDeviceId: "terminal",
      rowDeviceIds: ["far-a", "far-b", "far-c"],
      limitWidth: 24,
      limitHeight: 30,
      allowRotate: true,
    });
    const balancedBeam = selectTerminalRowInterlockBeam({
      candidates: [...candidates, ...fartherRowCandidates].map((candidate) => ({
        ...candidate,
        storageDeviceId: null,
        movedDeviceIds: [candidate.terminalDeviceId, ...candidate.shiftedRowDeviceIds],
      })),
      routedConnections: [],
      maximum: 16,
    });
    expect(balancedBeam.some((candidate) => {
      const second = candidate.devices.find((item) => item.id === "component-b");
      const movedTerminal = candidate.devices.find((item) => item.id === "terminal");
      return candidate.rowDeviceIds.join(",") === "component-a,component-b"
        && candidate.alignment === "top"
        && candidate.rotation === 0
        && second?.position.x === 4
        && second.position.y === 16
        && movedTerminal?.position.x === 8;
    })).toBe(true);
  });

  it("bounds target-port swaps for a five-lane fan-in", () => {
    const connections = [
      {
        id: "long",
        targetDeviceId: "target",
        points: [
          { x: 0, y: 5 }, { x: 0, y: 6 }, { x: 1, y: 6 }, { x: 2, y: 6 },
          { x: 3, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 },
        ],
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `short-${index + 1}`,
        targetDeviceId: "target",
        points: [{ x: index + 5, y: 4 }, { x: index + 5, y: 5 }],
      })),
    ];

    const assignments = createHotspotTargetPortAssignments(connections);

    expect(assignments).toHaveLength(4);
    expect(new Set(assignments.map((assignment) => assignment.get("long")))).toEqual(
      new Set(["5,5", "6,5", "7,5", "8,5"]),
    );
    expect(assignments.every((assignment) =>
      [...assignment.keys()].length === connections.length)).toBe(true);
  });

  it("classifies empty, logistics-occupied, and potential insertion slots deterministically", () => {
    const devices = [device("root", 0, 0), device("blocker", 4, 2)];
    const logistics = [device("belt-cell", 2, 0, 1, 1, "belt")];
    const slots = detectSlots({
      devices,
      logisticsDevices: logistics,
      targetDeviceId: "root",
      limitWidth: 8,
      limitHeight: 6,
      allowRotate: false,
    });

    expect(slots.find((slot) => slot.position.x === 2 && slot.position.y === 0)?.kind)
      .toBe("logistics-occupied");
    expect(slots.find((slot) => slot.position.x === 4 && slot.position.y === 2)).toMatchObject({
      kind: "potential",
      blockingDeviceIds: ["blocker"],
    });
    expect(slots.some((slot) => slot.kind === "empty")).toBe(true);
    expect(detectSlots({
      devices,
      logisticsDevices: logistics,
      targetDeviceId: "root",
      limitWidth: 8,
      limitHeight: 6,
      allowRotate: false,
    })).toEqual(slots);
  });

  it("uses the root's old rectangle to complete a bounded ejection-chain swap", () => {
    const devices = [device("root", 0, 0), device("blocker", 2, 0)];
    const result = searchEjectionChains({
      devices,
      rootDeviceId: "root",
      limitWidth: 6,
      limitHeight: 4,
      allowRotate: true,
      slots: [{
        id: "root:2,0,0",
        kind: "potential",
        position: { x: 2, y: 0 },
        width: 2,
        height: 2,
        rotation: 0,
        blockingDeviceIds: ["blocker"],
        occupiedLogisticsIds: [],
        score: {
          fitWaste: 0,
          portAccessibility: 4,
          proximity: 0,
          boundaryReductionPotential: 0,
          clearanceCost: 4,
        },
      }],
      config: {
        maxDepth: 2,
        beamWidth: 4,
        maxStates: 16,
        maxTranslation: 1,
        timeBudgetMs: 1_000,
      },
    });

    const swapped = result.layouts.find((layout) =>
      layout.find((item) => item.id === "root")?.position.x === 2
      && layout.find((item) => item.id === "blocker")?.position.x === 0);
    expect(swapped?.find((item) => item.id === "root")?.position).toEqual({ x: 2, y: 0 });
    expect(swapped?.find((item) => item.id === "blocker")?.position).toEqual({ x: 0, y: 0 });
    expect(result.exploredStates).toBeLessThanOrEqual(16);
  });

  it("stops ejection-chain exploration at the configured state bound", () => {
    const result = searchEjectionChains({
      devices: [device("root", 0, 0), device("blocker", 2, 0)],
      rootDeviceId: "root",
      limitWidth: 8,
      limitHeight: 8,
      config: {
        maxDepth: 4,
        beamWidth: 8,
        maxStates: 1,
        maxTranslation: 3,
        timeBudgetMs: 1_000,
      },
    });

    expect(result.exploredStates).toBe(1);
    expect(result.stoppedBy).toBe("max-states");
  });

  it("expands moved-device conflicts through footprint buffers and shared route cells", () => {
    const previousDevices = [device("moved", 0, 0), device("fixed", 7, 0)];
    const nextDevices = [device("moved", 4, 0), device("fixed", 7, 0)];
    const conflicts = resolveConflictingConnections({
      connections: [
        { id: "incident", sourceDeviceId: "moved", targetDeviceId: "fixed", points: [{ x: 2, y: 0 }] },
        { id: "footprint", sourceDeviceId: "x", targetDeviceId: "y", points: [{ x: 4, y: 1 }] },
        { id: "crossing", sourceDeviceId: "p", targetDeviceId: "q", points: [{ x: 4, y: 1 }, { x: 4, y: 2 }] },
        { id: "unrelated", sourceDeviceId: "u", targetDeviceId: "v", points: [{ x: 9, y: 5 }] },
      ],
      movedDeviceIds: new Set(["moved"]),
      previousDevices,
      nextDevices,
      buffer: 0,
    });

    expect(conflicts).toEqual(["crossing", "footprint", "incident"]);
  });

  it("progressively expands a failed rip-up set through interacting connections", () => {
    const result = ripUpAndReroute({
      connections: [
        { id: "a", sourceDeviceId: "one", targetDeviceId: "two", points: [{ x: 1, y: 1 }] },
        { id: "b", sourceDeviceId: "two", targetDeviceId: "three", points: [{ x: 2, y: 1 }] },
        { id: "c", sourceDeviceId: "four", targetDeviceId: "five", points: [{ x: 8, y: 8 }] },
      ],
      initialConnectionIds: ["a"],
      config: {
        maxConnections: 3,
        maxAttempts: 3,
        maxCbsDepth: 2,
        maxCbsStates: 8,
        timeBudgetMs: 1_000,
      },
      tryReroute: (ids) => ids.includes("b"),
    });

    expect(result).toEqual({
      status: "success",
      rippedConnectionIds: ["a", "b"],
      preservedConnectionIds: ["c"],
      attempts: 2,
    });
  });

  it("uses bounded CBS to select a deterministic non-conflicting route alternative", () => {
    const candidatesByConnectionId = {
      a: [
        [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }],
        [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 0 }],
      ],
      b: [[{ x: 0, y: 2 }, { x: 1, y: 1 }, { x: 2, y: 2 }]],
    } as const;
    const solved = boundedCbs({
      candidatesByConnectionId,
      config: { maxConnections: 4, maxCbsDepth: 3, maxCbsStates: 8, timeBudgetMs: 1_000 },
    });

    expect(solved.stoppedBy).toBe("solved");
    expect(solved.node?.pathsByConnectionId.a).toEqual(candidatesByConnectionId.a[1]);
    expect(solved.exploredStates).toBeLessThanOrEqual(8);

    const bounded = boundedCbs({
      candidatesByConnectionId,
      config: { maxConnections: 4, maxCbsDepth: 3, maxCbsStates: 1, timeBudgetMs: 1_000 },
    });
    expect(bounded).toMatchObject({ node: null, exploredStates: 1, stoppedBy: "max-states" });
  });

  it("derives independent logistics lanes from full-speed throughput", () => {
    expect(resolveRequiredLogisticsLaneCount(0, "belt")).toBe(0);
    expect(resolveRequiredLogisticsLaneCount(30, "belt")).toBe(1);
    expect(resolveRequiredLogisticsLaneCount(30.0001, "belt")).toBe(2);
    expect(resolveRequiredLogisticsLaneCount(90, "belt")).toBe(3);
  });

  it("discovers bounded storage flow clusters without absorbing single-consumer predecessors", () => {
    const nodes = [
      {
        id: "terminal",
        kind: "storage",
        directProducerIds: ["producer-b", "producer-a"],
        inputItemIds: ["finished"],
        outputItemIds: [],
      },
      {
        id: "producer-a",
        kind: "production",
        inputItemIds: ["shared", "second-hop", "private"],
        outputItemIds: ["finished"],
      },
      {
        id: "producer-b",
        kind: "production",
        inputItemIds: ["shared"],
        outputItemIds: ["finished"],
      },
      {
        id: "shared-upstream",
        kind: "production",
        inputItemIds: ["second-hop"],
        outputItemIds: ["shared"],
      },
      {
        id: "second-hop-upstream",
        kind: "production",
        inputItemIds: [],
        outputItemIds: ["second-hop"],
      },
      {
        id: "private-upstream",
        kind: "production",
        inputItemIds: [],
        outputItemIds: ["private"],
      },
    ] as const;

    const expected = [{
      terminalId: "terminal",
      directProducerIds: ["producer-a", "producer-b"],
      sharedUpstreamIds: ["second-hop-upstream", "shared-upstream"],
      allDeviceIds: [
        "producer-a",
        "producer-b",
        "second-hop-upstream",
        "shared-upstream",
        "terminal",
      ],
    }];
    expect(discoverFlowClusters(nodes)).toEqual(expected);
    expect(discoverFlowClusters([...nodes].reverse())).toEqual(expected);
  });

  it("translates a terminal flow cluster rigidly and rejects collisions", () => {
    const devices = [
      device("producer-a", 1, 6),
      device("producer-b", 3, 6),
      device("terminal", 2, 9),
      device("upstream", 0, 2),
    ];
    const movedIds = new Set(["producer-a", "producer-b", "terminal"]);
    expect(translateRigidDeviceCluster({
      devices,
      deviceIds: movedIds,
      deltaX: 0,
      deltaY: -2,
      limitWidth: 12,
      limitHeight: 12,
    })?.map((item) => [item.id, item.position])).toEqual([
      ["producer-a", { x: 1, y: 4 }],
      ["producer-b", { x: 3, y: 4 }],
      ["terminal", { x: 2, y: 7 }],
      ["upstream", { x: 0, y: 2 }],
    ]);
    expect(translateRigidDeviceCluster({
      devices,
      deviceIds: movedIds,
      deltaX: 0,
      deltaY: -3,
      limitWidth: 12,
      limitHeight: 12,
    })).toBeNull();
  });

  it("creates a deterministic, non-overlapping blueprint inside the requested range", () => {
    const request = {
      width: 32,
      height: 32,
      name: "iron nugget compact line",
      targets: [{ itemId: "item_iron_nugget", perMinute: 60 }],
      search: { iterations: 0, routingVariants: 3, seed: 42 },
    } as const;
    const first = optimizeHeadlessLayout(request, createRegistryContract());
    const second = optimizeHeadlessLayout(request, createRegistryContract());

    expect(first.blueprint.blueprintId).toBe(second.blueprint.blueprintId);
    expect(first.blueprint.entities).toEqual(second.blueprint.entities);
    expect(first.layout).toEqual(second.layout);
    expect(normalizeBlueprintDocument(first.blueprint)).not.toBeNull();
    expect(first.production.unresolvedPerMinute).toBe(0);
    expect(first.validation.errorCount).toBe(0);
    expect(first.validation.productionConnectivityVerified).toBe(true);
    expect(first.optimality.boundingArea.strictRoutedUpperBoundVerified).toBe(true);
    expect(first.optimality.boundingArea.upperBound).toBe(first.layout.boundingArea);
    expect(first.optimality.boundingArea.lowerBound).toBeLessThanOrEqual(first.layout.boundingArea);
    expect(["bounded", "bounding-area-optimal"]).toContain(
      first.optimality.boundingArea.status,
    );
    expect(first.optimality.boundingArea.proof.constraintProfile).toBe(
      "certified-area-relaxation-v3a",
    );
    expect(first.layout.beltCellCount).toBeGreaterThan(0);
    expect(first.layout.pipeCellCount).toBe(0);
    expect(first.layout.usedWidth).toBeLessThanOrEqual(request.width);
    expect(first.layout.usedHeight).toBeLessThanOrEqual(request.height);
    expectNoOverlaps(first.layout.devices);
    const logisticsEntities = Object.values(first.blueprint.entities)
      .filter((entity) => entity.tags.some((tag) => tag.startsWith("logistics:")));
    expect(logisticsEntities.length).toBeGreaterThan(0);
    expect(logisticsEntities.every((entity) =>
      entity.tags.some((tag) => tag.startsWith("connection:")))).toBe(true);
    expect(first.search).toEqual(second.search);
    expect(first.search.effectiveRoutingVariants).toBe(3);
    expect(first.search.adaptiveCandidatesEvaluated).toBe(0);
    expect(first.search.adaptiveRoutingAttempts).toBe(0);
    expect(first.search.initialLayout).toBe("auto");
    expect(first.search.scope).toBe("global");
    expect(first.search.globalNeighborhoods).toBe("all");
  }, 30_000);

  it("reports topology-sequential local search without global candidates", () => {
    const result = optimizeHeadlessLayout({
      width: 32,
      height: 32,
      targets: [{ itemId: "item_iron_nugget", perMinute: 60 }],
      search: {
        initialLayout: "topology-sequential",
        scope: "local",
        iterations: 0,
        routingVariants: 1,
        refinementCandidates: 1,
        cpSat: { enabled: false },
        seed: 42,
      },
    }, createRegistryContract());

    expect(result.search.initialLayout).toBe("topology-sequential");
    expect(result.search.scope).toBe("local");
    expect(result.search.globalNeighborhoods).toBe("all");
    expect(result.search.initialCandidatesGenerated).toBeGreaterThanOrEqual(
      result.search.initialCandidatesSelected,
    );
    expect(result.search.initialCandidatesSelected).toBe(1);
    expect(result.search.globalRebuildCandidatesGenerated).toBe(0);
    expect(result.search.partialRebuildCandidatesGenerated).toBe(0);
    expect(result.search.globalLayerInterlockCandidatesGenerated).toBe(0);
    expect(result.search.globalLayerInterlockPasses).toBe(0);
    expect(result.search.globalLayerInterlockStoppedBy).toBe("disabled");
    expect(result.search.cpSatCandidates).toBe(0);
    expect(result.search.localConvergencePasses).toBe(0);
    expect(result.search.localConvergenceStoppedBy).toBe("disabled");
    expect(result.validation.productionConnectivityVerified).toBe(true);
  }, 30_000);

  it("closes the bounded local neighborhood at a strict fixed point", () => {
    const result = optimizeHeadlessLayout({
      width: 32,
      height: 32,
      targets: [{ itemId: "item_iron_nugget", perMinute: 60 }],
      search: {
        initialLayout: "topology-sequential",
        scope: "local",
        iterations: 1,
        routingVariants: 1,
        refinementCandidates: 1,
        cpSat: { enabled: false },
        seed: 42,
      },
    }, createRegistryContract());

    expect(result.search.localConvergencePasses).toBeGreaterThan(0);
    expect(result.search.localConvergenceStoppedBy).toBe("fixed-point");
    expect(result.search.globalLayerInterlockCandidatesGenerated).toBe(0);
    expect(result.search.globalLayerInterlockPasses).toBe(0);
    expect(result.search.globalLayerInterlockStoppedBy).toBe("disabled");
    expect(result.validation.productionConnectivityVerified).toBe(true);
    expect(result.layout.frontageOverflowCellCount).toBe(0);
  }, 30_000);

  it("validates the routed refinement candidate budget", () => {
    expect(() => optimizeHeadlessLayout({
      width: 24,
      height: 24,
      targets: [{ itemId: "item_iron_nugget", perMinute: 30 }],
      search: { refinementCandidates: 0 },
    }, createRegistryContract())).toThrow(/refinementCandidates/);
  });

  it("derives generic SCC layers and balances anonymous cyclic recipes", () => {
    const components = buildTopologyComponents(
      ["input-a", "cycle-a", "cycle-b", "merge", "storage"],
      [
        { sourceId: "input-a", targetId: "merge" },
        { sourceId: "cycle-a", targetId: "cycle-b" },
        { sourceId: "cycle-b", targetId: "cycle-a" },
        { sourceId: "cycle-b", targetId: "merge" },
        { sourceId: "merge", targetId: "storage" },
      ],
    );
    const componentByDevice = new Map(components.flatMap((component) =>
      component.deviceIds.map((deviceId) => [deviceId, component] as const)));
    expect(componentByDevice.get("cycle-a")).toBe(componentByDevice.get("cycle-b"));
    expect(componentByDevice.get("merge")?.layer).toBe(1);
    expect(componentByDevice.get("storage")?.layer).toBe(2);
    expect(solveCyclicRecipeCounts(
      [
        [30, -10],
        [-10, 20],
      ],
      [50, 0],
    )).toEqual([2, 1]);
  });

  it("contracts only an exclusive continuing branch into its feedback component", () => {
    const edges = [
      { sourceId: "return", targetId: "hub" },
      { sourceId: "hub", targetId: "return" },
      { sourceId: "hub", targetId: "output" },
      { sourceId: "output", targetId: "crusher" },
      { sourceId: "source", targetId: "shared" },
      { sourceId: "hub", targetId: "shared" },
      { sourceId: "shared", targetId: "terminal" },
    ];
    const merged = mergeExclusiveFeedbackBranches({
      components: buildTopologyComponents(
        ["return", "hub", "output", "crusher", "source", "shared", "terminal"],
        edges,
      ),
      edges,
    });
    const componentByDevice = new Map(merged.flatMap((component) =>
      component.deviceIds.map((deviceId) => [deviceId, component] as const)));

    expect(componentByDevice.get("output")?.deviceIds).toEqual(["hub", "output", "return"]);
    expect(componentByDevice.get("shared")?.deviceIds).toEqual(["shared"]);
    expect(componentByDevice.get("crusher")?.deviceIds).toEqual(["crusher"]);
  });

  it("enumerates ambiguous feedback folds and packs arbitrary return shelves", () => {
    expect(identifyFoldableFeedbackCycle({
      deviceIds: ["hub", "output", "return"],
      internalEdges: [
        { sourceId: "hub", targetId: "output" },
        { sourceId: "hub", targetId: "return" },
        { sourceId: "return", targetId: "hub" },
      ],
      externalOutgoingEdges: [{ sourceId: "output", laneCount: 1 }],
    })).toEqual({
      fanoutHubId: "hub",
      externalExitId: "output",
      returnMemberIds: ["return"],
    });

    expect(enumerateFoldableFeedbackCycles({
      deviceIds: ["hub", "exit-a", "exit-b"],
      internalEdges: [
        { sourceId: "hub", targetId: "exit-a" },
        { sourceId: "hub", targetId: "exit-b" },
        { sourceId: "exit-a", targetId: "hub" },
        { sourceId: "exit-b", targetId: "hub" },
      ],
      externalOutgoingEdges: [
        { sourceId: "exit-a", laneCount: 1 },
        { sourceId: "exit-b", laneCount: 1 },
      ],
    })).toHaveLength(2);
    expect(packFoldedFeedbackShelves({
      fanoutHub: { id: "hub", width: 5, height: 5 },
      returnMembers: [
        { id: "return-a", width: 4, height: 4 },
        { id: "return-b", width: 4, height: 4 },
        { id: "return-c", width: 4, height: 4 },
      ],
      frontageWidth: 12,
    })).toEqual({
      height: 10,
      placements: [
        { id: "hub", x: 0, y: 0 },
        { id: "return-a", x: 8, y: 0 },
        { id: "return-b", x: 8, y: 6 },
        { id: "return-c", x: 3, y: 6 },
      ],
    });
    expect(enumerateFoldedFeedbackShelfPlans({
      fanoutHub: { id: "hub", width: 5, height: 5 },
      returnMembers: [{ id: "return", width: 5, height: 5 }],
      frontageWidth: 18,
    })).toEqual([
      {
        height: 5,
        placements: [
          { id: "hub", x: 3, y: 0 },
          { id: "return", x: 10, y: 0 },
        ],
      },
      {
        height: 5,
        placements: [
          { id: "hub", x: 0, y: 0 },
          { id: "return", x: 13, y: 0 },
        ],
      },
    ]);
  });

  it("measures width from unloaders while keeping origin-anchored height", () => {
    expect(measureFactoryFootprintBounds([
      device("warehouse-base", 0, 0, 24, 6, "warehouse-bus"),
      ...Array.from({ length: 6 }, (_, index) =>
        device(`unloader-${index}`, index * 3, 6, 3, 3, "warehouse-port")),
      device("production", 0, 10, 6, 5),
    ])).toEqual({ width: 18, height: 15 });
  });

  it("exports a coordinate-free instance material graph", () => {
    const graph = buildHeadlessMaterialGraph({
      width: 32,
      height: 32,
      targets: [{ itemId: "item_iron_nugget", perMinute: 60 }],
      search: { iterations: 0, routingVariants: 1, seed: 42 },
    }, createRegistryContract());
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.nodes.every((node) => !("position" in node))).toBe(true);
    expect(graph.edges.every((edge) => {
      const source = nodesById.get(edge.sourceId);
      const target = nodesById.get(edge.targetId);
      return source !== undefined
        && target !== undefined
        && (source.componentId === target.componentId || source.layer < target.layer);
    })).toBe(true);
  });

  it("materializes a requested minimum recipe count without changing total flow", () => {
    const graph = buildHeadlessMaterialGraph({
      width: 32,
      height: 32,
      targets: [{ itemId: "item_plant_moss_powder_3", perMinute: 150 }],
      supplies: [{ itemId: "item_plant_moss_3", perMinute: 50, infinite: true }],
      recipeChoices: {
        item_plant_moss_powder_3: "r_crusher_moss_powder_from_moss_basic",
      },
      minimumRecipeDeviceCounts: {
        r_crusher_moss_powder_from_moss_basic: 5,
      },
      search: { iterations: 0, routingVariants: 1, seed: 42 },
    }, createRegistryContract());

    expect(graph.nodes.filter((node) =>
      node.recipeId === "r_crusher_moss_powder_from_moss_basic")).toHaveLength(5);
    expect(graph.nodes.filter((node) =>
      node.kind === "warehouse-port" && node.outputItemIds.includes("item_plant_moss_3")))
      .toHaveLength(5);
    expect(graph.edges.filter((edge) => edge.itemId === "item_plant_moss_3")).toHaveLength(5);
    expect(graph.edges.filter((edge) => edge.itemId === "item_plant_moss_powder_3")).toHaveLength(5);
  });

  it("pairs cyclic recipe instances before assigning each cycle's exit branch", () => {
    const graph = buildHeadlessMaterialGraph({
      width: 32,
      height: 64,
      targets: [{ itemId: "item_plant_moss_powder_3", perMinute: 150 }],
      recipeChoices: {
        item_plant_moss_powder_3: "r_crusher_moss_powder_from_moss_basic",
        item_plant_moss_3: "r_planter_moss_from_moss_seed_basic",
        item_plant_moss_seed_3: "r_seedcol_moss_seed_from_moss_basic",
      },
      allowRecipeOutputWaste: ["r_crusher_moss_powder_from_moss_basic"],
      search: { iterations: 0, routingVariants: 1, seed: 42 },
    }, createRegistryContract());
    const recipeIdByNodeId = new Map(graph.nodes.map((node) => [node.id, node.recipeId]));
    const collectors = graph.nodes.filter((node) =>
      node.recipeId === "r_seedcol_moss_seed_from_moss_basic");

    expect(graph.nodes.filter((node) =>
      node.recipeId === "r_planter_moss_from_moss_seed_basic")).toHaveLength(4);
    expect(collectors).toHaveLength(2);
    expect(graph.nodes.filter((node) =>
      node.recipeId === "r_crusher_moss_powder_from_moss_basic")).toHaveLength(2);
    expect(graph.nodes.filter((node) =>
      node.kind === "warehouse-port" && node.outputItemIds.includes("item_plant_moss_3")))
      .toHaveLength(0);

    for (const collector of collectors) {
      const seededPlanterIds = graph.edges
        .filter((edge) => edge.sourceId === collector.id
          && edge.itemId === "item_plant_moss_seed_3")
        .map((edge) => edge.targetId);
      const recyclingPlanterIds = seededPlanterIds.filter((planterId) =>
        graph.edges.some((edge) => edge.sourceId === planterId
          && edge.targetId === collector.id
          && edge.itemId === "item_plant_moss_3"));
      const outputPlanterIds = seededPlanterIds.filter((planterId) =>
        graph.edges.some((edge) => edge.sourceId === planterId
          && edge.itemId === "item_plant_moss_3"
          && recipeIdByNodeId.get(edge.targetId) === "r_crusher_moss_powder_from_moss_basic"));
      expect(seededPlanterIds).toHaveLength(2);
      expect(recyclingPlanterIds).toHaveLength(1);
      expect(outputPlanterIds).toHaveLength(1);
    }
  });

  it("bounds adaptive route variants without repeating the fast path", () => {
    expect(selectUnattemptedRoutingVariants(
      [3, 4, 5, 6, 7],
      new Set([0, 4]),
      2,
    )).toEqual([3, 5]);
    expect(selectUnattemptedRoutingVariants([0, 1, 2], new Set([0]))).toEqual([1, 2]);
  });

  it("shares one refinement round budget across elite layout bases", () => {
    expect(allocateRefinementCandidateBudgets(12, 3)).toEqual([6, 3, 3]);
    expect(allocateRefinementCandidateBudgets(5, 3)).toEqual([3, 1, 1]);
    expect(allocateRefinementCandidateBudgets(2, 3)).toEqual([1, 1]);
    expect(allocateRefinementCandidateBudgets(4, 1)).toEqual([4]);
    expect(allocateRefinementCandidateBudgets(0, 3)).toEqual([]);
  });

  it("reserves elite archive capacity for both quality and layout novelty", () => {
    const distances = [
      [0, 1, 2, 8, 7],
      [1, 0, 2, 7, 6],
      [2, 2, 0, 5, 5],
      [8, 7, 5, 0, 2],
      [7, 6, 5, 2, 0],
    ];
    expect(selectQualityDiverseIndexes(distances, 3)).toEqual([0, 1, 3]);
    expect(selectQualityDiverseIndexes(distances, 4)).toEqual([0, 1, 3, 2]);
    expect(selectQualityDiverseIndexes(distances, 0)).toEqual([]);
  });

  it("attributes bounds, enclosed voids, and routed-path cost to movable hotspots", () => {
    const boundaryHotspots = rankObjectiveHotspots({
      devices: [
        device("left", 0, 0),
        device("middle", 2, 0),
        device("right-boundary", 7, 0),
      ],
      connections: [{
        sourceDeviceId: "right-boundary",
        targetDeviceId: "left",
        points: [
          { x: 7, y: 1 },
          { x: 6, y: 1 },
          { x: 5, y: 1 },
          { x: 5, y: 2 },
          { x: 5, y: 3 },
        ],
      }],
    });
    expect(boundaryHotspots[0]).toMatchObject({
      deviceId: "right-boundary",
      boundingAreaReduction: 10,
      routeCost: 9,
    });

    const voidHotspots = rankObjectiveHotspots({
      devices: [
        device("top", 1, 0, 1, 1),
        device("bottom", 1, 2, 1, 1),
        device("left", 0, 1, 1, 1),
        device("right", 2, 1, 1, 1),
      ],
      connections: [],
    });
    expect(voidHotspots.every((hotspot) => hotspot.enclosedVoidAdjacency === 1)).toBe(true);
  });

  it("keeps an objective hotspot with its downstream terminal during partial rebuild", () => {
    const devices = [
      device("upstream", 0, 0),
      device("hotspot", 7, 0),
      device("terminal", 2, 0, 2, 2, "storage"),
    ];
    expect(selectObjectivePartialDestroyIds({
      devices,
      routedConnections: [],
      flowEdges: [
        {
          sourceId: "upstream",
          targetId: "hotspot",
          itemId: "input",
          laneCount: 1,
          weight: 10,
          sourceEdges: {},
          targetEdges: {},
        },
        {
          sourceId: "hotspot",
          targetId: "terminal",
          itemId: "output",
          laneCount: 1,
          weight: 10,
          sourceEdges: {},
          targetEdges: {},
        },
      ],
      maximum: 2,
    })).toEqual(["hotspot", "terminal"]);
  });

  it("turns a certified placement conflict into a focused pose no-good cut", () => {
    const producer = device("producer", 1, 2);
    const blocker = device("blocker", 5, 6, 2, 2, "storage");
    expect(createRouteFailurePoseCut({
      devices: [
        producer,
        blocker,
        device("warehouse", 0, 0, 1, 3, "warehouse-port"),
        device("belt", 4, 4, 1, 1, "belt"),
      ],
      usedWidth: 8,
      usedHeight: 9,
      equipmentArea: 8,
    }, {
      itemId: "item",
      sourceDeviceId: "producer",
      targetDeviceId: "warehouse",
      kind: "belt",
      attemptedPortPairs: [],
      reachableCells: [],
      frontierBlockers: [
        { x: 4, y: 6, ownerDeviceId: "blocker", ownerKind: "production" },
        { x: 4, y: 4, ownerDeviceId: "belt", ownerKind: "logistics" },
      ],
      capacityConflict: null,
      placementConflict: {
        proof: "static-free-space-separator",
        sourceIsBoundary: false,
        targetIsBoundary: false,
        sourceEndpointCount: 1,
        targetEndpointCount: 1,
        reachableCellCount: 12,
        separatorCellCount: 3,
        poseDeviceIds: ["blocker", "producer"],
      },
    })).toEqual([
      {
        id: "blocker",
        x: 5,
        y: 6,
        rotation: 0,
        width: 2,
        height: 2,
      },
      {
        id: "producer",
        x: 1,
        y: 2,
        rotation: 0,
        width: 2,
        height: 2,
      },
    ]);
  });

  it("turns a certified cut-capacity conflict into a focused pose no-good cut", () => {
    const producer = device("producer", 1, 2);
    const blocker = device("blocker", 5, 6, 2, 2, "storage");
    const packing = {
      devices: [producer, blocker],
      usedWidth: 8,
      usedHeight: 9,
      equipmentArea: 8,
    };
    const evidence = {
      itemId: "item",
      sourceDeviceId: "producer",
      targetDeviceId: "blocker",
      kind: "belt",
      attemptedPortPairs: [],
      reachableCells: [],
      frontierBlockers: [],
      placementConflict: null,
      capacityConflict: {
        proof: "static-cut-capacity",
        axis: "vertical",
        coordinate: 4,
        gridWidth: 8,
        gridHeight: 9,
        demand: 3,
        capacity: 2,
        deficit: 1,
        crossingLaneIds: ["lane-a", "lane-b", "lane-c"],
        endpointPoseDeviceIds: ["producer"],
        blockingPoseDeviceIds: ["blocker"],
        fixedBlockedOffsets: [],
        poseDeviceIds: ["blocker", "producer"],
      },
    } as const;
    expect(createRouteFailurePoseCut(packing, evidence)).toEqual([
      { id: "blocker", x: 5, y: 6, rotation: 0, width: 2, height: 2 },
      { id: "producer", x: 1, y: 2, rotation: 0, width: 2, height: 2 },
    ]);
    expect(createRouteFailureCapacityCut(packing, evidence)).toEqual({
      axis: "vertical",
      coordinate: 4,
      gridWidth: 8,
      gridHeight: 9,
      requiredCapacity: 3,
      cutEdges: Array.from({ length: 9 }, (_, y) => ({
        from: { x: 3, y },
        to: { x: 4, y },
      })),
      fixedBlockedEdgeIndexes: [],
      activeWhenPlacements: [
        { id: "producer", x: 1, y: 2, rotation: 0, width: 2, height: 2 },
      ],
    });
  });

  it("preserves an arbitrary certified grid edge cut for CP-SAT", () => {
    const producer = device("producer", 1, 2);
    const packing = {
      devices: [producer],
      usedWidth: 8,
      usedHeight: 9,
      equipmentArea: 4,
    };
    const cutEdges = [
      { from: { x: 2, y: 2 }, to: { x: 2, y: 3 } },
      { from: { x: 1, y: 3 }, to: { x: 2, y: 3 } },
      { from: { x: 2, y: 3 }, to: { x: 3, y: 3 } },
    ] as const;
    const evidence = {
      itemId: "item",
      sourceDeviceId: "producer",
      targetDeviceId: "fixed-target",
      kind: "belt",
      attemptedPortPairs: [],
      reachableCells: [],
      frontierBlockers: [],
      placementConflict: null,
      capacityConflict: {
        proof: "static-general-cut-capacity",
        axis: "general",
        coordinate: null,
        gridWidth: 8,
        gridHeight: 9,
        demand: 2,
        capacity: 1,
        deficit: 1,
        crossingLaneIds: ["lane-a", "lane-b"],
        endpointPoseDeviceIds: ["producer"],
        blockingPoseDeviceIds: [],
        cutEdges,
        fixedBlockedEdgeIndexes: [0],
        poseDeviceIds: ["producer"],
      },
    } as const;

    expect(createRouteFailureCapacityCut(packing, evidence)).toEqual({
      axis: "general",
      coordinate: null,
      gridWidth: 8,
      gridHeight: 9,
      requiredCapacity: 2,
      cutEdges,
      fixedBlockedEdgeIndexes: [0],
      activeWhenPlacements: [
        { id: "producer", x: 1, y: 2, rotation: 0, width: 2, height: 2 },
      ],
    });
  });

  it("keeps heuristic route frontiers out of CP-SAT hard cuts", () => {
    const producer = device("producer", 1, 2);
    const blocker = device("blocker", 5, 6, 2, 2, "storage");
    expect(createRouteFailurePoseCut({
      devices: [producer, blocker],
      usedWidth: 8,
      usedHeight: 9,
      equipmentArea: 8,
    }, {
      itemId: "item",
      sourceDeviceId: "producer",
      targetDeviceId: "blocker",
      kind: "belt",
      attemptedPortPairs: [],
      reachableCells: [],
      frontierBlockers: [
        { x: 4, y: 6, ownerDeviceId: "blocker", ownerKind: "production" },
      ],
      placementConflict: null,
      capacityConflict: null,
    })).toEqual([]);
  });

  it("measures strict unloader frontage while excluding the fixed warehouse bus", () => {
    expect(measureFrontageOverflowCells([
      device("unloader-a", 10, 0, 1, 3, "warehouse-port"),
      device("unloader-b", 10, 3, 1, 3, "warehouse-port"),
      device("inside", 2, 1, 2, 2),
      device("overflow", 2, 5, 2, 2),
      device("fixed-bus", 11, 6, 4, 8, "warehouse-bus"),
    ])).toBe(2);
  });

  it("validates the warehouse frontage constraint mode", () => {
    expect(() => optimizeHeadlessLayout({
      width: 24,
      height: 24,
      targets: [{ itemId: "item_iron_nugget", perMinute: 30 }],
      frontageConstraint: "strict" as "hard",
    }, createRegistryContract())).toThrow(/frontageConstraint/);
  });

  it("validates the independent bounding-area proof budget", () => {
    expect(() => optimizeHeadlessLayout({
      width: 24,
      height: 24,
      targets: [{ itemId: "item_iron_nugget", perMinute: 30 }],
      certification: { boundingArea: { maxSeconds: 0 } },
    }, createRegistryContract())).toThrow(/certification\.boundingArea\.maxSeconds/);
  });

  it("routes internal production flow before boundary belts", () => {
    const registry = createRegistryContract();
    const result = optimizeHeadlessLayout({
      width: 32,
      height: 32,
      targets: [{ itemId: "item_iron_cmpt", perMinute: 10 }],
      search: { iterations: 0, routingVariants: 1 },
    }, registry);

    expect(result.validation.internalConnectionCount).toBeGreaterThan(0);
    expect(result.validation.boundaryConnectionCount).toBe(0);
    expect(result.layout.storageDeviceCount).toBeGreaterThan(0);
    expect(result.layout.warehousePortCount).toBeGreaterThan(0);
    expect(result.layout.warehouseBusCount).toBeGreaterThan(0);
    expect(Object.values(result.blueprint.entities).some((entity) =>
      entity.definitionId === "item_port_loader_1")).toBe(false);
    expect(result.blueprint.slotLinks.some((link) => link.target.entityId === "warehouse")).toBe(true);
    expect(result.layout.areaExcludedBeltCellCount).toBeGreaterThan(0);
    expect(result.layout.storageDeviceCount).toBe(1);
    expect(result.layout.powerDeviceCount).toBeGreaterThan(0);
    expect(result.layout.minimumPowerDeviceCount).toBe(result.layout.powerDeviceCount);
    expect(result.layout.equipmentArea).toBe(
      result.layout.devices
        .filter((device) => device.kind !== "warehouse-bus")
        .reduce(
          (area, device) => area + device.width * device.height,
          0,
        ) - result.layout.areaExcludedBeltCellCount,
    );
    expect(result.layout.physicalBoundingArea).toBeGreaterThanOrEqual(result.layout.boundingArea);
    expect(result.validation.productionConnectivityVerified).toBe(true);
    expect(result.validation.productionThroughputVerified).toBe(true);
    expect(result.validation.powerCoverageVerified).toBe(true);
    const storage = result.layout.devices.find((device) => device.kind === "storage");
    const powerDefinition = registry.entityDefinitions.find((definition) =>
      definition.id === "item_port_power_diffuser_1");
    expect(storage).toBeDefined();
    expect(powerDefinition).toBeDefined();
    expect(result.layout.devices.filter((device) => device.kind === "power").some((device) => {
      const entity = result.blueprint.entities[device.id];
      if (entity === undefined || storage === undefined || powerDefinition === undefined) return false;
      const range = resolvePowerRangeGridRect({ entity, definition: powerDefinition });
      return range !== null && areGridRectsIntersecting(range, {
        x: storage.position.x,
        y: storage.position.y,
        width: storage.width,
        height: storage.height,
      });
    })).toBe(true);
    expect(result.layout.beltCellCount).toBeGreaterThan(0);
    expectNoOverlaps(result.layout.devices);
  });

  it("uses pipes for fluid outputs and belts for solid inputs", () => {
    const result = optimizeHeadlessLayout({
      width: 32,
      height: 32,
      targets: [{ itemId: "item_liquid_xiranite", perMinute: 5 }],
      supplies: [{
        itemId: "item_iron_bottle_filled_liquid_xiranite",
        perMinute: 5,
        infinite: true,
      }],
      recipeChoices: {
        item_liquid_xiranite: "r_liquid_dismantling_iron_bottle_xiranite_default",
      },
      search: { iterations: 0, routingVariants: 1 },
    }, createRegistryContract());

    expect(result.layout.beltCellCount).toBeGreaterThan(0);
    expect(result.layout.pipeCellCount).toBeGreaterThan(0);
    expect(result.validation.productionConnectivityVerified).toBe(true);
    expect(result.validation.productionThroughputVerified).toBe(true);
    expect(result.validation.errorCount).toBe(0);
    expectNoOverlaps(result.layout.devices);
  });

  it("renders the routed blueprint as a standalone SVG", () => {
    const registry = createRegistryContract();
    const result = optimizeHeadlessLayout({
      width: 24,
      height: 24,
      targets: [{ itemId: "item_iron_cmpt", perMinute: 10 }],
      search: { iterations: 0, routingVariants: 1 },
    }, registry);
    const svg = renderBlueprintSvg(result.blueprint, registry);

    expect(svg).toContain("<svg");
    expect(svg).toContain(">Belt<");
    expect(svg).toContain(">Power range<");
    expect(svg).toContain("data-layer=\"power-ranges\"");
    expect(svg).toContain("data-power-source=\"power-diffuser-");
    expect(svg).toContain("· 12×12");
    expect(svg).toContain("marker-end=\"url(#arrow-belt)\"");
    expect(svg).toContain("opt-");
    expect(renderBlueprintSvg(result.blueprint, registry, { showPowerRanges: false }))
      .not.toContain("data-power-source=");
  });

  it("never regresses the baseline objective when the search budget increases", () => {
    const registry = createRegistryContract();
    const baseRequest = {
      width: 24,
      height: 24,
      targets: [{ itemId: "item_iron_cmpt", perMinute: 10 }],
    } as const;
    const baseline = optimizeHeadlessLayout({
      ...baseRequest,
      search: { iterations: 0, routingVariants: 1, seed: 12345 },
    }, registry);
    const searched = optimizeHeadlessLayout({
      ...baseRequest,
      search: { iterations: 32, routingVariants: 3, seed: 12345 },
    }, registry);

    expect(compareObjectiveVectors(
      searched.search.objective.vector,
      baseline.search.objective.vector,
    )).toBeLessThanOrEqual(0);
    expect(searched.search.packingCandidates).toBeGreaterThanOrEqual(baseline.search.packingCandidates);
    expect(searched.search.eliteStatesRetained).toBeGreaterThan(1);
    expect(searched.search.eliteArchiveMaxDistance).toBeGreaterThan(0);
    expect(searched.search.alternativeRefinementBasesUsed).toBeGreaterThan(0);
    expect(searched.search.globalRebuildCandidatesGenerated).toBe(0);
    expect(searched.search.partialRebuildCandidatesGenerated).toBe(0);
    expect(searched.search.objectiveHotspotDeviceIds).toEqual([]);
    expect(searched.validation.productionConnectivityVerified).toBe(true);
  }, 30_000);

  it("routes a full-speed triple dense originium powder line without wasting moss powder", () => {
    const result = optimizeHeadlessLayout({
      width: 26,
      height: 28,
      routingClearance: 1,
      targets: [{ itemId: "item_originium_enr_powder", perMinute: 90 }],
      recipeChoices: {
        item_originium_enr_powder: "r_thickener_originium_enr_powder_from_originium_and_moss_powder_basic",
      },
      search: {
        iterations: 0,
        routingVariants: 1,
        refinementCandidates: 4,
        cpSat: { enabled: false },
        seed: 20260718,
      },
    }, createRegistryContract());

    const connectors = Object.values(result.blueprint.entities)
      .filter((entity) => entity.definitionId === "item_log_connector");
    expect(connectors.length).toBeGreaterThan(0);
    const densePowderMachines = result.layout.devices.filter((device) =>
      device.kind === "production"
      && device.recipeId === "r_thickener_originium_enr_powder_from_originium_and_moss_powder_basic");
    const mossGrinders = result.layout.devices.filter((device) =>
      device.kind === "production"
      && device.recipeId === "r_crusher_moss_powder_from_moss_basic");
    const mossPlanters = result.layout.devices.filter((device) =>
      device.kind === "production"
      && device.recipeId === "r_planter_moss_from_moss_seed_basic");
    const mossSeedCollectors = result.layout.devices.filter((device) =>
      device.kind === "production"
      && device.recipeId === "r_seedcol_moss_seed_from_moss_basic");
    expect(densePowderMachines).toHaveLength(3);
    expect(mossGrinders).toHaveLength(1);
    expect(mossPlanters).toHaveLength(2);
    expect(mossSeedCollectors).toHaveLength(1);
    const mossPowderConnections = result.validation.materialConnections.filter((connection) =>
      connection.itemId === "item_plant_moss_powder_3"
      && connection.sourceDeviceId === mossGrinders[0]!.id
      && connection.targetDeviceId !== null);
    expect(mossPowderConnections).toHaveLength(3);
    expect(new Set(mossPowderConnections.map((connection) => connection.targetDeviceId)).size).toBe(3);
    expect(mossPowderConnections.reduce((sum, connection) => sum + connection.perMinute, 0)).toBe(90);
    expect(mossPowderConnections.every((connection) => connection.perMinute <= 30)).toBe(true);
    const mossInputConnections = result.validation.materialConnections.filter((connection) =>
      connection.itemId === "item_plant_moss_3"
      && connection.targetDeviceId === mossGrinders[0]!.id);
    expect(mossInputConnections).toHaveLength(1);
    expect(mossInputConnections[0]!.perMinute).toBe(30);
    expect(new Set(mossInputConnections.map((connection) => connection.sourceDeviceId)).size).toBe(1);
    const originiumOreUnloaders = Object.values(result.blueprint.entities).filter((entity) =>
      entity.definitionId === "item_port_unloader_1"
      && entity.tags.includes("item:item_originium_ore"));
    const originiumPowderUnloaders = Object.values(result.blueprint.entities).filter((entity) =>
      entity.definitionId === "item_port_unloader_1"
      && entity.tags.includes("item:item_originium_powder"));
    expect(originiumOreUnloaders).toHaveLength(6);
    expect(originiumPowderUnloaders).toHaveLength(0);
    const oreGrinders = result.layout.devices
      .filter((device) => device.kind === "production"
        && device.recipeId === "r_crusher_originium_powder_basic")
      .sort((left, right) => left.position.x - right.position.x);
    expect(oreGrinders).toHaveLength(6);
    expect(result.layout.usedWidth).toBeLessThanOrEqual(26);
    expect(result.layout.usedHeight).toBeLessThanOrEqual(28);
    expect(result.layout.boundingArea).toBeLessThanOrEqual(728);
    expect(result.layout.contourArea).toBeLessThanOrEqual(622.5);
    expect(result.layout.contourArea).toBeLessThanOrEqual(result.layout.boundingArea);
    expect(result.layout.enclosedVoidCellCount).toBeLessThanOrEqual(58);
    expect(result.layout.boundingVoidCellCount).toBeLessThanOrEqual(296);
    expect(result.layout.frontageOverflowCellCount).toBeLessThanOrEqual(25);
    expect(result.layout.pipeCellCount).toBe(0);
    expect(result.layout.areaExcludedBeltCellCount).toBeGreaterThan(0);
    expect(result.layout.storageDeviceCount).toBe(1);
    expect(result.layout.powerDeviceCount).toBe(4);
    expect(result.layout.minimumPowerDeviceCount).toBe(result.layout.powerDeviceCount);
    expect(result.search.initialCandidatesGenerated).toBeGreaterThan(
      result.search.initialCandidatesSelected,
    );
    expect(result.search.initialCandidatesSelected).toBe(4);
    expect(result.search.adaptiveCandidatesEvaluated).toBe(8);
    expect(result.search.effectiveRoutingVariants).toBe(3);
    expect(result.search.adaptiveRoutingAttempts).toBeGreaterThanOrEqual(2);
    expect(result.search.warehouseCandidatesSelected).toBeGreaterThan(0);
    expect(result.search.warehouseCandidatesSelected).toBeLessThanOrEqual(
      result.search.initialCandidatesSelected,
    );
    expect(result.search.packingCandidates).toBe(12);
    expect(result.search.clusterCandidatesRouted).toBeGreaterThanOrEqual(1);
    expect(result.search.clusterCandidatesImproved).toBeGreaterThanOrEqual(1);
    expect(result.validation.productionConnectivityVerified).toBe(true);
    expect(result.validation.productionThroughputVerified).toBe(true);
    expect(result.validation.powerCoverageVerified).toBe(true);
    expect(result.validation.errorCount).toBe(0);
    expectNoOverlaps(result.layout.devices);
  }, 420_000);

  it("fails clearly when the requested range cannot contain the machines", () => {
    expect(() => optimizeHeadlessLayout({
      width: 1,
      height: 1,
      targets: [{ itemId: "item_iron_nugget", perMinute: 60 }],
    }, createRegistryContract())).toThrow(/Unable to fit/);
  });

  it("validates optional CP-SAT search limits", () => {
    expect(() => optimizeHeadlessLayout({
      width: 32,
      height: 32,
      targets: [{ itemId: "item_iron_nugget", perMinute: 60 }],
      search: { cpSat: { enabled: true, maxSeconds: 0 } },
    }, createRegistryContract())).toThrow(/cpSat\.maxSeconds/);
    expect(() => optimizeHeadlessLayout({
      width: 32,
      height: 32,
      targets: [{ itemId: "item_iron_nugget", perMinute: 60 }],
      search: { cpSat: { enabled: true, candidates: 13 } },
    }, createRegistryContract())).toThrow(/cpSat\.candidates/);
  });

  it("fails clearly for an unknown target item", () => {
    expect(() => optimizeHeadlessLayout({
      width: 20,
      height: 20,
      targets: [{ itemId: "item_missing", perMinute: 1 }],
    }, createRegistryContract())).toThrow(/unresolved inputs/i);
  });
});

function expectNoOverlaps(devices: readonly {
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
}[]): void {
  const cells = new Set<string>();
  for (const device of devices) {
    for (let y = device.position.y; y < device.position.y + device.height; y += 1) {
      for (let x = device.position.x; x < device.position.x + device.width; x += 1) {
        const key = `${x},${y}`;
        expect(cells.has(key), `overlap at ${key}`).toBe(false);
        cells.add(key);
      }
    }
  }
}
