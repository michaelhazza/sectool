#!/bin/sh
# Entrypoint wrapper for audit-tool container.
#
# Allows `docker run img npm run benchmark` and `docker run img node ...`
# to exec those commands directly, while `docker run img run --repo foo`
# (the default CLI usage) is transparently prepended with `node dist/cli.js`.
#
# Pass-through conditions: first arg is npm, node, sh, bash, or an absolute path.
case "$1" in
  npm|node|sh|bash|/*)
    exec "$@"
    ;;
  *)
    exec node dist/cli.js "$@"
    ;;
esac
