#!/usr/bin/env bash
# Start the full Traffic Armour harness with IPRoyal credentials.
# Usage: ./tooling/start-harness.sh [scenario-file] [port]

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCENARIO="${1:-$SCRIPT_DIR/scenarios/digitalserviceone-trivial-burst.yaml}"
PORT="${2:-7474}"
export IPROYAL_USER="${IPROYAL_USER:-iproyal1365}"
export IPROYAL_PASS=<set-in-environment>

echo "=== Traffic Armour Harness ==="
echo "Scenario: $SCENARIO"
echo "Dashboard port: $PORT"
echo "IPRoyal user: $IPROYAL_USER"
echo "Starting orchestrator..."
echo

cd "$SCRIPT_DIR/packages/orchestrator" && node dist/cli.js --scenario "$SCENARIO" --dashboard-port "$PORT" --no-mitm
