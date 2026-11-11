#!/bin/sh
cd "$(dirname "$0")"
python3 -m pip install -r requirements.txt
export BPS_HOST="${BPS_HOST:-0.0.0.0}"
export BPS_PORT="${BPS_PORT:-8080}"
echo "Starting http://127.0.0.1:${BPS_PORT}/  (LAN: this PC IP, port ${BPS_PORT})"
exec python3 server.py
