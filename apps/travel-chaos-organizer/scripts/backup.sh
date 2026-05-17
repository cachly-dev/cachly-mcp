#!/bin/sh
# pg_dump backup script — run via: docker compose --profile backup run --rm backup
set -e

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DEST="/backups/tco_${TIMESTAMP}.sql.gz"

echo "Starting backup to $DEST ..."
pg_dump -h postgres -U tco -d tco | gzip > "$DEST"
echo "Backup complete: $DEST"

# Keep last 30 backups, delete older ones
cd /backups && ls -t tco_*.sql.gz | tail -n +31 | xargs -r rm --
echo "Old backups pruned. Done."
