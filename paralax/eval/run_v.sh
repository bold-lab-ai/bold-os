#!/bin/zsh
# Usage: eval/run_v.sh <run-name> [extra args]   (humans flash-lite, assistants + selection flash, problem never given to assistants)
cd "$(dirname "$0")/.."
export PARALAX_ENV=~/Paralax/.env
export PARALAX_MODELS="gemini-3.5-flash,gemini-3.8-flash"
export PARALAX_SELECT_MODELS="gemini-3.5-flash,gemini-3.8-flash"
export PARALAX_SELECT_CAP_SECS=30
export PARALAX_SELECT_HEDGE_SECS=8
export PARALAX_HUMAN_MODELS="gemini-3.5-flash-lite"
exec python3 -W ignore eval_hidden.py run --run "$@"
