#!/usr/bin/env python3
"""M1 bounded-box placement satisfaction master (not a full-routing proof)."""

import json
import math
import platform
import sys
import time

PROFILE = "bounded-box-placement-v1"


def emit(status, **fields):
    json.dump(
        {
            "constraintProfile": PROFILE,
            "status": status,
            "placements": [],
            "pythonVersion": platform.python_version(),
            **fields,
        },
        sys.stdout,
        separators=(",", ":"),
    )


try:
    import ortools
    from ortools.sat.python import cp_model
except ImportError:
    emit("dependency-missing")
    sys.exit(0)


def positive_integer(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def parse_input():
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        raise ValueError("input must be an object")
    allowed_keys = {
        "constraintProfile",
        "devices",
        "mapWidth",
        "mapHeight",
        "boxWidth",
        "boxHeight",
        "allowRotate",
        "maxSeconds",
        "candidateCount",
        "seed",
    }
    unexpected_keys = sorted(set(data) - allowed_keys)
    if unexpected_keys:
        raise ValueError(f"unsupported bounded-box fields: {','.join(unexpected_keys)}")
    if data.get("constraintProfile") != PROFILE:
        raise ValueError("unexpected bounded-box master profile")

    devices = data.get("devices")
    if not isinstance(devices, list) or not devices:
        raise ValueError("devices must be a non-empty array")
    normalized_devices = []
    seen_ids = set()
    for index, device in enumerate(devices):
        if not isinstance(device, dict):
            raise ValueError(f"devices[{index}] must be an object")
        unexpected_device_keys = sorted(
            set(device) - {"id", "width", "height", "hintPlacement", "charged",
                           "warehouseRole", "busEdges", "portRequirements"}
        )
        if unexpected_device_keys:
            raise ValueError(
                f"unsupported bounded-box device fields: {','.join(unexpected_device_keys)}"
            )
        device_id = device.get("id")
        if not isinstance(device_id, str) or not device_id or device_id in seen_ids:
            raise ValueError(f"invalid or duplicate device ID at index {index}")
        seen_ids.add(device_id)
        if type(device.get("charged", True)) is not bool:
            raise ValueError(f"{device_id}.charged must be a boolean")
        if device.get("warehouseRole") not in (None, "source", "segment", "port"):
            raise ValueError(f"invalid warehouseRole for {device_id}")
        bus_edges = device.get("busEdges", {})
        if not isinstance(bus_edges, dict) or any(
            rotation not in ("0", "90", "180", "270")
            or edge not in ("NORTH", "EAST", "SOUTH", "WEST")
            for rotation, edge in bus_edges.items()
        ):
            raise ValueError(f"invalid busEdges for {device_id}")
        requirements = device.get("portRequirements", [])
        if not isinstance(requirements, list):
            raise ValueError("portRequirements must be an array")
        for requirement in requirements:
            if not isinstance(requirement, dict) or set(requirement) != {"requiredCount", "ports"}:
                raise ValueError("invalid port requirement fields")
            positive_integer(requirement["requiredCount"], "requiredCount")
            if not isinstance(requirement["ports"], list):
                raise ValueError("ports must be an array")
            for port in requirement["ports"]:
                if not isinstance(port, dict) or set(port) != {"offsets"}:
                    raise ValueError("invalid port fields")
                if not isinstance(port["offsets"], dict):
                    raise ValueError("offsets must be an object")
                for rotation, offset in port["offsets"].items():
                    if rotation not in ("0", "90", "180", "270") or not isinstance(offset, dict):
                        raise ValueError("invalid port rotation or offset")
                    if set(offset) != {"x", "y"} or any(type(offset[key]) is not int for key in ("x", "y")):
                        raise ValueError("port offset must have integer x/y")
        hint = device.get("hintPlacement")
        if hint is not None:
            if not isinstance(hint, dict) or set(hint) != {"x", "y", "rotation"}:
                raise ValueError(f"invalid hintPlacement for {device_id}")
            if any(
                isinstance(hint[key], bool) or not isinstance(hint[key], int)
                for key in ("x", "y", "rotation")
            ):
                raise ValueError(f"non-integer hintPlacement for {device_id}")
        normalized_devices.append(
            {
                "id": device_id,
                "width": positive_integer(device.get("width"), f"{device_id}.width"),
                "height": positive_integer(device.get("height"), f"{device_id}.height"),
                "hint": hint,
                "charged": device.get("charged", True),
                "warehouseRole": device.get("warehouseRole"),
                "busEdges": device.get("busEdges", {}),
                "portRequirements": device.get("portRequirements", []),
            }
        )

    map_width = positive_integer(data.get("mapWidth"), "mapWidth")
    map_height = positive_integer(data.get("mapHeight"), "mapHeight")
    box_width = positive_integer(data.get("boxWidth"), "boxWidth")
    box_height = positive_integer(data.get("boxHeight"), "boxHeight")
    if box_width > map_width or box_height > map_height:
        raise ValueError("bounded box must fit inside the physical map")
    allow_rotate = data.get("allowRotate")
    if type(allow_rotate) is not bool:
        raise ValueError("allowRotate must be a boolean")
    max_seconds = data.get("maxSeconds")
    if (
        isinstance(max_seconds, bool)
        or not isinstance(max_seconds, (int, float))
        or not math.isfinite(max_seconds)
        or max_seconds <= 0
        or max_seconds > 30
    ):
        raise ValueError("maxSeconds must be in (0, 30]")
    candidate_count = positive_integer(data.get("candidateCount"), "candidateCount")
    if candidate_count > 64:
        raise ValueError("candidateCount must not exceed 64")
    seed = data.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be an integer")
    return (
        normalized_devices,
        map_width,
        map_height,
        box_width,
        box_height,
        allow_rotate,
        float(max_seconds),
        candidate_count,
        seed,
    )


def add_hub_constraints(model, devices, variables):
    by_id = {variable["id"]: variable for variable in variables}
    sources = [d for d in devices if d["warehouseRole"] == "source"]
    segments = [d for d in devices if d["warehouseRole"] == "segment"]
    ports = [d for d in devices if d["warehouseRole"] == "port"]
    if not sources and not segments and not ports:
        return
    if len(sources) != 1:
        raise ValueError("warehouse search inventory must have one source")
    bus = sources + segments

    def touches(left, right, edge, name):
        active = model.new_bool_var(name)
        if edge in ("NORTH", "SOUTH"):
            model.add(left["x"] < right["end_x"]).only_enforce_if(active)
            model.add(right["x"] < left["end_x"]).only_enforce_if(active)
            if edge == "NORTH":
                model.add(left["y"] == right["end_y"]).only_enforce_if(active)
            else:
                model.add(left["end_y"] == right["y"]).only_enforce_if(active)
        else:
            model.add(left["y"] < right["end_y"]).only_enforce_if(active)
            model.add(right["y"] < left["end_y"]).only_enforce_if(active)
            if edge == "WEST":
                model.add(left["x"] == right["end_x"]).only_enforce_if(active)
            else:
                model.add(left["end_x"] == right["x"]).only_enforce_if(active)
        return active

    # An edge-adjacent rooted spanning tree proves every segment reaches source.
    depth = {d["id"]: model.new_int_var(0, len(bus) - 1, f'depth_{d["id"]}') for d in bus}
    model.add(depth[sources[0]["id"]] == 0)
    for child in segments:
        parents = []
        for parent in bus:
            if child["id"] == parent["id"]:
                continue
            for edge in ("NORTH", "EAST", "SOUTH", "WEST"):
                active = touches(by_id[child["id"]], by_id[parent["id"]], edge,
                                 f'parent_{child["id"]}_{parent["id"]}_{edge}')
                model.add(depth[child["id"]] > depth[parent["id"]]).only_enforce_if(active)
                parents.append(active)
        model.add_bool_or(parents)
    for port in ports:
        adjacency = []
        for rotation, edge in port["busEdges"].items():
            if edge not in ("NORTH", "EAST", "SOUTH", "WEST"):
                raise ValueError("invalid warehouse bus edge")
            for target in bus:
                active = touches(by_id[port["id"]], by_id[target["id"]], edge,
                                 f'hub_{port["id"]}_{target["id"]}_{rotation}')
                model.add(by_id[port["id"]]["rotation"] == int(rotation)).only_enforce_if(active)
                adjacency.append(active)
        model.add_bool_or(adjacency)


def add_port_access(model, devices, variables, map_width, map_height):
    for device, variable in zip(devices, variables):
        for req_index, requirement in enumerate(device["portRequirements"]):
            required = positive_integer(requirement.get("requiredCount"), "requiredCount")
            active_ports = []
            for port_index, port in enumerate(requirement["ports"]):
                name = f'access_{device["id"]}_{req_index}_{port_index}'
                active = model.new_bool_var(name)
                rotations = []
                for rotation, offset in port["offsets"].items():
                    selected = model.new_bool_var(f'{name}_{rotation}')
                    model.add(variable["rotation"] == int(rotation)).only_enforce_if(selected)
                    px = variable["x"] + offset["x"]
                    py = variable["y"] + offset["y"]
                    model.add(px >= 0).only_enforce_if(selected)
                    model.add(px < map_width).only_enforce_if(selected)
                    model.add(py >= 0).only_enforce_if(selected)
                    model.add(py < map_height).only_enforce_if(selected)
                    for blocker in variables:
                        # A selected outside cell must not be inside any entity;
                        # different ports may share a cell in this relaxation.
                        outside = [model.new_bool_var(f'{name}_{rotation}_{blocker["id"]}_{k}')
                                   for k in range(4)]
                        for literal, constraint in zip(outside, [px < blocker["x"],
                                px >= blocker["end_x"], py < blocker["y"], py >= blocker["end_y"]]):
                            model.add(constraint).only_enforce_if(literal)
                        model.add_bool_or(outside).only_enforce_if(selected)
                    rotations.append(selected)
                model.add(sum(rotations) == active)
                active_ports.append(active)
            model.add(sum(active_ports) >= required)


def solve(
    devices,
    map_width,
    map_height,
    box_width,
    box_height,
    allow_rotate,
    max_seconds,
    candidate_count,
    seed,
):
    started = time.monotonic()
    model = cp_model.CpModel()
    variables = []
    x_intervals = []
    y_intervals = []
    for device in devices:
        device_id = device["id"]
        base_width = device["width"]
        base_height = device["height"]
        # Keep all four rotations: equal rectangle geometry does not imply equal
        # game-port semantics. M1 deliberately applies no cross-ID symmetry.
        rotations = (0, 90, 180, 270) if allow_rotate else (0,)
        orientations = [
            (
                rotation,
                base_height if rotation in (90, 270) else base_width,
                base_width if rotation in (90, 270) else base_height,
            )
            for rotation in rotations
        ]
        rotation = model.new_int_var_from_domain(
            cp_model.Domain.from_values(rotations), f"rotation_{device_id}"
        )
        width = model.new_int_var(
            min(choice[1] for choice in orientations),
            max(choice[1] for choice in orientations),
            f"width_{device_id}",
        )
        height = model.new_int_var(
            min(choice[2] for choice in orientations),
            max(choice[2] for choice in orientations),
            f"height_{device_id}",
        )
        model.add_allowed_assignments([rotation, width, height], orientations)
        x = model.new_int_var(0, map_width, f"x_{device_id}")
        height_limit = box_height if device["charged"] else map_height
        y = model.new_int_var(0, height_limit, f"y_{device_id}")
        end_x = model.new_int_var(0, map_width, f"end_x_{device_id}")
        end_y = model.new_int_var(0, height_limit, f"end_y_{device_id}")
        model.add(end_x == x + width)
        model.add(end_y == y + height)
        x_intervals.append(
            model.new_interval_var(x, width, end_x, f"x_interval_{device_id}")
        )
        y_intervals.append(
            model.new_interval_var(y, height, end_y, f"y_interval_{device_id}")
        )
        variable = {
            "id": device_id,
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "rotation": rotation,
            "end_x": end_x,
            "end_y": end_y,
        }
        variables.append(variable)
        hint = device["hint"]
        if hint is not None and hint["rotation"] in rotations:
            model.add_hint(x, hint["x"])
            model.add_hint(y, hint["y"])
            model.add_hint(rotation, hint["rotation"])

    model.add_no_overlap_2d(x_intervals, y_intervals)
    minimum_x = model.new_int_var(0, map_width, "charged_min_x")
    maximum_x = model.new_int_var(0, map_width, "charged_max_x")
    charged = [v for d, v in zip(devices, variables) if d["charged"]]
    if not charged:
        raise ValueError("at least one charged rectangle is required")
    model.add_min_equality(minimum_x, [variable["x"] for variable in charged])
    model.add_max_equality(maximum_x, [variable["end_x"] for variable in charged])
    model.add(maximum_x - minimum_x <= box_width)
    add_hub_constraints(model, devices, variables)
    add_port_access(model, devices, variables, map_width, map_height)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_seconds
    solver.parameters.num_search_workers = 1
    # Recipe identities are outside this M1 placement model. Even OR-Tools'
    # inferred geometric label symmetry must not pin their positions.
    solver.parameters.symmetry_level = 0
    solver.parameters.random_seed = abs(seed) % (2**31 - 1)
    solver.parameters.randomize_search = True
    placements = []
    status = cp_model.UNKNOWN
    stopped_by = "total-budget"
    pose_variables = [v[key] for v in variables for key in ("x", "y", "rotation")]
    for candidate_index in range(candidate_count):
        remaining = max_seconds - (time.monotonic() - started)
        if remaining <= 0:
            break
        solver.parameters.max_time_in_seconds = remaining
        solver.parameters.random_seed = abs(seed + candidate_index) % (2**31 - 1)
        status = solver.solve(model)
        if status == cp_model.INFEASIBLE:
            stopped_by = "exhausted"
            break
        if status not in (cp_model.FEASIBLE, cp_model.OPTIMAL):
            break
        placement = [{"id": v["id"], **{key: solver.value(v[key])
                      for key in ("x", "y", "width", "height", "rotation")}}
                     for v in variables]
        placements.append(sorted(placement, key=lambda p: p["id"]))
        # Enumeration bookkeeping only: do not waste route attempts on the same
        # device poses with different unused-port masks or spanning trees.
        model.add_forbidden_assignments(pose_variables,
                                        [[solver.value(v) for v in pose_variables]])
        if len(placements) == candidate_count:
            stopped_by = "candidate-limit"
    elapsed_ms = round((time.monotonic() - started) * 1000)
    metadata = {
        "orToolsVersion": ortools.__version__,
        "attemptedCandidates": len(placements),
        "elapsedMs": elapsed_ms,
    }
    if placements:
        emit(
            "success",
            placements=placements,
            stoppedBy=stopped_by,
            **metadata,
        )
    elif status == cp_model.INFEASIBLE:
        emit("master-infeasible", stoppedBy="exhausted", **metadata)
    else:
        emit("unknown", stoppedBy="total-budget", **metadata)


try:
    solve(*parse_input())
except Exception as error:  # pragma: no cover - surfaced through the TS boundary
    emit("solver-failed", errorMessage=str(error))
