#!/usr/bin/env bash
#
# Asserts the properties the Android app silently depends on.
#
# Each of these fails quietly at runtime rather than at build time: a missing
# config plugin turns lock-screen calls into ordinary banners, and missing
# cleartext permission makes every ws:// hub unreachable with no error the user
# would connect to the cause. Failing the build is the only way to notice.
#
#   scripts/check-android-manifest.sh <path-to-source-manifest> [path-to-apk]
set -euo pipefail

MANIFEST="${1:?usage: check-android-manifest.sh <manifest> [apk]}"
APK="${2:-}"
fail=0

require() {
  if grep -q "$1" "$MANIFEST"; then
    echo "  ok      $2"
  else
    echo "  MISSING $2"
    fail=1
  fi
}

echo "Checking $MANIFEST"
require 'android:showWhenLocked="true"'   'MainActivity may draw over the keyguard'
require 'android:turnScreenOn="true"'     'an incoming call wakes the screen'
require 'USE_FULL_SCREEN_INTENT'          'full-screen intent permission'
require 'usesCleartextTraffic="true"'     'ws:// to a LAN hub is permitted'

# `blockedPermissions` does not delete the entry - it marks it for the manifest
# merger to strip. So the line being present is expected; the line being present
# *without* that marker is the actual leak.
if grep -q 'RECORD_AUDIO' "$MANIFEST"; then
  if grep -q 'RECORD_AUDIO[^>]*tools:node="remove"' "$MANIFEST"; then
    echo "  ok      RECORD_AUDIO is marked for removal"
  else
    echo "  LEAKED  RECORD_AUDIO is requested and not marked for removal"
    fail=1
  fi
else
  echo "  ok      RECORD_AUDIO absent"
fi

# The merged manifest inside the APK is the only definitive answer, so check it
# too whenever a built APK is available.
if [ -n "$APK" ] && [ -f "$APK" ]; then
  # `|| true` matters: under `set -o pipefail` a failing find (no SDK present)
  # would abort the whole script instead of skipping the optional APK check.
  AAPT="$(find "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/nonexistent}}/build-tools" \
    -name aapt -type f 2>/dev/null | sort | tail -1 || true)"
  if [ -n "$AAPT" ]; then
    echo "Checking built APK $APK"
    PERMS="$("$AAPT" dump badging "$APK" | grep '^uses-permission' || true)"
    if echo "$PERMS" | grep -q 'RECORD_AUDIO'; then
      echo "  LEAKED  RECORD_AUDIO survived into the APK"
      fail=1
    else
      echo "  ok      RECORD_AUDIO absent from the shipped APK"
    fi
    for perm in INTERNET POST_NOTIFICATIONS VIBRATE USE_FULL_SCREEN_INTENT; do
      if echo "$PERMS" | grep -q "$perm"; then
        echo "  ok      $perm present"
      else
        echo "  MISSING $perm"
        fail=1
      fi
    done
  else
    echo "  note    aapt not found; skipped the APK check"
  fi
fi

exit "$fail"
