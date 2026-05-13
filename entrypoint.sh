#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command
  exec bun run dist/main.js auth
else
  # Default command. v0.8 changed the default bind from 0.0.0.0 to 127.0.0.1
  # for safety; inside a container that would break docker -p port forwarding.
  # Force --host 0.0.0.0 unless the caller already supplied their own --host.
  case " $* " in
    *" --host "*) ;;
    *) set -- --host 0.0.0.0 "$@" ;;
  esac
  exec bun run dist/main.js start -g "$GH_TOKEN" "$@"
fi

