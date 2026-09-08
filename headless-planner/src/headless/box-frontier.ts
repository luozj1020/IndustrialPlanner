export interface BoxDimensions {
  readonly width: number;
  readonly height: number;
  readonly area: number;
}

export interface BoxFrontierOptions {
  /** Inclusive area ceiling. Better-than-incumbent search passes incumbentArea - 1. */
  readonly maxArea: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly minArea?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
}

export interface BoxWarmStartShape {
  readonly width: number;
  readonly height: number;
}

/** True when every layout fitting `dominated` also fits `candidate`. */
export function dominatesBox(candidate: BoxDimensions, dominated: BoxDimensions): boolean {
  return candidate.width >= dominated.width
    && candidate.height >= dominated.height
    && (candidate.width > dominated.width || candidate.height > dominated.height);
}

/**
 * Enumerate the componentwise-maximal integer boxes under an inclusive area cap.
 *
 * The returned staircase is ordered by increasing width. A proof that every
 * member is infeasible covers every smaller box under the same map limits, but
 * callers must not promote a heuristic routing failure to such a proof.
 */
export function createParetoMaximalBoxFrontier(
  options: BoxFrontierOptions,
): readonly BoxDimensions[] {
  const maxArea = requireNonNegativeInteger(options.maxArea, "maxArea");
  const maxWidth = requirePositiveInteger(options.maxWidth, "maxWidth");
  const maxHeight = requirePositiveInteger(options.maxHeight, "maxHeight");
  const minArea = requireNonNegativeInteger(options.minArea ?? 0, "minArea");
  const minWidth = requirePositiveInteger(options.minWidth ?? 1, "minWidth");
  const minHeight = requirePositiveInteger(options.minHeight ?? 1, "minHeight");
  if (minWidth > maxWidth || minHeight > maxHeight || minArea > maxArea || maxArea === 0) {
    return [];
  }

  const candidates: BoxDimensions[] = [];
  const lastWidth = Math.min(maxWidth, Math.floor(maxArea / minHeight));
  for (let width = minWidth; width <= lastWidth; width += 1) {
    const height = Math.min(maxHeight, Math.floor(maxArea / width));
    const area = width * height;
    if (height < minHeight || area < minArea) continue;
    candidates.push({ width, height, area });
  }

  // Heights are non-increasing as widths increase. Scanning from the right
  // therefore removes exactly the earlier members of every equal-height run.
  const reversedFrontier: BoxDimensions[] = [];
  let maximumHeightToTheRight = -1;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    if (candidate.height > maximumHeightToTheRight) {
      reversedFrontier.push(candidate);
      maximumHeightToTheRight = candidate.height;
    }
  }
  return reversedFrontier.reverse();
}

/**
 * Try staircase boxes nearest to the routed incumbent first. This changes only
 * SAT-finding order; it has no bearing on frontier completeness or proof.
 */
export function orderBoxFrontierForWarmStart(
  frontier: readonly BoxDimensions[],
  warmStart: BoxWarmStartShape,
): readonly BoxDimensions[] {
  requirePositiveInteger(warmStart.width, "warmStart.width");
  requirePositiveInteger(warmStart.height, "warmStart.height");
  return [...frontier].sort((left, right) => {
    const leftDistance = Math.abs(left.width - warmStart.width)
      + Math.abs(left.height - warmStart.height);
    const rightDistance = Math.abs(right.width - warmStart.width)
      + Math.abs(right.height - warmStart.height);
    return leftDistance - rightDistance
      || right.area - left.area
      || Math.max(left.width, left.height) - Math.max(right.width, right.height)
      || left.height - right.height
      || left.width - right.width;
  });
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer, received ${value}`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer, received ${value}`);
  }
  return value;
}
