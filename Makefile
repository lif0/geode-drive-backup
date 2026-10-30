.DEFAULT_GOAL := help
.NOTPARALLEL:

NODE ?= node
NPM ?= npm

.PHONY: help check-node install update check build dev audit

help:
	@printf '%s\n' \
	  'make install  Install the tested versions from package-lock.json' \
	  'make update   Update compatible dependencies, build, test and audit' \
	  'make check    Build, run tests and recovery vectors, then audit' \
	  'make build    Build main.js (includes typecheck, lint and tests)' \
	  'make dev      Watch source files and rebuild main.js' \
	  'make audit    Check all dependencies for known vulnerabilities' \
	  '' \
	  'Node: use nvm install && nvm use (reads .nvmrc) before installation.'

# No npm dependencies are needed for this check. Reject unsupported Node before
# changing package-lock.json or node_modules, including the non-LTS Node 23.
check-node:
	@$(NODE) -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!((major === 22 && minor >= 13) || major === 24 || major === 26)) { console.error("Unsupported Node " + process.version + ". Use Node 22.13+, 24.x or 26.x. With nvm: nvm install && nvm use"); process.exit(1); }'

install: check-node
	$(NPM) ci

# npm update respects package.json ranges. Major upgrades are deliberate changes
# to package.json; audit fix --force can downgrade packages into vulnerable trees.
update: check-node
	$(NPM) update
	$(MAKE) check

check: check-node
	$(NPM) run build
	$(NPM) run verify:vectors
	$(NPM) audit

build: check-node
	$(NPM) run build

dev: check-node
	$(NPM) run dev

audit: check-node
	$(NPM) audit
