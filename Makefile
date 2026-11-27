.PHONY: help bootstrap build test test-rust lint license-check manifest-check compose-up compose-down compose-logs e2e sdk-check clean

PYTHON ?= $(shell if [ -x apps/inference-service/.venv/bin/python ]; then echo apps/inference-service/.venv/bin/python; else echo python3; fi)

help:
	@echo "synapseone make targets:"
	@echo "  bootstrap    - copy .env.example to .env + npm install all"
	@echo "  build        - build all node packages"
	@echo "  test         - run unit tests"
	@echo "  license-check - permissive license gate + SBOM/notices (npm, Cargo, Python, images)"
	@echo "  manifest-check - static K8s deployability gate (images/env/secrets/probes)"
	@echo "  compose-up   - docker compose up --build -d"
	@echo "  compose-down - docker compose down"
	@echo "  e2e          - run e2e smoke script"
	@echo "  sdk-check    - live SDK smoke (needs gateway at SYNAPSEONE_BASE_URL)"

bootstrap:
	cp -n .env.example .env || copy .env.example .env
	npm install --workspaces
	cd sdks/sdk-python && pip install -e . || true
	cd apps/inference-service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-models.txt -r ../lakehouse-service/requirements.txt || true

build:
	npm run build --workspaces --if-present

runner-image:
	docker build -f apps/workflow-runner/Dockerfile -t synapseone-workflow-runner:latest .

test:
	npm run test --workspaces --if-present

# The TypeScript suites above are the reference implementation. These are the
# Rust binaries that actually ship in the container images.
test-rust:
	for svc in ai-service base-service faststore-service gateway lds-service \
		notifications-service ocs-service queue-service stream-service warehouse-service; do \
		echo "== cargo test $$svc =="; \
		(cd apps/$$svc && cargo test --locked) || exit $$?; \
	done

lint:
	npm run lint --workspaces --if-present || true

license-check:
	node tools/license-check.cjs --bundle licenses --write-cargo-inventory third-party/cargo-inventory.json --require-python --python $(PYTHON) --python-expect fastapi,pyiceberg,requests

manifest-check:
	node tools/k8s-manifest-check.cjs

compose-up:
	docker compose --env-file .env up --build -d

compose-down:
	docker compose down

compose-logs:
	docker compose logs -f --tail=200

e2e:
	bash tests/e2e/smoke.sh || powershell -File tests/e2e/smoke.ps1
	bash tests/e2e/api-check.sh
	node tests/e2e/workflow-runner-e2e.mjs
	node tests/e2e/mcp-docs-e2e.mjs

sdk-check:
	node tests/e2e/sdk-check.js
	python tests/e2e/sdk-check.py || python3 tests/e2e/sdk-check.py

clean:
	docker compose down -v || true
	rm -rf apps/*/dist tools/*/dist sdks/sdk-js/dist apps/*/node_modules tools/*/node_modules sdks/sdk-js/node_modules node_modules || true
