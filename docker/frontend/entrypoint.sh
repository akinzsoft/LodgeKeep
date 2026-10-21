#!/bin/sh
# Works out LANDING_HOSTS for the Caddyfile, then runs the command it was given (caddy run ...).
#
# The marketing landing page is for the EXACT bare host of every accepted app domain: APP_DOMAIN (the primary) and each
# entry of ADDITIONAL_APP_DOMAINS (comma-separated). A Caddy `host` matcher takes a space-separated list, so the comma
# list is split here. An entry that is not a plain host name (a scheme, port, path, wildcard, space, an empty label) is
# DROPPED, never repaired, so a typo can only narrow what matches. With nothing usable the list is
# `no-landing.invalid`, which can never match a real host.
set -eu

hosts=""
for entry in "${APP_DOMAIN:-}" $(printf '%s' "${ADDITIONAL_APP_DOMAINS:-}" | tr ',' ' '); do
  host=$(printf '%s' "$entry" | tr 'A-Z' 'a-z')
  case "$host" in
    "" | *[!a-z0-9.-]* | .* | *. | *..* | -* | *.-* | *-.*) continue ;;
  esac
  case " $hosts " in
    *" $host "*) continue ;;
  esac
  hosts="$hosts $host"
done

LANDING_HOSTS="${hosts# }"
export LANDING_HOSTS="${LANDING_HOSTS:-no-landing.invalid}"
exec "$@"
