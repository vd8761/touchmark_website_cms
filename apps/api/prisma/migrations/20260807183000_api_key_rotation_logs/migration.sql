ALTER TABLE "api_keys"
  ADD COLUMN "rate_limit_per_minute" INTEGER,
  ADD COLUMN "rotated_from_id" UUID,
  ADD COLUMN "rotated_to_id" UUID,
  ADD COLUMN "rotation_grace_ends_at" TIMESTAMPTZ(6);

CREATE INDEX "api_keys_workspace_id_rotated_from_id_idx"
  ON "api_keys"("workspace_id", "rotated_from_id");

CREATE TABLE "api_request_logs" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "api_key_id" UUID,
  "method" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "status_code" INTEGER NOT NULL,
  "error_code" TEXT,
  "ip" INET,
  "origin" TEXT,
  "user_agent" TEXT,
  "duration_ms" INTEGER NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "api_request_logs_workspace_id_occurred_at_idx"
  ON "api_request_logs"("workspace_id", "occurred_at" DESC);
CREATE INDEX "api_request_logs_workspace_id_api_key_id_occurred_at_idx"
  ON "api_request_logs"("workspace_id", "api_key_id", "occurred_at" DESC);
CREATE INDEX "api_request_logs_api_key_id_occurred_at_idx"
  ON "api_request_logs"("api_key_id", "occurred_at" DESC);

ALTER TABLE "api_request_logs"
  ADD CONSTRAINT "api_request_logs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "api_request_logs"
  ADD CONSTRAINT "api_request_logs_api_key_id_fkey"
  FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
