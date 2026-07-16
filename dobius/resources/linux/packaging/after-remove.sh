#!/bin/bash
# Why: remove the PATH symlink that after-install.sh created, but only if it
# still points into an Dobius install dir — never delete an unrelated
# /usr/bin/dobius a user or other package may own.
set -e

link="/usr/bin/dobius"

if [ -L "$link" ]; then
  target="$(readlink "$link" || true)"
  case "$target" in
    /opt/Dobius/*|/opt/dobius-ide/*|/opt/dobius/*)
      rm -f "$link"
      ;;
  esac
fi

exit 0
