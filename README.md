# Automated Script Runner

This repository contains a script that automatically runs `read_all.py` every hour.

## Setup

1. Make sure you have Python installed on your system
2. The virtual environment is already set up in the `venv` directory
3. Ensure `read_all.py` is in the same directory as `run_hourly.sh`
4. Create a `.env` file with your Telegram credentials:
   ```bash
   API_ID=your_api_id
   API_HASH=your_api_hash
   PHONE_NUMBER=your_phone_number
   ```
   Never commit this file to git!

5. Install required packages:
   ```bash
   source venv/bin/activate  # Activate virtual environment
   pip install -r requirements.txt
   ```

## Usage

The `run_hourly.sh` script is designed to run `read_all.py` in an hourly interval. Here's how to use it:

1. Make sure the script is executable:
   ```bash
   chmod +x run_hourly.sh
   ```

2. Run the script:
   
   For foreground execution:
   ```bash
   ./run_hourly.sh
   ```

   For background execution (recommended):
   ```bash
   ./run_hourly.sh background
   ```

   The background mode will:
   - Keep running even after terminal is closed
   - Write runner output to `run_hourly.log` in the script directory
   - Create a PID file for process management

## How it works

The script:
- Automatically finds its own directory location
- Creates a PID file (`reader.pid`) for process tracking
- Uses `venv/bin/python` directly when it exists
- Runs `read_all.py` immediately when started
- Writes Telegram reader logs to `telegram_reader.log` with rotation to `telegram_reader.log.1` and `telegram_reader.log.2`
- Removes old timestamped logs from the previous logging setup
- Sleeps for 1 hour (3600 seconds)
- Repeats this cycle until stopped


## Process Management

### Checking Status
To check if the script is running:

View the process ID
cat reader.pid
Check if the process is active
ps -p $(cat reader.pid)

## Stopping the script

You can stop the script in several ways:

1. Using the PID file (recommended):
   ```bash
   kill $(cat reader.pid)
   ```

2. Using process search (alternative):
   ```bash
   ps aux | grep run_hourly.sh
   kill <process_id>
   ```

3. If running in the foreground:
   - Press `Ctrl+C`

The script will clean up its PID file automatically when stopped.

## Status UI

This project also includes a small local Node.js UI for checking and controlling the reader.

Run it manually:

```bash
npm start
```

Open `http://127.0.0.1:3000`.

The UI shows whether the hourly reader is running, whether Telegram has unread non-archived dialogs, and provides start/stop/restart controls for `run_hourly.sh`.

For macOS autostart through `launchd`, see `docs/status-ui.md`.
