#!/bin/sh
# macOS·Linux: 두 번 누르거나 sh start.command
cd "$(dirname "$0")" && node scripts/ctl.mjs start
