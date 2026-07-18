#!/bin/bash
# Re-invokes upload-yale-lectures.js until the source dir has no video files
# left. upload-yale-lectures.js is idempotent (HeadObject-checks S3 before
# doing any work), so it's always safe to just re-run it after it dies -
# whether from a transient network drop or an external kill, this loop
# means nobody has to notice and manually restart it.
set -u
DIR="$1"
COURSE_ID="$2"

while true; do
  remaining=$(ls "$DIR"/*.mp4 "$DIR"/*.webm "$DIR"/*.mkv 2>/dev/null | wc -l | tr -d ' ')
  if [ "$remaining" -eq 0 ]; then
    echo "[$DIR] all lectures uploaded, nothing left to do"
    break
  fi
  echo "[$DIR] $remaining lecture(s) remaining, (re)starting upload..."
  rm -f "$DIR"/.transcoded/*
  node upload-yale-lectures.js "$DIR" "$COURSE_ID"
  echo "[$DIR] upload process exited, re-checking in 5s..."
  sleep 5
done
