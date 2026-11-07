#!/bin/zsh
set -eu
cd -- "${0:A:h}"
exec python3 server.py --dev --open --port 8784
