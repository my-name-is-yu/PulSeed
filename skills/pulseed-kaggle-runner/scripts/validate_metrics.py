#!/usr/bin/env python3
import json
import sys
from pathlib import Path

REQUIRED = {
    "experiment_id",
    "competition",
    "metric_name",
    "direction",
    "cv_score",
    "cv_std",
    "holdout_score",
    "train_rows",
    "valid_rows",
    "seed",
    "created_at",
    "status",
    "artifacts",
}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_metrics.py <metrics.json>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    data = json.loads(path.read_text())
    missing = sorted(REQUIRED - set(data))
    if missing:
        print(f"missing fields: {', '.join(missing)}", file=sys.stderr)
        return 1
    if data["direction"] not in {"maximize", "minimize"}:
        print("direction must be maximize or minimize", file=sys.stderr)
        return 1
    if not isinstance(data["cv_score"], (int, float)):
        print("cv_score must be numeric", file=sys.stderr)
        return 1
    print(f"valid metrics: {data['experiment_id']} {data['metric_name']}={data['cv_score']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

