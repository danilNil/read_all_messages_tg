# Automated Script Runner

This repository contains a script that automatically runs `read_all.py` every hour.

## Setup

1. Make sure you have Python installed on your system
2. The virtual environment is already set up in the `venv` directory
3. Ensure `read_all.py` is in the same directory as `run_hourly.sh`

## Usage

The `run_hourly.sh` script is designed to run `read_all.py` in an hourly interval. Here's how to use it:

1. Make sure the script is executable:
   ```bash
   chmod +x run_hourly.sh
   ```

2. Run the script:
   ```bash
   ./run_hourly.sh
   ```

   Or to run it in the background:
   ```bash
   ./run_hourly.sh &
   ```

## How it works

The script:
- Automatically finds its own directory location
- Activates the Python virtual environment if it exists
- Runs `read_all.py` immediately when started
- Sleeps for 1 hour (3600 seconds)
- Repeats this cycle until stopped

## Stopping the script

- If running in the foreground: Press `Ctrl+C`
- If running in the background: Find the process ID and kill it:
  ```bash
  ps aux | grep run_hourly.sh
  kill <process_id>
  ``` 