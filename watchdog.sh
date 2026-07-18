#!/bin/bash
# Runs standalone (not tied to the assistant checking in) and checks every
# 10 minutes that each course's upload pipeline is actually making progress.
# Handles two distinct failure modes we've hit:
#   - dead: the run-until-done.sh wrapper itself isn't running (e.g. an
#     external kill took out the whole process tree) - just restart it.
#   - stuck: the wrapper is alive but its log hasn't grown since the last
#     check (e.g. a hung network call that never errors, never retries,
#     just sits there) - a process-exit-triggered restart alone wouldn't
#     catch this, so kill the inner node process; the wrapper's own loop
#     notices the exit and restarts it within 5s.
# Owns starting run-until-done.sh itself (redirected to a log file it can
# inspect) rather than watching tasks launched elsewhere, since it needs a
# log file path it controls to measure "did this make progress".
set -u
cd "$(dirname "$0")"

COURSES=(
  "listening_to_music_lectures listening-to-music-lectures"
  "marx_capital_lectures marx-capital-lectures"
)

LOG=watchdog.log
CHECK_INTERVAL=600

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG"
}

log "watchdog started (checking every ${CHECK_INTERVAL}s)"

# The system /bin/bash is 3.2 (no associative arrays) - track each course's
# last-seen log size in a small state file instead, named after its dir.
STATE_DIR=.watchdog_state
mkdir -p "$STATE_DIR"

start_wrapper() {
  local dir="$1" course_id="$2" log_file="$3"
  nohup ./run-until-done.sh "$dir" "$course_id" >> "$log_file" 2>&1 &
  disown
}

while true; do
  all_done=true

  for entry in "${COURSES[@]}"; do
    dir=$(echo "$entry" | cut -d' ' -f1)
    course_id=$(echo "$entry" | cut -d' ' -f2)
    log_file="${dir}.wrapper.log"
    state_file="${STATE_DIR}/${dir}.last_size"

    remaining=$(ls "$dir"/*.mp4 "$dir"/*.webm "$dir"/*.mkv 2>/dev/null | wc -l | tr -d ' ')

    if [ "$remaining" -eq 0 ]; then
      log "[$dir] complete, nothing left to do"
      continue
    fi

    all_done=false
    wrapper_pid=$(pgrep -f "run-until-done.sh $dir" | head -1)

    if [ -z "$wrapper_pid" ]; then
      log "[$dir] wrapper not running, $remaining lecture(s) remaining - starting it"
      start_wrapper "$dir" "$course_id" "$log_file"
      echo 0 > "$state_file"
      continue
    fi

    current_size=$(wc -c < "$log_file" 2>/dev/null || echo 0)
    prev_size=$(cat "$state_file" 2>/dev/null || echo 0)

    if [ "$current_size" -eq "$prev_size" ]; then
      log "[$dir] wrapper running (pid $wrapper_pid) but no new log output in ${CHECK_INTERVAL}s - stuck, killing the upload process so the wrapper auto-restarts it"
      pkill -f "node upload-yale-lectures.js $dir"
    else
      log "[$dir] progressing normally (pid $wrapper_pid), $remaining lecture(s) remaining"
    fi

    echo "$current_size" > "$state_file"
  done

  if [ "$all_done" = true ]; then
    log "all courses complete, watchdog exiting"
    break
  fi

  sleep "$CHECK_INTERVAL"
done
