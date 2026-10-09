#!/usr/bin/env bash
# The local development stack (TASK-004, docs/bootstrap.md → Local stack). The Makefile is
# the usual way in: `make start`, `make stop`, `make restart`, `make status`.
#
#   scripts/dev-stack.sh <start|stop|restart|status> [all|db|sim|broker|app|web]
#   scripts/dev-stack.sh migrate | seed | logs [app|web] | stop-runtimes | serve | unserve
#
# Parts, in start order:
#   db      PostgreSQL from compose.yaml (both apps' databases)
#   sim     the process simulation service from compose.yaml (profile "sim")
#   broker  Mosquitto with Dynamic Security for Web Factory (container web-factory-broker)
#   app     the Z-Factory dev server (http://localhost:3000)
#   web     the Web Factory dev server (http://localhost:3200)
#
# The dev servers run in the background; their PID files and logs are in .run/. Secrets the
# stack needs are made once into git-ignored files and never printed: .run/process-sim-token
# (unless PROCESS_SIM_TOKEN is set or in .env) and apps/web-factory/mqtt-admin-password.
#
# On a tailnet, `serve` publishes both dev servers over HTTPS with Tailscale's certificates:
# Z-Factory on https://<machine>.<tailnet>.ts.net and Web Factory on port 8443. Tailscale
# keeps that setting until `unserve`. The dev servers accept the tailnet name and address.
#
# Stop leaves the factories' PLC runtime containers alone: "Stop factory" in the app stops
# them and keeps the stored states right. `stop-runtimes` stops them all behind the app.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
RUN_DIR=$ROOT/.run
WEB_DIR=$ROOT/apps/web-factory

APP_PORT=${APP_PORT:-3000}
WEB_PORT=${WEB_PORT:-3200}
SIM_PORT=${PROCESS_SIM_PORT:-7700}
BROKER_NAME=${BROKER_NAME:-web-factory-broker}
BROKER_PORT=${BROKER_PORT:-1883}
BROKER_IMAGE=${BROKER_IMAGE:-eclipse-mosquitto:2}
BROKER_VOLUME=${BROKER_NAME}-data
BROKER_PASSWORD_FILE=$WEB_DIR/mqtt-admin-password
APP_HTTPS_PORT=${APP_HTTPS_PORT:-443}
WEB_HTTPS_PORT=${WEB_HTTPS_PORT:-8443}

say() { printf '  %-7s %s\n' "$1" "$2"; }
fail() {
  say "$1" "$2" >&2
  exit 1
}

# A value from a dotenv file, without surrounding quotes; empty when it is not there.
env_value() {
  [[ -f $1 ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Creates a secret file once, readable by its owner only.
secret_file() {
  mkdir -p "$(dirname "$1")"
  if [[ ! -s $1 ]]; then (umask 077 && openssl rand -hex 24 >"$1"); fi
}

# The process simulation token: the environment, then .env, then a generated one.
sim_token() {
  local token=${PROCESS_SIM_TOKEN:-$(env_value .env PROCESS_SIM_TOKEN)}
  if [[ -z $token ]]; then
    secret_file "$RUN_DIR/process-sim-token"
    token=$(<"$RUN_DIR/process-sim-token")
  fi
  printf '%s' "$token"
}

compose() { PROCESS_SIM_TOKEN=$(sim_token) docker compose "$@"; }

container_state() {
  local state
  state=$(docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null) || true
  printf '%s\n' "${state:-absent}"
}

# Runs a command quietly; shows its output only when it fails.
quiet() {
  local output
  if ! output=$("$@" 2>&1); then
    printf '%s\n' "$output" >&2
    return 1
  fi
}

# --- tailnet --------------------------------------------------------------------------------

# This machine's tailnet name (without the trailing dot); empty off a tailnet.
tailnet_name() {
  command -v tailscale >/dev/null || return 0
  tailscale status --self --json 2>/dev/null |
    sed -n 's/^\s*"DNSName": "\([^"]*\)\.",\{0,1\}$/\1/p' | head -n 1
}

# Origins besides localhost that may load the dev servers' resources (hot reload and the like).
dev_origins() {
  local origins=${DEV_ALLOWED_ORIGINS:-} name address
  name=$(tailnet_name)
  if [[ -n $name ]]; then
    address=$(tailscale ip -4 2>/dev/null | head -n 1)
    origins=${origins:+$origins,}$name${address:+,$address}
  fi
  printf '%s' "$origins"
}

serve() {
  local name output
  name=$(tailnet_name)
  [[ -n $name ]] || fail tailnet "Tailscale is not running here, so there is nothing to serve on"
  for pair in "$APP_HTTPS_PORT:$APP_PORT" "$WEB_HTTPS_PORT:$WEB_PORT"; do
    # Until HTTPS is enabled for the tailnet, tailscale serve prints where to enable it and waits.
    if ! output=$(timeout 15 tailscale serve --bg --https="${pair%%:*}" "http://127.0.0.1:${pair##*:}" 2>&1); then
      printf '%s\n' "$output" >&2
      fail tailnet "not served; see docs/bootstrap.md → Local stack → HTTPS on the tailnet"
    fi
  done
  status_tailnet
}

unserve() {
  [[ -n $(tailnet_name) ]] || fail tailnet "Tailscale is not running here"
  for port in "$APP_HTTPS_PORT" "$WEB_HTTPS_PORT"; do tailscale serve --https="$port" off >/dev/null 2>&1 || true; done
  say tailnet "not served"
}

status_tailnet() {
  local name served
  name=$(tailnet_name)
  [[ -n $name ]] || return 0
  served=$(tailscale serve status 2>/dev/null)
  local https=":$APP_HTTPS_PORT"
  [[ $APP_HTTPS_PORT == 443 ]] && https=""
  if grep -q "127.0.0.1:$APP_PORT" <<<"$served"; then
    say tailnet "app https://$name$https"
  fi
  if grep -q "127.0.0.1:$WEB_PORT" <<<"$served"; then
    say tailnet "web https://$name:$WEB_HTTPS_PORT"
  fi
  grep -qE "127.0.0.1:($APP_PORT|$WEB_PORT)" <<<"$served" || say tailnet "not served (make serve)"
}

# --- dev servers --------------------------------------------------------------------------

port_in_use() { [[ -n $(ss -ltnH "sport = :$1" 2>/dev/null) ]]; }

server_pid() {
  local pidfile=$RUN_DIR/$1.pid
  [[ -f $pidfile ]] && kill -0 "$(<"$pidfile")" 2>/dev/null && cat "$pidfile"
}

# Starts a dev server in its own session, so stopping it stops everything it spawned.
start_server() {
  local name=$1 dir=$2 port=$3
  shift 3
  local pid log=$RUN_DIR/$name.log
  if pid=$(server_pid "$name"); then
    say "$name" "already running (pid $pid), http://localhost:$port"
    return
  fi
  if port_in_use "$port"; then
    fail "$name" "port $port is in use by another process; not started (stop it, or set ${name^^}_PORT)"
  fi
  mkdir -p "$RUN_DIR"
  rm -f "$RUN_DIR/$name.pid"
  # A detached session leader that writes its own PID, then becomes the server: nothing here
  # keeps the caller's terminal or pipe open, and the PID is the session's process group.
  (cd "$dir" && setsid --fork bash -c 'echo $$ >"$0" && exec "$@"' "$RUN_DIR/$name.pid" "$@" \
    >"$log" 2>&1 </dev/null)
  for _ in $(seq 1 10); do
    [[ -s $RUN_DIR/$name.pid ]] && break
    sleep 0.2
  done
  pid=$(<"$RUN_DIR/$name.pid")
  for _ in $(seq 1 90); do
    if port_in_use "$port"; then
      say "$name" "running (pid $pid), http://localhost:$port, log .run/$name.log"
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$RUN_DIR/$name.pid"
      tail -n 20 "$log" >&2
      fail "$name" "exited while starting; see .run/$name.log"
    fi
    sleep 1
  done
  fail "$name" "did not listen on port $port within 90 s; see .run/$name.log"
}

stop_server() {
  local name=$1 port=$2 pid
  if ! pid=$(server_pid "$name"); then
    rm -f "$RUN_DIR/$name.pid"
    if port_in_use "$port"; then
      say "$name" "not started by this script; port $port is held by another process, left alone"
    else
      say "$name" "not running"
    fi
    return
  fi
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null || true
  rm -f "$RUN_DIR/$name.pid"
  say "$name" "stopped"
}

server_status() {
  local name=$1 port=$2 pid
  if pid=$(server_pid "$name"); then
    say "$name" "running (pid $pid), http://localhost:$port"
  elif port_in_use "$port"; then
    say "$name" "port $port is held by a process this script did not start"
  else
    say "$name" "stopped"
  fi
}

# --- parts --------------------------------------------------------------------------------

start_db() {
  quiet compose up -d --wait postgres || fail db "PostgreSQL did not start"
  say db "running, 127.0.0.1:${POSTGRES_PORT:-5432}"
}
stop_db() {
  quiet compose stop postgres
  say db "stopped (data kept in the postgres-data volume)"
}
status_db() { say db "$(container_state z-factory-dev-postgres-1)"; }

start_sim() {
  quiet compose --profile sim up -d --wait process-sim || fail sim "the process simulation service did not start"
  say sim "running, http://127.0.0.1:$SIM_PORT"
}
stop_sim() {
  quiet compose --profile sim stop process-sim
  say sim "stopped"
}
status_sim() { say sim "$(container_state z-factory-dev-process-sim-1)"; }

start_broker() {
  secret_file "$BROKER_PASSWORD_FILE"
  case $(container_state "$BROKER_NAME") in
    running) ;;
    absent)
      # The admin password is read on the first start only; Dynamic Security keeps it in the volume.
      docker run -d --name "$BROKER_NAME" --label zfactory.dev-stack=broker \
        -e MOSQUITTO_DYNSEC_PASSWORD="$(<"$BROKER_PASSWORD_FILE")" \
        -p "127.0.0.1:$BROKER_PORT:1883" \
        -v "$WEB_DIR/broker/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
        -v "$BROKER_VOLUME:/mosquitto/data" \
        "$BROKER_IMAGE" >/dev/null
      ;;
    *) docker start "$BROKER_NAME" >/dev/null ;;
  esac
  say broker "running, mqtt://127.0.0.1:$BROKER_PORT"
}
stop_broker() {
  [[ $(container_state "$BROKER_NAME") == running ]] && docker stop "$BROKER_NAME" >/dev/null
  say broker "stopped"
}
status_broker() { say broker "$(container_state "$BROKER_NAME")"; }

start_app() {
  # The server reaches the process simulation service with the same token the container got.
  PROCESS_SIM_URL=${PROCESS_SIM_URL:-$(env_value .env PROCESS_SIM_URL)}
  PROCESS_SIM_TOKEN=$(sim_token)
  export PROCESS_SIM_URL=${PROCESS_SIM_URL:-http://127.0.0.1:$SIM_PORT} PROCESS_SIM_TOKEN
  DEV_ALLOWED_ORIGINS=$(dev_origins)
  export DEV_ALLOWED_ORIGINS
  start_server app "$ROOT" "$APP_PORT" "$ROOT/node_modules/.bin/next" dev -p "$APP_PORT"
}
stop_app() { stop_server app "$APP_PORT"; }
status_app() { server_status app "$APP_PORT"; }

start_web() {
  # Web Factory talks to the broker above unless its .env says otherwise.
  local file=$WEB_DIR/.env
  WEB_FACTORY_MQTT_URL=${WEB_FACTORY_MQTT_URL:-$(env_value "$file" WEB_FACTORY_MQTT_URL)}
  WEB_FACTORY_MQTT_USERNAME=${WEB_FACTORY_MQTT_USERNAME:-$(env_value "$file" WEB_FACTORY_MQTT_USERNAME)}
  WEB_FACTORY_MQTT_PASSWORD_FILE=${WEB_FACTORY_MQTT_PASSWORD_FILE:-$(env_value "$file" WEB_FACTORY_MQTT_PASSWORD_FILE)}
  export WEB_FACTORY_MQTT_URL=${WEB_FACTORY_MQTT_URL:-mqtt://127.0.0.1:$BROKER_PORT}
  export WEB_FACTORY_MQTT_USERNAME=${WEB_FACTORY_MQTT_USERNAME:-admin}
  export WEB_FACTORY_MQTT_PASSWORD_FILE=${WEB_FACTORY_MQTT_PASSWORD_FILE:-$BROKER_PASSWORD_FILE}
  DEV_ALLOWED_ORIGINS=$(dev_origins)
  export DEV_ALLOWED_ORIGINS
  start_server web "$WEB_DIR" "$WEB_PORT" "$WEB_DIR/node_modules/.bin/next" dev -p "$WEB_PORT"
}
stop_web() { stop_server web "$WEB_PORT"; }
status_web() { server_status web "$WEB_PORT"; }

# --- whole stack --------------------------------------------------------------------------

migrate() {
  (cd "$ROOT" && quiet npx prisma migrate deploy) || fail db "Z-Factory migrations failed"
  (cd "$WEB_DIR" && quiet npx prisma migrate deploy) || fail db "Web Factory migrations failed"
  say db "migrations applied (Z-Factory and Web Factory)"
}

seed() {
  (cd "$ROOT" && quiet npx prisma db seed) || fail db "seeding failed"
  say db "catalog seeded"
}

stop_runtimes() {
  local ids
  ids=$(docker ps -q --filter label=zfactory.managed=true)
  if [[ -z $ids ]]; then
    say plcs "no PLC runtime container is running"
    return
  fi
  # shellcheck disable=SC2086 # one id per word
  docker stop $ids >/dev/null
  say plcs "stopped $(wc -w <<<"$ids") PLC runtime container(s); the app shows their factories as before until each is stopped or refreshed there"
}

status_runtimes() {
  say plcs "$(docker ps -q --filter label=zfactory.managed=true | wc -l) PLC runtime container(s) running"
}

PARTS=(db sim broker app web)

for_parts() {
  local action=$1 target=$2 part
  if [[ $target == all ]]; then
    if [[ $action == stop ]]; then
      for ((i = ${#PARTS[@]} - 1; i >= 0; i--)); do "stop_${PARTS[i]}"; done
    else
      for part in "${PARTS[@]}"; do
        "${action}_$part"
        [[ $action == start && $part == db ]] && migrate
      done
    fi
    [[ $action == status ]] && status_runtimes && status_tailnet
    return 0
  fi
  [[ " ${PARTS[*]} " == *" $target "* ]] || fail "$target" "unknown part; one of: all ${PARTS[*]}"
  "${action}_$target"
  [[ $action == start && $target == db ]] && migrate
  return 0
}

command=${1:-status}
target=${2:-all}
case $command in
  start | stop | status) for_parts "$command" "$target" ;;
  restart)
    for_parts stop "$target"
    for_parts start "$target"
    ;;
  migrate) migrate ;;
  seed) seed ;;
  stop-runtimes) stop_runtimes ;;
  serve) serve ;;
  unserve) unserve ;;
  logs)
    [[ $target == all ]] && files=("$RUN_DIR"/*.log) || files=("$RUN_DIR/$target.log")
    exec tail -n 40 -F "${files[@]}"
    ;;
  *) fail "$command" "unknown command; one of: start stop restart status migrate seed logs stop-runtimes serve unserve" ;;
esac
