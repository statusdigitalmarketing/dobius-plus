#!/bin/bash
# Notarizes a file, surviving what stopped the 2.2.2 release: a dropped connection after
# the upload, and a submission that sat "In Progress" for hours at Apple while a fresh
# copy of the same file cleared in 2 minutes. Exits 0 only once Apple says Accepted.
# Needs APPLE_ID, APPLE_TEAM_ID and APPLE_APP_SPECIFIC_PASSWORD in the environment.
# Timings can be overridden for the test.
set -uo pipefail
FILE="$1"
POLL_SECONDS="${NOTARIZE_POLL_SECONDS:-60}"
RESUBMIT_AFTER_POLLS="${NOTARIZE_RESUBMIT_AFTER_POLLS:-20}"
MAX_POLLS="${NOTARIZE_MAX_POLLS:-120}"
RETRY_SECONDS="${NOTARIZE_RETRY_SECONDS:-30}"
auth=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD")

submit() {
  local id
  for i in 1 2 3; do
    id="$(xcrun notarytool submit "$FILE" "${auth[@]}" --no-wait --output-format json 2>/dev/null \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])' 2>/dev/null)"
    if [ -n "$id" ]; then echo "$id"; return 0; fi
    echo "Upload to Apple failed (try $i), trying again in ${RETRY_SECONDS}s..." >&2
    sleep "$RETRY_SECONDS"
  done
  return 1
}

status_of() {
  local s
  s="$(xcrun notarytool info "$1" "${auth[@]}" --output-format json 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)"
  echo "${s:-no answer}"
}

first="$(submit)" || { echo "ERROR: could not upload to Apple after 3 tries." >&2; exit 1; }
ids=("$first")
echo "Submitted: $first"
for ((poll = 1; poll <= MAX_POLLS; poll += 1)); do
  line=""
  for id in "${ids[@]}"; do
    s="$(status_of "$id")"
    line="$line ${id:0:8}=$s"
    case "$s" in
      Accepted) echo "$(date +%H:%M:%S)$line"; echo "Accepted: $id"; exit 0 ;;
      Invalid|Rejected)
        echo "$(date +%H:%M:%S)$line"
        xcrun notarytool log "$id" "${auth[@]}" >&2
        echo "ERROR: Apple refused the file ($s)." >&2
        exit 1 ;;
    esac
  done
  echo "$(date +%H:%M:%S)$line"
  if (( poll % RESUBMIT_AFTER_POLLS == 0 )); then
    if next="$(submit)"; then ids+=("$next"); echo "Still processing, submitted a fresh copy too: $next"; fi
  fi
  sleep "$POLL_SECONDS"
done
echo "STOPPED: Apple answered but is still processing after $MAX_POLLS checks." >&2
exit 1
