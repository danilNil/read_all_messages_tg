#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Activate virtual environment if it exists
if [ -d "$SCRIPT_DIR/venv" ]; then
    source "$SCRIPT_DIR/venv/bin/activate"
fi

# Function to clean up old log files (keep last 7 days)
cleanup_old_logs() {
    find "$SCRIPT_DIR" -name "telegram_reader_*.log" -type f -mtime +7 -delete
}

while true; do
    # Clean up old logs
    cleanup_old_logs
    
    # Run the Python script
    python "$SCRIPT_DIR/read_all.py"
    
    # Sleep for 1 hour (3600 seconds)
    sleep 3600
    
    echo "Running next iteration..."
done 