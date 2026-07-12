#!/usr/bin/env python3
"""Study Task Planner - a CLI tool that reads tasks JSON and outputs sorted tasks."""

import json
import sys
import os


def load_tasks(filepath):
    with open(filepath, 'r') as f:
        data = json.load(f)
    if not isinstance(data, dict) or 'tasks' not in data:
        raise ValueError("Invalid format: JSON must have a 'tasks' key")
    tasks = data['tasks']
    if not isinstance(tasks, list):
        raise ValueError("Invalid format: 'tasks' must be a list")
    for t in tasks:
        if 'priority' not in t or 'title' not in t:
            raise ValueError("Each task must have 'title' and 'priority' fields")
    return tasks


def sort_tasks(tasks):
    priority_map = {'high': 1, 'medium': 2, 'low': 3}
    return sorted(tasks, key=lambda t: priority_map.get(t['priority'].lower(), 99))


def main():
    if len(sys.argv) < 2:
        print("Usage: study_task_planner.py <input.json>", file=sys.stderr)
        sys.exit(1)

    filepath = sys.argv[1]

    if not os.path.exists(filepath):
        print(f"Error: File not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    try:
        tasks = load_tasks(filepath)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    sorted_tasks = sort_tasks(tasks)

    print(json.dumps({"sorted_tasks": sorted_tasks}, indent=2))


if __name__ == '__main__':
    main()
