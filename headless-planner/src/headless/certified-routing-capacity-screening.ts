import type { CertifiedAreaRelaxationPlacement } from "./certified-area-relaxation";

export const CERTIFIED_ROUTING_CAPACITY_SCREENING_PROFILE =
  "certified-routing-capacity-screening-v1" as const;

export interface CertifiedRoutingCapacityItem {
  readonly itemId: string;
  readonly laneCapacityPerMinute: number;
}

export interface CertifiedRoutingCapacityFlow {
  readonly itemId: string;
  readonly perMinute: number;
}

export interface CertifiedRoutingCapacityNode {
  readonly id: string;
  readonly kind: "production" | "storage" | "warehouse-port";
  readonly inputs: readonly CertifiedRoutingCapacityFlow[];
  readonly outputs: readonly CertifiedRoutingCapacityFlow[];
}

export interface CertifiedRoutingCapacityOmittedItem {
  readonly itemId: string;
  readonly reason: "non-solid-domain" | "unmodeled-external-supply";
}

/**
 * Geometry-free material balances used only to screen candidate axis cuts.
 * V1 deliberately admits solid/belt items only; boundary-fed fluids remain out.
 */
export interface CertifiedRoutingCapacityScreeningProblem {
  readonly items: readonly CertifiedRoutingCapacityItem[];
  readonly nodes: readonly CertifiedRoutingCapacityNode[];
  /** Items conservatively excluded before screening, with an auditable reason. */
  readonly omittedItems: readonly CertifiedRoutingCapacityOmittedItem[];
}

export interface CertifiedRoutingCapacityItemDemand {
  readonly itemId: string;
  readonly requiredLaneCount: number;
  readonly residualCrossingPerMinute: number;
  readonly warehouseExemptSupplyPerMinute: number;
}

export interface CertifiedRoutingCapacityAxisCut {
  readonly axis: "vertical" | "horizontal";
  readonly coordinate: number;
  readonly demand: number;
  readonly capacity: number;
  readonly deficit: number;
  readonly itemDemands: readonly CertifiedRoutingCapacityItemDemand[];
}

export interface CertifiedRoutingCapacityScreeningResult {
  readonly constraintProfile: typeof CERTIFIED_ROUTING_CAPACITY_SCREENING_PROFILE;
  /** Charged-rectangle envelope of the screened placement witness. */
  readonly screenedPlacementArea: number;
  readonly evaluatedCutCount: number;
  readonly activeCutCount: number;
  readonly violatingCutCount: number;
  readonly maximumDeficit: number;
  readonly necessaryConditionViolated: boolean;
  readonly violatingCuts: readonly CertifiedRoutingCapacityAxisCut[];
  /** Highest demand-minus-capacity cut, even when it is nonviolating. */
  readonly strongestCut?: CertifiedRoutingCapacityAxisCut;
}

/**
 * Screen one charged-rectangle master witness for globally necessary axis-cut
 * capacity conditions. This function does not return a lower bound and its
 * result is never combined into the certified optimality report.
 *
 * A material node is assigned to a cut side only when its whole rectangle plus
 * a one-cell endpoint halo lies on that side. Ambiguous nodes contribute no
 * demand and their production is made available to both sides. Warehouse
 * unloader output is also made globally available because those supply belts
 * are area-exempt and may bypass the charged bounding box. These relaxations
 * can miss violations but cannot create a false mandatory crossing.
 */
export function screenCertifiedRoutingCapacity(options: {
  readonly problem: CertifiedRoutingCapacityScreeningProblem;
  readonly placements: readonly CertifiedAreaRelaxationPlacement[];
}): CertifiedRoutingCapacityScreeningResult {
  validateProblem(options.problem);
  if (options.placements.length === 0) {
    throw new Error("Routing-capacity screening requires a master placement");
  }
  const placementById = new Map<string, CertifiedAreaRelaxationPlacement>();
  for (const [index, placement] of options.placements.entries()) {
    validatePlacement(placement, index);
    if (placementById.has(placement.id)) {
      throw new Error(`Duplicate routing-capacity placement ID: ${placement.id}`);
    }
    placementById.set(placement.id, placement);
  }
  for (const [index, left] of options.placements.entries()) {
    for (const right of options.placements.slice(index + 1)) {
      if (rectanglesOverlap(left, right)) {
        throw new Error(`Routing-capacity placements ${left.id} and ${right.id} overlap`);
      }
    }
  }
  for (const node of options.problem.nodes) {
    if (!placementById.has(node.id)) {
      throw new Error(`Routing-capacity node ${node.id} has no master placement`);
    }
  }
  const materialPlacements = options.problem.nodes.map((node) => placementById.get(node.id)!);

  const minimumX = Math.min(...options.placements.map((placement) => placement.x));
  const maximumX = Math.max(...options.placements.map((placement) =>
    placement.x + placement.width));
  const maximumY = Math.max(...options.placements.map((placement) =>
    placement.y + placement.height));
  const cuts: CertifiedRoutingCapacityAxisCut[] = [];
  for (let coordinate = minimumX + 1; coordinate < maximumX; coordinate += 1) {
    cuts.push(analyzeCut({
      axis: "vertical",
      coordinate,
      orthogonalStart: 0,
      orthogonalEnd: maximumY,
      blockingPlacements: materialPlacements,
      placementById,
      problem: options.problem,
    }));
  }
  for (let coordinate = 1; coordinate < maximumY; coordinate += 1) {
    cuts.push(analyzeCut({
      axis: "horizontal",
      coordinate,
      orthogonalStart: minimumX,
      orthogonalEnd: maximumX,
      blockingPlacements: materialPlacements,
      placementById,
      problem: options.problem,
    }));
  }
  const activeCuts = cuts.filter((cut) => cut.demand > 0);
  const strongestCut = [...activeCuts].sort(compareCuts)[0];
  const violatingCuts = activeCuts.filter((cut) => cut.deficit > 0).sort(compareCuts);
  return {
    constraintProfile: CERTIFIED_ROUTING_CAPACITY_SCREENING_PROFILE,
    screenedPlacementArea: (maximumX - minimumX) * maximumY,
    evaluatedCutCount: cuts.length,
    activeCutCount: activeCuts.length,
    violatingCutCount: violatingCuts.length,
    maximumDeficit: Math.max(0, ...activeCuts.map((cut) => cut.deficit)),
    necessaryConditionViolated: violatingCuts.length > 0,
    violatingCuts,
    ...(strongestCut === undefined ? {} : { strongestCut }),
  };
}

function analyzeCut(options: {
  readonly axis: "vertical" | "horizontal";
  readonly coordinate: number;
  readonly orthogonalStart: number;
  readonly orthogonalEnd: number;
  readonly blockingPlacements: readonly CertifiedAreaRelaxationPlacement[];
  readonly placementById: ReadonlyMap<string, CertifiedAreaRelaxationPlacement>;
  readonly problem: CertifiedRoutingCapacityScreeningProblem;
}): CertifiedRoutingCapacityAxisCut {
  const sideByNodeId = new Map(options.problem.nodes.map((node) => [
    node.id,
    sideOf(options.placementById.get(node.id)!, options.axis, options.coordinate),
  ] as const));
  const itemDemands = options.problem.items.flatMap((item): CertifiedRoutingCapacityItemDemand[] => {
    let leftInput = 0;
    let rightInput = 0;
    let leftOutput = 0;
    let rightOutput = 0;
    let ambiguousOutput = 0;
    let warehouseExemptSupplyPerMinute = 0;
    for (const node of options.problem.nodes) {
      const input = flowRate(node.inputs, item.itemId);
      const output = flowRate(node.outputs, item.itemId);
      if (node.kind === "warehouse-port") {
        warehouseExemptSupplyPerMinute += output;
        continue;
      }
      const side = sideByNodeId.get(node.id);
      if (side === -1) {
        leftInput += input;
        leftOutput += output;
      } else if (side === 1) {
        rightInput += input;
        rightOutput += output;
      } else {
        // Omitting ambiguous demand and duplicating ambiguous production is a
        // deliberate relaxation of endpoint placement.
        ambiguousOutput += output;
      }
    }
    const leftDeficit = Math.max(0, leftInput - leftOutput - ambiguousOutput);
    const rightDeficit = Math.max(0, rightInput - rightOutput - ambiguousOutput);
    const residualCrossingPerMinute = Math.max(
      0,
      leftDeficit + rightDeficit - warehouseExemptSupplyPerMinute,
    );
    const requiredLaneCount = laneCount(
      residualCrossingPerMinute,
      item.laneCapacityPerMinute,
    );
    return requiredLaneCount === 0 ? [] : [{
      itemId: item.itemId,
      requiredLaneCount,
      residualCrossingPerMinute,
      warehouseExemptSupplyPerMinute,
    }];
  }).sort((left, right) => left.itemId.localeCompare(right.itemId));
  const demand = itemDemands.reduce((sum, item) => sum + item.requiredLaneCount, 0);
  let capacity = 0;
  for (let offset = options.orthogonalStart; offset < options.orthogonalEnd; offset += 1) {
    const leftOrTop = options.axis === "vertical"
      ? { x: options.coordinate - 1, y: offset }
      : { x: offset, y: options.coordinate - 1 };
    const rightOrBottom = options.axis === "vertical"
      ? { x: options.coordinate, y: offset }
      : { x: offset, y: options.coordinate };
    if (!options.blockingPlacements.some((placement) =>
      containsCell(placement, leftOrTop) || containsCell(placement, rightOrBottom))) {
      capacity += 1;
    }
  }
  return {
    axis: options.axis,
    coordinate: options.coordinate,
    demand,
    capacity,
    deficit: demand - capacity,
    itemDemands,
  };
}

function sideOf(
  placement: CertifiedAreaRelaxationPlacement,
  axis: "vertical" | "horizontal",
  coordinate: number,
): -1 | 1 | null {
  const start = axis === "vertical" ? placement.x : placement.y;
  const size = axis === "vertical" ? placement.width : placement.height;
  if (start + size < coordinate) return -1;
  if (start > coordinate) return 1;
  return null;
}

function containsCell(
  placement: CertifiedAreaRelaxationPlacement,
  cell: { readonly x: number; readonly y: number },
): boolean {
  return cell.x >= placement.x && cell.x < placement.x + placement.width
    && cell.y >= placement.y && cell.y < placement.y + placement.height;
}

function flowRate(flows: readonly CertifiedRoutingCapacityFlow[], itemId: string): number {
  return flows.find((flow) => flow.itemId === itemId)?.perMinute ?? 0;
}

function laneCount(perMinute: number, capacity: number): number {
  if (perMinute <= 0) return 0;
  return Math.ceil(perMinute / capacity - 0.000001);
}

function compareCuts(
  left: CertifiedRoutingCapacityAxisCut,
  right: CertifiedRoutingCapacityAxisCut,
): number {
  return right.deficit - left.deficit
    || right.demand - left.demand
    || left.capacity - right.capacity
    || left.axis.localeCompare(right.axis)
    || left.coordinate - right.coordinate;
}

function validateProblem(problem: CertifiedRoutingCapacityScreeningProblem): void {
  const items = new Set<string>();
  for (const item of problem.items) {
    if (item.itemId.length === 0 || items.has(item.itemId)) {
      throw new Error(`Duplicate or empty routing-capacity item ID: ${item.itemId}`);
    }
    items.add(item.itemId);
    assertPositiveFinite(item.laneCapacityPerMinute, `${item.itemId}.laneCapacityPerMinute`);
  }
  const omittedItems = new Set<string>();
  for (const omitted of problem.omittedItems) {
    if (omitted.itemId.length === 0 || items.has(omitted.itemId)
      || omittedItems.has(omitted.itemId)
      || (omitted.reason !== "non-solid-domain"
        && omitted.reason !== "unmodeled-external-supply")) {
      throw new Error(`Invalid or duplicate omitted routing-capacity item: ${omitted.itemId}`);
    }
    omittedItems.add(omitted.itemId);
  }
  const nodes = new Set<string>();
  for (const node of problem.nodes) {
    if (node.id.length === 0 || nodes.has(node.id)
      || (node.kind !== "production" && node.kind !== "storage"
        && node.kind !== "warehouse-port")) {
      throw new Error(`Duplicate or empty routing-capacity node ID: ${node.id}`);
    }
    nodes.add(node.id);
    validateFlows(node.id, "input", node.inputs, items);
    validateFlows(node.id, "output", node.outputs, items);
  }
  for (const item of problem.items) {
    const totalInput = problem.nodes.reduce(
      (sum, node) => sum + flowRate(node.inputs, item.itemId), 0,
    );
    const totalOutput = problem.nodes.reduce(
      (sum, node) => sum + flowRate(node.outputs, item.itemId), 0,
    );
    if (!Number.isFinite(totalInput) || !Number.isFinite(totalOutput)) {
      throw new Error(`Routing-capacity item ${item.itemId} total flow is not finite`);
    }
    if (totalOutput + 0.000001 < totalInput) {
      throw new Error(
        `Routing-capacity item ${item.itemId} has unmodeled external supply`,
      );
    }
  }
}

function validateFlows(
  nodeId: string,
  direction: "input" | "output",
  flows: readonly CertifiedRoutingCapacityFlow[],
  items: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const flow of flows) {
    if (!items.has(flow.itemId)) {
      throw new Error(`Routing-capacity node ${nodeId} references unknown item ${flow.itemId}`);
    }
    if (seen.has(flow.itemId)) {
      throw new Error(`Routing-capacity node ${nodeId} has duplicate ${direction} ${flow.itemId}`);
    }
    seen.add(flow.itemId);
    assertPositiveFinite(flow.perMinute, `${nodeId}:${flow.itemId}.perMinute`);
  }
}

function validatePlacement(
  placement: CertifiedAreaRelaxationPlacement,
  index: number,
): void {
  if (placement.id.length === 0
    || !Number.isSafeInteger(placement.x) || placement.x < 0
    || !Number.isSafeInteger(placement.y) || placement.y < 0
    || !Number.isSafeInteger(placement.width) || placement.width <= 0
    || !Number.isSafeInteger(placement.height) || placement.height <= 0
    || (placement.rotation !== 0 && placement.rotation !== 90
      && placement.rotation !== 180 && placement.rotation !== 270)) {
    throw new Error(`Routing-capacity placement ${index} has invalid geometry`);
  }
}

function rectanglesOverlap(
  left: CertifiedAreaRelaxationPlacement,
  right: CertifiedAreaRelaxationPlacement,
): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}
