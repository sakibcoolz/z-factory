# The local development stack (TASK-004, docs/bootstrap.md → Local stack): PostgreSQL and the
# process simulation service from compose.yaml, the Web Factory broker, and the Z-Factory and
# Web Factory dev servers. The work is done by scripts/dev-stack.sh.
#
#   make start | stop | restart | status        the whole stack
#   make start-app, make stop-web, ...           one part: db sim broker app web
#
# Ports: APP_PORT=3000 WEB_PORT=3200 BROKER_PORT=1883 PROCESS_SIM_PORT=7700, e.g.
# `make start APP_PORT=3001`. On a tailnet, `make serve` adds HTTPS: APP_HTTPS_PORT=443, WEB_HTTPS_PORT=8443.

STACK := scripts/dev-stack.sh
PARTS := db sim broker app web

export APP_PORT WEB_PORT BROKER_PORT PROCESS_SIM_PORT

.DEFAULT_GOAL := help
.PHONY: help setup start stop restart status migrate seed logs logs-app logs-web stop-runtimes serve unserve \
	$(foreach part,$(PARTS),start-$(part) stop-$(part) restart-$(part))

help: ## Show the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo "  start-<part>    Start one part: $(PARTS) (also stop-<part>, restart-<part>)"

setup: ## First run: install dependencies, start the stack, load the catalog
	npm ci
	cd apps/web-factory && npm ci
	@$(STACK) start db
	@$(STACK) seed
	@$(STACK) start

start: ## Start everything: db, sim, broker, app (:3000), web (:3200); applies migrations
	@$(STACK) start

stop: ## Stop everything except the factories' PLC runtime containers
	@$(STACK) stop

restart: ## Stop, then start everything
	@$(STACK) restart

status: ## Show what runs
	@$(STACK) status

migrate: ## Apply committed migrations to both databases
	@$(STACK) migrate

seed: ## Load the device catalog (safe to repeat)
	@$(STACK) seed

logs: ## Follow the dev servers' logs
	@$(STACK) logs

logs-app: ## Follow the Z-Factory dev server's log
	@$(STACK) logs app

logs-web: ## Follow the Web Factory dev server's log
	@$(STACK) logs web

stop-runtimes: ## Stop every PLC runtime container the factories started
	@$(STACK) stop-runtimes

serve: ## Serve both apps over HTTPS on the tailnet (once; Tailscale keeps it)
	@$(STACK) serve

unserve: ## Stop serving them on the tailnet
	@$(STACK) unserve

$(foreach part,$(PARTS),start-$(part)):
	@$(STACK) start $(patsubst start-%,%,$@)

$(foreach part,$(PARTS),stop-$(part)):
	@$(STACK) stop $(patsubst stop-%,%,$@)

$(foreach part,$(PARTS),restart-$(part)):
	@$(STACK) restart $(patsubst restart-%,%,$@)
