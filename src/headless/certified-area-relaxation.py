#!/usr/bin/env python3
"""Certified Area Relaxation v1: mandatory rectangles, bounds, rotations, and NoOverlap2D only."""

import json
import math
import platform
import sys
import time


PROFILE = "certified-area-relaxation-v1"
OBJECTIVE = "horizontal-span-times-origin-anchored-height"


def emit(status, **fields):
    json.dump({
        "constraintProfile": PROFILE,
        "objective": OBJECTIVE,
        "status": status,
        "pythonVersion": platform.python_version(),
        **fields,
    }, sys.stdout, separators=(",", ":"))


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
        "constraintProfile", "objective", "devices", "limitWidth", "limitHeight",
        "allowRotate", "maxSeconds",
    }
    unexpected_keys = sorted(set(data) - allowed_keys)
    if unexpected_keys:
        raise ValueError(f"unsupported proof-model fields: {','.join(unexpected_keys)}")
    if data.get("constraintProfile") != PROFILE:
        raise ValueError("unexpected certified relaxation profile")
    if data.get("objective") != OBJECTIVE:
        raise ValueError("unexpected certified relaxation objective")
    devices = data.get("devices")
    if not isinstance(devices, list) or not devices:
        raise ValueError("devices must be a non-empty array")
    normalized_devices = []
    seen_ids = set()
    for index, device in enumerate(devices):
        if not isinstance(device, dict):
            raise ValueError(f"devices[{index}] must be an object")
        unexpected_device_keys = sorted(set(device) - {"id", "width", "height"})
        if unexpected_device_keys:
            raise ValueError(
                f"unsupported device proof fields: {','.join(unexpected_device_keys)}"
            )
        device_id = device.get("id")
        if not isinstance(device_id, str) or not device_id or device_id in seen_ids:
            raise ValueError(f"invalid or duplicate device ID at index {index}")
        seen_ids.add(device_id)
        normalized_devices.append({
            "id": device_id,
            "width": positive_integer(device.get("width"), f"{device_id}.width"),
            "height": positive_integer(device.get("height"), f"{device_id}.height"),
        })
    limit_width = positive_integer(data.get("limitWidth"), "limitWidth")
    limit_height = positive_integer(data.get("limitHeight"), "limitHeight")
    allow_rotate = data.get("allowRotate")
    if type(allow_rotate) is not bool:
        raise ValueError("allowRotate must be a boolean")
    max_seconds = data.get("maxSeconds")
    if isinstance(max_seconds, bool) or not isinstance(max_seconds, (int, float)) \
            or not math.isfinite(max_seconds) or max_seconds <= 0 or max_seconds > 30:
        raise ValueError("maxSeconds must be in (0, 30]")
    maximum_area = limit_width * limit_height
    if maximum_area >= 2 ** 62:
        raise ValueError("certified area domain exceeds the supported int64 range")
    return normalized_devices, limit_width, limit_height, allow_rotate, float(max_seconds)


def solve(devices, limit_width, limit_height, allow_rotate, max_seconds):
    model = cp_model.CpModel()
    variables = []
    x_intervals = []
    y_intervals = []
    for device in devices:
        device_id = device["id"]
        base_width = device["width"]
        base_height = device["height"]
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
            min(base_width, base_height), max(base_width, base_height), f"width_{device_id}"
        )
        height = model.new_int_var(
            min(base_width, base_height), max(base_width, base_height), f"height_{device_id}"
        )
        model.add_allowed_assignments([rotation, width, height], orientations)
        x = model.new_int_var(0, limit_width, f"x_{device_id}")
        y = model.new_int_var(0, limit_height, f"y_{device_id}")
        end_x = model.new_int_var(0, limit_width, f"end_x_{device_id}")
        end_y = model.new_int_var(0, limit_height, f"end_y_{device_id}")
        model.add(end_x == x + width)
        model.add(end_y == y + height)
        x_intervals.append(model.new_interval_var(x, width, end_x, f"x_interval_{device_id}"))
        y_intervals.append(model.new_interval_var(y, height, end_y, f"y_interval_{device_id}"))
        variables.append({"x": x, "end_x": end_x, "end_y": end_y})

    model.add_no_overlap_2d(x_intervals, y_intervals)
    minimum_x = model.new_int_var(0, limit_width, "minimum_x")
    maximum_x = model.new_int_var(0, limit_width, "maximum_x")
    maximum_y = model.new_int_var(0, limit_height, "maximum_y")
    model.add_min_equality(minimum_x, [entry["x"] for entry in variables])
    model.add_max_equality(maximum_x, [entry["end_x"] for entry in variables])
    model.add_max_equality(maximum_y, [entry["end_y"] for entry in variables])
    span_width = model.new_int_var(0, limit_width, "span_width")
    model.add(span_width == maximum_x - minimum_x)
    area = model.new_int_var(0, limit_width * limit_height, "area")
    model.add_multiplication_equality(area, [span_width, maximum_y])
    model.minimize(area)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_seconds
    solver.parameters.num_search_workers = 1
    status = solver.solve(model)
    if status == cp_model.MODEL_INVALID:
        return {"status": "solver-failed"}
    if status == cp_model.INFEASIBLE:
        return {"status": "infeasible"}

    status_name = "optimal" if status == cp_model.OPTIMAL \
        else "feasible" if status == cp_model.FEASIBLE \
        else "unknown"
    response = solver.response_proto
    exact_lower_bound = int(response.inner_objective_lower_bound)
    raw_lower_bound = float(solver.best_objective_bound)
    if not math.isfinite(raw_lower_bound) \
            or abs(raw_lower_bound - exact_lower_bound) > 1e-6:
        raise RuntimeError("unit integer objective bound lost its exact representation")
    result = {
        "status": status_name,
        "rawBestObjectiveBound": raw_lower_bound,
        "certifiedIntegerLowerBound": exact_lower_bound,
    }
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        incumbent = int(solver.value(area))
        if exact_lower_bound > incumbent:
            raise RuntimeError("certified lower bound exceeds the master incumbent")
        if status == cp_model.OPTIMAL and exact_lower_bound != incumbent:
            raise RuntimeError("optimal status did not close the master objective gap")
        result["masterIncumbentArea"] = incumbent
    return result


def main():
    started_at = time.monotonic()
    try:
        devices, limit_width, limit_height, allow_rotate, max_seconds = parse_input()
        result = solve(devices, limit_width, limit_height, allow_rotate, max_seconds)
        emit(
            result.pop("status"),
            orToolsVersion=ortools.__version__,
            elapsedMs=round((time.monotonic() - started_at) * 1000),
            **result,
        )
    except Exception as error:
        emit(
            "solver-failed",
            orToolsVersion=ortools.__version__,
            elapsedMs=round((time.monotonic() - started_at) * 1000),
            errorMessage=str(error)[:2000],
        )


if __name__ == "__main__":
    main()
