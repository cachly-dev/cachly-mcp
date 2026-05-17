.PHONY: up down build logs ps health smoke migrate migrate-history backup deploy setup-env drip-dry drip-run shell-backend shell-db restart-backend caddy-reload

up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

health:
	bash scripts/health-check.sh

smoke:
	bash scripts/smoke-test.sh

migrate:
	docker compose exec backend alembic upgrade head

migrate-history:
	docker compose exec backend alembic history

backup:
	docker compose --profile backup run --rm backup

deploy:
	bash scripts/deploy.sh

setup-env:
	bash scripts/configure-env.sh

drip-dry:
	curl -s -u "$$(grep ADMIN_USER .env | cut -d= -f2):$$(grep ADMIN_PASSWORD .env | cut -d= -f2)" \
	  -X POST "http://localhost:8000/admin/drip/run?dry_run=true" | python3 -m json.tool

drip-run:
	curl -s -u "$$(grep ADMIN_USER .env | cut -d= -f2):$$(grep ADMIN_PASSWORD .env | cut -d= -f2)" \
	  -X POST "http://localhost:8000/admin/drip/run" | python3 -m json.tool

shell-backend:
	docker compose exec backend bash

shell-db:
	docker compose exec postgres psql -U tco -d tco

restart-backend:
	docker compose restart backend

caddy-reload:
	docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
