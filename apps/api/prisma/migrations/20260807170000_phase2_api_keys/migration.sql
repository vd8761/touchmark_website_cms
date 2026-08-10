CREATE TYPE "ApiKeyType" AS ENUM ('publishable', 'secret');
CREATE TYPE "ApiKeyEnvironment" AS ENUM ('live', 'test');
CREATE TYPE "ApiKeyStatus" AS ENUM ('active', 'revoked');

CREATE TABLE "api_keys" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "type" "ApiKeyType" NOT NULL,
  "environment" "ApiKeyEnvironment" NOT NULL DEFAULT 'live',
  "key_hash" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "key_last_four" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "allowed_origins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "allowed_ips" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expires_at" TIMESTAMPTZ(6),
  "status" "ApiKeyStatus" NOT NULL DEFAULT 'active',
  "last_used_at" TIMESTAMPTZ(6),
  "usage_count" INTEGER NOT NULL DEFAULT 0,
  "revoked_at" TIMESTAMPTZ(6),
  "revoked_by" UUID,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE UNIQUE INDEX "api_keys_workspace_id_name_key" ON "api_keys"("workspace_id", "name");
CREATE INDEX "api_keys_workspace_id_status_idx" ON "api_keys"("workspace_id", "status");
CREATE INDEX "api_keys_workspace_id_type_environment_idx" ON "api_keys"("workspace_id", "type", "environment");

ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
