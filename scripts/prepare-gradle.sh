#!/usr/bin/env bash
#
# Makes the Gradle wrapper survive a flaky runner.
#
# `expo prebuild` regenerates gradle-wrapper.properties, so this runs after it
# rather than being committed. Two changes, both aimed at the same failure -
# a reset connection part-way through fetching the distribution:
#
#   * `-bin` instead of `-all`: the same Gradle without the sources and
#     documentation, which CI never opens. 220 MB becomes 132 MB.
#   * a network timeout with room to actually finish on a slow link.
set -euo pipefail

PROPS="${1:?usage: prepare-gradle.sh <path-to-gradle-wrapper.properties>}"
[ -f "$PROPS" ] || { echo "no wrapper properties at $PROPS"; exit 1; }

sed -i \
  -e 's|/distributions/gradle-\(.*\)-all\.zip|/distributions/gradle-\1-bin.zip|' \
  -e 's|^networkTimeout=.*|networkTimeout=120000|' \
  "$PROPS"

grep -q -- '-bin.zip' "$PROPS" || { echo "distributionUrl was not switched"; exit 1; }

echo "prepared $PROPS"
grep -E 'distributionUrl|networkTimeout' "$PROPS" | sed 's/^/  /'
