#!/bin/bash
set -e

echo "=== AKATSUKI Setup ==="

if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

echo "Activating venv..."
source venv/bin/activate

echo "Installing dependencies..."
pip install -r requirements.txt

mkdir -p data

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Set these environment variables before running:"
echo "  export DATABASE_URL='postgresql://user:pass@localhost:5432/akatsuki'"
echo "  export SESSION_SECRET='your-secret-key-here'"
echo ""
echo "Run with:"
echo "  source venv/bin/activate"
echo "  uvicorn main:app --host 0.0.0.0 --port 5000 --loop uvloop"
echo ""
echo "Or for systemd service, see kotak-scalper.service"
