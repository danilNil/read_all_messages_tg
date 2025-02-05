#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Create PID file
echo $$ > "$SCRIPT_DIR/reader.pid"

# Activate virtual environment if it exists
if [ -d "$SCRIPT_DIR/venv" ]; then
    source "$SCRIPT_DIR/venv/bin/activate"
fi

# Function to clean up old log files (keep last 7 days)
cleanup_old_logs() {
    find "$SCRIPT_DIR" -name "telegram_reader_*.log" -type f -mtime +7 -delete
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
    exec nohup "$0" run >> "$SCRIPT_DIR/nohup.out" 2>&1 &
    echo "Started in background mode. PID: $!"
    echo $! > "$SCRIPT_DIR/reader.pid"
    exit 0
fi

# Main loop
if [[ "$1" == "run" ]]; then
    while true; do
        # Clean up old logs
        cleanup_old_logs
        
        # Run the Python script
        python "$SCRIPT_DIR/read_all.py"
        
        # Sleep for 1 hour (3600 seconds)
        sleep 3600
        
        echo "Running next iteration..."
    done
fi

# If no arguments provided, run in foreground
if [[ -z "$1" ]]; then
    "$0" run
fi 