#!/usr/bin/env bash
# Cargo runner for macOS dev builds (see docs/development/macos-dev-signing.md).
# Signs the turing-core app binary with the stable local identity so Keychain
# "Always Allow" survives rebuilds, then runs the command unchanged. Every other
# case (test binaries, identity missing, codesign failure) just runs it.
set -u

IDENTITY="Turing Local Development"
BUNDLE_ID="dev.turingcore.ide"

if [ "$#" -gt 0 ] && [ "$(basename -- "$1")" = "turing-core" ] &&
  security find-identity -v -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY\""; then
  if ! codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" -- "$1" >/dev/null 2>&1; then
    echo "warning: dev-signing: codesign failed; running $1 unsigned (Keychain may prompt)" >&2
  fi
fi

exec "$@"
