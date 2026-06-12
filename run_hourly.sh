#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
RUNNER_LOG="$SCRIPT_DIR/run_hourly.log"
INTERVAL_SECONDS="${READER_INTERVAL_SECONDS:-300}"

# Create PID file
echo $$ > "$SCRIPT_DIR/reader.pid"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $*"
}

# Use the project virtualenv directly when it exists.
if [ -x "$SCRIPT_DIR/venv/bin/python" ]; then
    PYTHON_BIN="$SCRIPT_DIR/venv/bin/python"
else
    PYTHON_BIN="$(command -v python3 || command -v python)"
fi

# Clean up old timestamped log files (script now uses single rotating telegram_reader.log)
cleanup_old_logs() {
    find "$SCRIPT_DIR" -name "telegram_reader_*.log" -type f -delete 2>/dev/null || true
}

# Cleanup function to remove PID file on exit
cleanup() {
    rm -f "$SCRIPT_DIR/reader.pid"
    exit 0
}

# Set trap for cleanup
trap cleanup EXIT SIGINT SIGTERM

# If running in background mode, redirect output to nohup.out
if [[ "$1" == "background" ]]; then
    nohup "$0" run >> "$RUNNER_LOG" 2>&1 &
    echo "Started in background mode. PID: $!"
    echo $! > "$SCRIPT_DIR/reader.pid"
    exit 0
fi

# Main loop
if [[ "$1" == "run" ]]; then
    while true; do
        # Clean up old logs
        cleanup_old_logs

        log "Starting iteration with Python: $PYTHON_BIN"
        
        # Run the Python script
        "$PYTHON_BIN" "$SCRIPT_DIR/read_all.py"
        exit_code=$?
        log "Iteration finished with exit code: $exit_code"
        
        log "Sleeping for $INTERVAL_SECONDS seconds"
        sleep "$INTERVAL_SECONDS"
        
        log "Running next iteration..."
    done
fi

# If no arguments provided, run in foreground
if [[ -z "$1" ]]; then
    "$0" run
fi 
