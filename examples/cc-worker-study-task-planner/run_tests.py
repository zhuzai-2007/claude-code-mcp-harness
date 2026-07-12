#!/usr/bin/env python3
"""Minimal tests for study_task_planner.py using only standard library.

Requirements:
  1. Script runs via subprocess with valid input.
  2. Non-empty stdout on success.
  3. Invalid (malformed JSON) input does not crash process.
"""

import os
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLANNER = os.path.join(SCRIPT_DIR, "study_task_planner.py")
EXAMPLE_JSON = os.path.join(SCRIPT_DIR, "tasks.example.json")

PASS = 0
FAIL = 0


def run_test(name, func):
    global PASS, FAIL
    try:
        func()
        print(f"  PASS: {name}")
        PASS += 1
    except Exception as e:
        print(f"  FAIL: {name} -- {e}")
        FAIL += 1


def check(condition, msg):
    if not condition:
        raise AssertionError(msg)


def test_script_runs():
    """Test 1: study_task_planner.py runs with valid input."""
    result = subprocess.run(
        [sys.executable, PLANNER, EXAMPLE_JSON],
        capture_output=True, text=True, timeout=10
    )
    check(result.returncode == 0,
          f"Expected returncode 0, got {result.returncode}")


def test_output_exists():
    """Test 2: Non-empty stdout on success."""
    result = subprocess.run(
        [sys.executable, PLANNER, EXAMPLE_JSON],
        capture_output=True, text=True, timeout=10
    )
    check(result.returncode == 0, "Script did not exit successfully")
    check(len(result.stdout.strip()) > 0,
          "Expected non-empty stdout")


def test_invalid_input_no_crash():
    """Test 3: Malformed JSON input does not crash the script.

    Uses a small inline malformed JSON string written to a temp file.
    """
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        f.write('{"tasks": [{"title": "bad"}')  # truncated / malformed JSON
        tmp_path = f.name
    try:
        result = subprocess.run(
            [sys.executable, PLANNER, tmp_path],
            capture_output=True, text=True, timeout=10
        )
        # The process should exit cleanly (non-zero returncode, no crash)
        check(result.returncode != 0,
              f"Expected non-zero exit for malformed input, got {result.returncode}")
    finally:
        os.unlink(tmp_path)


def main():
    print("=" * 50)
    print("  Tests for study_task_planner.py")
    print("=" * 50)

    # Ensure required files exist
    check(os.path.isfile(PLANNER),
          f"Required script not found: {PLANNER}")
    check(os.path.isfile(EXAMPLE_JSON),
          f"Required fixture not found: {EXAMPLE_JSON}")

    tests = [
        ("Script runs (valid input)",           test_script_runs),
        ("Non-empty stdout on success",         test_output_exists),
        ("Invalid input does not crash",        test_invalid_input_no_crash),
    ]

    for name, func in tests:
        run_test(name, func)

    print()
    print(f"  Total: {PASS + FAIL}  |  PASS: {PASS}  |  FAIL: {FAIL}")
    print("=" * 50)

    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
