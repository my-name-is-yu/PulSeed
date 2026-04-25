#!/usr/bin/env python3
import json
import sys
from pathlib import Path


def score_key(item):
    score = item["cv_score"]
    return score if item["direction"] == "maximize" else -score


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: compare_experiments.py <metrics.json> [...]", file=sys.stderr)
        return 2
    metrics = [json.loads(Path(arg).read_text()) for arg in sys.argv[1:]]
    if not metrics:
        print("no metrics", file=sys.stderr)
        return 1
    directions = {item["direction"] for item in metrics}
    metric_names = {item["metric_name"] for item in metrics}
    if len(directions) != 1 or len(metric_names) != 1:
        print("all experiments must share metric_name and direction", file=sys.stderr)
        return 1
    ranked = sorted(metrics, key=score_key, reverse=True)
    for index, item in enumerate(ranked, start=1):
        print(f"{index}. {item['experiment_id']} {item['metric_name']}={item['cv_score']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

