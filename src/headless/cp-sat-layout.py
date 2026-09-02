#!/usr/bin/env python3
import json
import platform
import sys
import time

try:
    import ortools
    from ortools.sat.python import cp_model
except ImportError:
    # Emit machine-readable dependency failure instead of exiting silently.
    json.dump({
        "layouts": [],
        "status": "dependency-missing",
        "pythonVersion": platform.python_version(),
    }, sys.stdout, separators=(",", ":"))
    sys.exit(0)


def solve_variant(data, variant, deadline, forbidden_layouts):
    if deadline - time.monotonic() <= 0.01:
        return None, True
    model = cp_model.CpModel()
    limit_width = int(data["limitWidth"])
    limit_height = int(data["limitHeight"])
    clearance = max(0, int(data["routingClearance"]))
    variables = {}
    x_intervals = []
    y_intervals = []
    fixed_end_x_values = []
    fixed_end_y_values = []
    for device in data["devices"]:
        if deadline - time.monotonic() <= 0.01:
            return None, True
        device_id = device["id"]
        base_width = int(device["width"])
        base_height = int(device["height"])
        rotations = [0, 90, 180, 270] if data["allowRotate"] else [0]
        tuples = []
        for rotation in rotations:
            swaps = rotation in (90, 270)
            tuples.append((rotation, base_height if swaps else base_width, base_width if swaps else base_height))
        rotation_var = model.new_int_var_from_domain(
            cp_model.Domain.from_values(rotations), f"rotation_{device_id}"
        )
        width_var = model.new_int_var(min(base_width, base_height), max(base_width, base_height), f"width_{device_id}")
        height_var = model.new_int_var(min(base_width, base_height), max(base_width, base_height), f"height_{device_id}")
        model.add_allowed_assignments([rotation_var, width_var, height_var], tuples)
        x_var = model.new_int_var(0, limit_width - min(base_width, base_height), f"x_{device_id}")
        y_var = model.new_int_var(0, limit_height - min(base_width, base_height), f"y_{device_id}")
        footprint_end_x = model.new_int_var(0, limit_width, f"footprint_end_x_{device_id}")
        footprint_end_y = model.new_int_var(0, limit_height, f"footprint_end_y_{device_id}")
        model.add(footprint_end_x == x_var + width_var)
        model.add(footprint_end_y == y_var + height_var)
        model.add(footprint_end_x <= limit_width)
        model.add(footprint_end_y <= limit_height)
        fixed = device.get("fixedPlacement")
        if fixed is not None:
            model.add(x_var == int(fixed["x"]))
            model.add(y_var == int(fixed["y"]))
            model.add(rotation_var == int(fixed["rotation"]))
        hint = device.get("hintPlacement")
        if hint is not None:
            model.add_hint(x_var, int(hint["x"]))
            model.add_hint(y_var, int(hint["y"]))
            model.add_hint(rotation_var, int(hint["rotation"]))
        # Routing clearance is not a mandatory gap between machines: adjacent
        # footprints are legal when their required ports remain reachable. The
        # final A* routing pass is the authority for that reachability.
        x_intervals.append(model.new_interval_var(x_var, width_var, footprint_end_x, f"x_interval_{device_id}"))
        y_intervals.append(model.new_interval_var(y_var, height_var, footprint_end_y, f"y_interval_{device_id}"))
        variables[device_id] = {
            "x": x_var,
            "y": y_var,
            "rotation": rotation_var,
            "width": width_var,
            "height": height_var,
            "end_x": footprint_end_x,
            "end_y": footprint_end_y,
        }
    for obstacle in data.get("fixedObstacles", []):
        if deadline - time.monotonic() <= 0.01:
            return None, True
        obstacle_id = obstacle["id"]
        obstacle_x = int(obstacle["x"])
        obstacle_y = int(obstacle["y"])
        obstacle_width = int(obstacle["width"])
        obstacle_height = int(obstacle["height"])
        x_intervals.append(model.new_fixed_size_interval_var(
            obstacle_x, obstacle_width, f"fixed_x_interval_{obstacle_id}"
        ))
        y_intervals.append(model.new_fixed_size_interval_var(
            obstacle_y, obstacle_height, f"fixed_y_interval_{obstacle_id}"
        ))
        fixed_end_x_values.append(obstacle_x + obstacle_width)
        fixed_end_y_values.append(obstacle_y + obstacle_height)
    model.add_no_overlap_2d(x_intervals, y_intervals)

    # Each previously emitted pose vector becomes a no-good cut:
    # at least one device must change x, y, or rotation. This turns candidate
    # variants into distinct mathematical solutions instead of relying on
    # post-solve signature deduplication.
    for cut_index, layout in enumerate(forbidden_layouts):
        same_pose_terms = []
        for placement_index, placement in enumerate(layout):
            entry = variables.get(placement["id"])
            if entry is None:
                continue
            same_x = model.new_bool_var(f"cut_{cut_index}_{placement_index}_same_x")
            same_y = model.new_bool_var(f"cut_{cut_index}_{placement_index}_same_y")
            same_rotation = model.new_bool_var(
                f"cut_{cut_index}_{placement_index}_same_rotation"
            )
            model.add(entry["x"] == int(placement["x"])).only_enforce_if(same_x)
            model.add(entry["x"] != int(placement["x"])).only_enforce_if(same_x.negated())
            model.add(entry["y"] == int(placement["y"])).only_enforce_if(same_y)
            model.add(entry["y"] != int(placement["y"])).only_enforce_if(same_y.negated())
            model.add(entry["rotation"] == int(placement["rotation"])).only_enforce_if(
                same_rotation
            )
            model.add(entry["rotation"] != int(placement["rotation"])).only_enforce_if(
                same_rotation.negated()
            )
            same_pose = model.new_bool_var(f"cut_{cut_index}_{placement_index}_same_pose")
            model.add_bool_and([same_x, same_y, same_rotation]).only_enforce_if(same_pose)
            model.add_bool_or([
                same_x.negated(),
                same_y.negated(),
                same_rotation.negated(),
            ]).only_enforce_if(same_pose.negated())
            same_pose_terms.append(same_pose)
        if same_pose_terms:
            model.add(sum(same_pose_terms) <= len(same_pose_terms) - 1)

    def add_point_outside_rectangle(available, point_x, point_y, rectangle, name):
        sides = [model.new_bool_var(f"{name}_{side}") for side in ("left", "right", "top", "bottom")]
        model.add(point_x < rectangle["x"]).only_enforce_if(sides[0])
        model.add(point_x >= rectangle["x"]).only_enforce_if(sides[0].negated())
        model.add(point_x >= rectangle["end_x"]).only_enforce_if(sides[1])
        model.add(point_x < rectangle["end_x"]).only_enforce_if(sides[1].negated())
        model.add(point_y < rectangle["y"]).only_enforce_if(sides[2])
        model.add(point_y >= rectangle["y"]).only_enforce_if(sides[2].negated())
        model.add(point_y >= rectangle["end_y"]).only_enforce_if(sides[3])
        model.add(point_y < rectangle["end_y"]).only_enforce_if(sides[3].negated())
        model.add_bool_or(sides).only_enforce_if(available)

    fixed_rectangles = [
        {
            "x": int(obstacle["x"]),
            "y": int(obstacle["y"]),
            "end_x": int(obstacle["x"]) + int(obstacle["width"]),
            "end_y": int(obstacle["y"]) + int(obstacle["height"]),
        }
        for obstacle in data.get("fixedObstacles", [])
    ]
    for device in data["devices"]:
        if deadline - time.monotonic() <= 0.01:
            return None, True
        entry = variables[device["id"]]
        for requirement_index, requirement in enumerate(device.get("portRequirements", [])):
            escape_depth = max(1, min(3, int(requirement.get("escapeDepth", 1))))
            available_ports = []
            for port_index, port in enumerate(requirement.get("ports", [])):
                for rotation_text, offset in port.get("offsets", {}).items():
                    rotation = int(rotation_text)
                    available = model.new_bool_var(
                        f'port_available_{device["id"]}_{requirement_index}_{port_index}_{rotation}'
                    )
                    model.add(entry["rotation"] == rotation).only_enforce_if(available)
                    edge = port.get("escapeEdges", {}).get(rotation_text)
                    delta_x, delta_y = {
                        "NORTH": (0, -1),
                        "EAST": (1, 0),
                        "SOUTH": (0, 1),
                        "WEST": (-1, 0),
                    }.get(edge, (0, 0))
                    for escape_step in range(escape_depth):
                        point_x = entry["x"] + int(offset["x"]) + delta_x * escape_step
                        point_y = entry["y"] + int(offset["y"]) + delta_y * escape_step
                        model.add(point_x >= 0).only_enforce_if(available)
                        model.add(point_x < limit_width).only_enforce_if(available)
                        model.add(point_y >= 0).only_enforce_if(available)
                        model.add(point_y < limit_height).only_enforce_if(available)
                        for other_index, (other_id, rectangle) in enumerate(variables.items()):
                            if other_index % 8 == 0 and deadline - time.monotonic() <= 0.01:
                                return None, True
                            if other_id == device["id"]:
                                continue
                            add_point_outside_rectangle(
                                available,
                                point_x,
                                point_y,
                                rectangle,
                                f'port_clear_{device["id"]}_{requirement_index}_{port_index}_'
                                f'{rotation}_{escape_step}_{other_id}',
                            )
                        for obstacle_index, rectangle in enumerate(fixed_rectangles):
                            add_point_outside_rectangle(
                                available,
                                point_x,
                                point_y,
                                rectangle,
                                f'port_fixed_clear_{device["id"]}_{requirement_index}_{port_index}_'
                                f'{rotation}_{escape_step}_{obstacle_index}',
                            )
                    available_ports.append(available)
            model.add(sum(available_ports) >= int(requirement["requiredCount"]))
    used_width = model.new_int_var(0, limit_width, "used_width")
    used_height = model.new_int_var(0, limit_height, "used_height")
    model.add_max_equality(
        used_width,
        [entry["end_x"] for entry in variables.values()] + fixed_end_x_values,
    )
    model.add_max_equality(
        used_height,
        [entry["end_y"] for entry in variables.values()] + fixed_end_y_values,
    )
    area = model.new_int_var(0, limit_width * limit_height, "area")
    model.add_multiplication_equality(area, [used_width, used_height])
    maximum_side = model.new_int_var(0, max(limit_width, limit_height), "maximum_side")
    model.add_max_equality(maximum_side, [used_width, used_height])
    distance_terms = []
    direction_terms = []
    cluster_gap_terms = []
    corridor_deficit_terms = []

    def rectangle_gap(left, right, name):
        left_to_right = model.new_int_var(-limit_width, limit_width, f"{name}_left_to_right")
        right_to_left = model.new_int_var(-limit_width, limit_width, f"{name}_right_to_left")
        top_to_bottom = model.new_int_var(-limit_height, limit_height, f"{name}_top_to_bottom")
        bottom_to_top = model.new_int_var(-limit_height, limit_height, f"{name}_bottom_to_top")
        model.add(left_to_right == right["x"] - left["end_x"])
        model.add(right_to_left == left["x"] - right["end_x"])
        model.add(top_to_bottom == right["y"] - left["end_y"])
        model.add(bottom_to_top == left["y"] - right["end_y"])
        horizontal_gap = model.new_int_var(0, limit_width, f"{name}_horizontal_gap")
        vertical_gap = model.new_int_var(0, limit_height, f"{name}_vertical_gap")
        model.add_max_equality(horizontal_gap, [left_to_right, right_to_left, 0])
        model.add_max_equality(vertical_gap, [top_to_bottom, bottom_to_top, 0])
        pair_gap = model.new_int_var(0, limit_width + limit_height, f"{name}_pair_gap")
        model.add(pair_gap == horizontal_gap + vertical_gap)
        return pair_gap

    for cluster_index, cluster in enumerate(data.get("clusters", [])):
        if deadline - time.monotonic() <= 0.01:
            return None, True
        terminal = variables.get(cluster["terminalId"])
        producers = [variables[device_id] for device_id in cluster.get("producerIds", []) if device_id in variables]
        if terminal is not None and producers:
            gaps = [rectangle_gap(terminal, producer, f"cluster_{cluster_index}_terminal_{index}")
                    for index, producer in enumerate(producers)]
            minimum_gap = model.new_int_var(0, limit_width + limit_height,
                                            f"cluster_{cluster_index}_terminal_minimum_gap")
            model.add_min_equality(minimum_gap, gaps)
            # Permit a two-cell approach so the corridor-deficit model can
            # reserve multi-lane turning space without contradicting the
            # cluster-cohesion bound.
            model.add(minimum_gap <= 2)
            cluster_gap_terms.extend(gaps)
        for upstream_index, upstream_id in enumerate(cluster.get("sharedUpstreamIds", [])):
            upstream = variables.get(upstream_id)
            if upstream is None or not producers:
                continue
            gaps = [rectangle_gap(upstream, producer,
                                  f"cluster_{cluster_index}_upstream_{upstream_index}_{producer_index}")
                    for producer_index, producer in enumerate(producers)]
            minimum_gap = model.new_int_var(0, limit_width + limit_height,
                                            f"cluster_{cluster_index}_upstream_{upstream_index}_minimum_gap")
            model.add_min_equality(minimum_gap, gaps)
            model.add(minimum_gap <= 2)
            cluster_gap_terms.extend(gaps)

    def add_direction_penalty(entry, edges, vector_x, vector_y, name):
        for rotation_text, edge in edges.items():
            rotation = int(rotation_text)
            active = model.new_bool_var(f"{name}_rotation_{rotation}")
            model.add(entry["rotation"] == rotation).only_enforce_if(active)
            model.add(entry["rotation"] != rotation).only_enforce_if(active.negated())
            if edge == "NORTH":
                expression = vector_y
                bound = 2 * limit_height
            elif edge == "EAST":
                expression = -vector_x
                bound = 2 * limit_width
            elif edge == "SOUTH":
                expression = -vector_y
                bound = 2 * limit_height
            elif edge == "WEST":
                expression = vector_x
                bound = 2 * limit_width
            else:
                continue
            positive = model.new_int_var(0, bound, f"{name}_positive_{rotation}")
            model.add_max_equality(positive, [expression, 0])
            selected = model.new_int_var(0, bound, f"{name}_selected_{rotation}")
            model.add(selected == positive).only_enforce_if(active)
            model.add(selected == 0).only_enforce_if(active.negated())
            direction_terms.append(selected)

    for edge_index, edge in enumerate(data["edges"]):
        if deadline - time.monotonic() <= 0.01:
            return None, True
        source = variables.get(edge["sourceId"])
        target = variables.get(edge["targetId"])
        if source is None or target is None:
            continue
        delta_x = model.new_int_var(-2 * limit_width, 2 * limit_width, f"delta_x_{edge_index}")
        delta_y = model.new_int_var(-2 * limit_height, 2 * limit_height, f"delta_y_{edge_index}")
        distance_x = model.new_int_var(0, 2 * limit_width, f"distance_x_{edge_index}")
        distance_y = model.new_int_var(0, 2 * limit_height, f"distance_y_{edge_index}")
        model.add(delta_x == 2 * source["x"] + source["width"] - 2 * target["x"] - target["width"])
        model.add(delta_y == 2 * source["y"] + source["height"] - 2 * target["y"] - target["height"])
        model.add_abs_equality(distance_x, delta_x)
        model.add_abs_equality(distance_y, delta_y)
        weight = max(1, int(edge["weight"]))
        distance_terms.append(weight * (distance_x + distance_y))
        pair_gap = rectangle_gap(source, target, f"edge_corridor_{edge_index}")
        required_gap = min(2, max(1, int(edge.get("laneCount", 1))))
        signed_deficit = model.new_int_var(
            -limit_width - limit_height,
            required_gap,
            f"edge_corridor_signed_deficit_{edge_index}",
        )
        model.add(signed_deficit == required_gap - pair_gap)
        corridor_deficit = model.new_int_var(
            0,
            required_gap,
            f"edge_corridor_deficit_{edge_index}",
        )
        model.add_max_equality(corridor_deficit, [signed_deficit, 0])
        corridor_deficit_terms.append(weight * corridor_deficit)
        # Coordinates grow south/east. The source port should face the target,
        # while the target input port should face back toward the source.
        source_to_target_x = -delta_x
        source_to_target_y = -delta_y
        before_direction_count = len(direction_terms)
        add_direction_penalty(
            source,
            edge.get("sourceEdges", {}),
            source_to_target_x,
            source_to_target_y,
            f"source_direction_{edge_index}",
        )
        add_direction_penalty(
            target,
            edge.get("targetEdges", {}),
            -source_to_target_x,
            -source_to_target_y,
            f"target_direction_{edge_index}",
        )
        for term_index in range(before_direction_count, len(direction_terms)):
            direction_terms[term_index] = weight * direction_terms[term_index]
    total_distance = sum(distance_terms) if distance_terms else 0
    total_direction_penalty = sum(direction_terms) if direction_terms else 0
    total_cluster_gap = sum(cluster_gap_terms) if cluster_gap_terms else 0
    total_corridor_deficit = sum(corridor_deficit_terms) if corridor_deficit_terms else 0
    diversity_terms = []
    if variant > 0:
        base_seed = int(data["seed"]) + variant * 104729
        span_x = max(1, limit_width - 2 * clearance)
        span_y = max(1, limit_height - 2 * clearance)
        for device_index, device in enumerate(data["devices"]):
            if deadline - time.monotonic() <= 0.01:
                return None, True
            if device.get("fixedPlacement") is not None:
                continue
            entry = variables[device["id"]]
            target_x = clearance + ((base_seed + device_index * 8191) % span_x)
            target_y = clearance + ((base_seed * 3 + device_index * 131071) % span_y)
            delta_x = model.new_int_var(-limit_width, limit_width,
                                        f"diversity_delta_x_{variant}_{device_index}")
            delta_y = model.new_int_var(-limit_height, limit_height,
                                        f"diversity_delta_y_{variant}_{device_index}")
            distance_x = model.new_int_var(0, limit_width,
                                           f"diversity_distance_x_{variant}_{device_index}")
            distance_y = model.new_int_var(0, limit_height,
                                           f"diversity_distance_y_{variant}_{device_index}")
            model.add(delta_x == entry["x"] - target_x)
            model.add(delta_y == entry["y"] - target_y)
            model.add_abs_equality(distance_x, delta_x)
            model.add_abs_equality(distance_y, delta_y)
            diversity_terms.append(distance_x + distance_y)
    total_diversity = sum(diversity_terms) if diversity_terms else 0
    distance_weight = (80, 240, 480, 160)[variant % 4]
    width_bias = (10, 30, 0, 20)[variant % 4]
    height_bias = (20, 0, 30, 10)[variant % 4]
    # Read optional named objective weights; absent keys default to 1.0, preserving
    # backward compatibility with the pre-slice formula.
    named_weights = data.get("objectiveWeights", {}) or {}
    area_weight = int(1_000_000 * float(named_weights.get("boundingArea", 1.0)))
    max_side_weight = int(20_000 * float(named_weights.get("maxSide", 1.0)))
    logistics_scale = float(named_weights.get("logisticsCells", 1.0))
    cluster_gap_weight = int(5_000 * logistics_scale)
    corridor_deficit_weight = int(100_000 * logistics_scale)
    distance_weight_scaled = distance_weight * logistics_scale
    direction_weight_scaled = distance_weight * 4 * logistics_scale
    model.minimize(
        area * area_weight
        + maximum_side * max_side_weight
        + total_corridor_deficit * corridor_deficit_weight
        + total_cluster_gap * cluster_gap_weight
        + total_distance * distance_weight_scaled
        + total_direction_penalty * direction_weight_scaled
        + total_diversity * 2_000
        + used_width * width_bias
        + used_height * height_bias
    )
    remaining_seconds = deadline - time.monotonic()
    if remaining_seconds <= 0.01:
        return None, True
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.01, remaining_seconds)
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = (int(data["seed"]) + variant * 104729) & 0x7FFFFFFF
    solver.parameters.randomize_search = variant > 0
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None, time.monotonic() >= deadline
    return [
        {
            "id": device_id,
            "x": solver.value(entry["x"]),
            "y": solver.value(entry["y"]),
            "rotation": solver.value(entry["rotation"]),
            "width": solver.value(entry["width"]),
            "height": solver.value(entry["height"]),
        }
        for device_id, entry in variables.items()
    ], time.monotonic() >= deadline


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as error:
        json.dump({
            "layouts": [],
            "status": "solver-failed",
            "errorMessage": str(error),
            "pythonVersion": platform.python_version(),
            "orToolsVersion": ortools.__version__,
        }, sys.stdout, separators=(",", ":"))
        return

    try:
        started_at = time.monotonic()
        deadline = started_at + max(0.1, float(data["maxSeconds"]))
        candidate_count = max(1, int(data["candidateCount"]))
        layouts = []
        signatures = set()
        attempted_candidates = 0
        stopped_by = "completed"
        input_forbidden_layouts = data.get("forbiddenLayouts", []) or []
        for variant in range(candidate_count):
            if deadline - time.monotonic() <= 0.01:
                stopped_by = "total-budget"
                break
            attempted_candidates += 1
            layout, budget_exhausted = solve_variant(
                data,
                variant,
                deadline,
                [*input_forbidden_layouts, *layouts],
            )
            if layout is None:
                if budget_exhausted:
                    stopped_by = "total-budget"
                    break
                continue
            signature = "|".join(
                f'{entry["id"]}@{entry["x"]},{entry["y"]},{entry["rotation"]}'
                for entry in sorted(layout, key=lambda item: item["id"])
            )
            if signature not in signatures:
                signatures.add(signature)
                layouts.append(layout)
            if budget_exhausted:
                stopped_by = "total-budget"
                break

        elapsed_ms = round((time.monotonic() - started_at) * 1000)
        status = "success" if layouts else (
            "timeout" if stopped_by == "total-budget" else "no-layouts"
        )
        envelope = {
            "layouts": layouts,
            "status": status,
            "pythonVersion": platform.python_version(),
            "orToolsVersion": ortools.__version__,
            "attemptedCandidates": attempted_candidates,
            "stoppedBy": stopped_by,
            "elapsedMs": elapsed_ms,
        }
        json.dump(envelope, sys.stdout, separators=(",", ":"))
    except Exception as error:
        json.dump({
            "layouts": [],
            "status": "solver-failed",
            "errorMessage": str(error)[:2000],
            "pythonVersion": platform.python_version(),
            "orToolsVersion": ortools.__version__,
        }, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
