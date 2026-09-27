#!/usr/bin/env bash
set -euo pipefail

# Creates an isolated DB/user on an existing Postgres instance (via docker exec postgres_db).
# Usage: GMM_DB_PASSWORD='...' ./deploy/setup-postgres.sh

: "${GMM_DB_PASSWORD:?Set GMM_DB_PASSWORD}"

PSQL=(docker exec -i postgres_db psql -U xiaote -d xiaote -v ON_ERROR_STOP=1)

role_exists="$("${PSQL[@]}" -tAc "SELECT 1 FROM pg_roles WHERE rolname='group_message_mgr'")"
if [[ "${role_exists}" != "1" ]]; then
  "${PSQL[@]}" -c "CREATE USER group_message_mgr WITH PASSWORD '${GMM_DB_PASSWORD}';"
  echo "Created role group_message_mgr"
else
  echo "Role group_message_mgr already exists"
fi

db_exists="$("${PSQL[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname='group_message_manager'")"
if [[ "${db_exists}" != "1" ]]; then
  "${PSQL[@]}" -c "CREATE DATABASE group_message_manager OWNER group_message_mgr;"
  echo "Created database group_message_manager"
else
  echo "Database group_message_manager already exists"
fi

"${PSQL[@]}" -c "GRANT ALL PRIVILEGES ON DATABASE group_message_manager TO group_message_mgr;"
