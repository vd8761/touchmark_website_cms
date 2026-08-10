CREATE TYPE "SubscriberStatus" AS ENUM ('subscribed', 'unsubscribed', 'bounced', 'complained');
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('active', 'disabled');
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'delivered', 'failed', 'dead_lettered');

CREATE TABLE "subscribers" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "email" CITEXT NOT NULL,
  "status" "SubscriberStatus" NOT NULL DEFAULT 'subscribed',
  "first_name" TEXT,
  "last_name" TEXT,
  "attributes" JSONB NOT NULL DEFAULT '{}',
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source" TEXT,
  "consent_at" TIMESTAMPTZ(6),
  "unsubscribed_at" TIMESTAMPTZ(6),
  "bounced_at" TIMESTAMPTZ(6),
  "complained_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "subscribers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscribers_workspace_id_email_key" ON "subscribers"("workspace_id", "email");
CREATE INDEX "subscribers_workspace_id_status_idx" ON "subscribers"("workspace_id", "status");
CREATE INDEX "subscribers_workspace_id_created_at_idx" ON "subscribers"("workspace_id", "created_at" DESC);

CREATE TABLE "audience_lists" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "api_id" TEXT NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "audience_lists_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "audience_lists_workspace_id_api_id_key" ON "audience_lists"("workspace_id", "api_id");
CREATE INDEX "audience_lists_workspace_id_deleted_at_idx" ON "audience_lists"("workspace_id", "deleted_at");

CREATE TABLE "subscriber_list_memberships" (
  "workspace_id" UUID NOT NULL,
  "subscriber_id" UUID NOT NULL,
  "list_id" UUID NOT NULL,
  "subscribed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unsubscribed_at" TIMESTAMPTZ(6),
  CONSTRAINT "subscriber_list_memberships_pkey" PRIMARY KEY ("subscriber_id", "list_id")
);

CREATE INDEX "subscriber_list_memberships_workspace_id_list_id_idx"
  ON "subscriber_list_memberships"("workspace_id", "list_id");
CREATE INDEX "subscriber_list_memberships_workspace_id_subscriber_id_idx"
  ON "subscriber_list_memberships"("workspace_id", "subscriber_id");

CREATE TABLE "forms" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "list_id" UUID,
  "name" TEXT NOT NULL,
  "api_id" TEXT NOT NULL,
  "description" TEXT,
  "schema" JSONB NOT NULL DEFAULT '[]',
  "success_message" TEXT NOT NULL DEFAULT 'Thanks - you''re on the list.',
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "forms_workspace_id_api_id_key" ON "forms"("workspace_id", "api_id");
CREATE INDEX "forms_workspace_id_is_enabled_idx" ON "forms"("workspace_id", "is_enabled");

CREATE TABLE "form_submissions" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "form_id" UUID NOT NULL,
  "subscriber_id" UUID,
  "email" CITEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "ip" INET,
  "user_agent" TEXT,
  "referrer" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "form_submissions_workspace_id_form_id_created_at_idx"
  ON "form_submissions"("workspace_id", "form_id", "created_at" DESC);
CREATE INDEX "form_submissions_workspace_id_subscriber_id_idx"
  ON "form_submissions"("workspace_id", "subscriber_id");

CREATE TABLE "preview_tokens" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "entry_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "preview_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "preview_tokens_token_hash_key" ON "preview_tokens"("token_hash");
CREATE INDEX "preview_tokens_workspace_id_entry_id_expires_at_idx"
  ON "preview_tokens"("workspace_id", "entry_id", "expires_at");
CREATE INDEX "preview_tokens_expires_at_idx" ON "preview_tokens"("expires_at");

CREATE TABLE "webhook_endpoints" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "secret_ciphertext" TEXT NOT NULL,
  "secret_last_four" TEXT NOT NULL,
  "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'active',
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "last_success_at" TIMESTAMPTZ(6),
  "last_failure_at" TIMESTAMPTZ(6),
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_endpoints_workspace_id_name_key"
  ON "webhook_endpoints"("workspace_id", "name");
CREATE INDEX "webhook_endpoints_workspace_id_status_idx"
  ON "webhook_endpoints"("workspace_id", "status");

CREATE TABLE "webhook_deliveries" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "webhook_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6),
  "delivered_at" TIMESTAMPTZ(6),
  "request_headers" JSONB,
  "response_status" INTEGER,
  "response_body" TEXT,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_deliveries_workspace_id_status_next_attempt_at_idx"
  ON "webhook_deliveries"("workspace_id", "status", "next_attempt_at");
CREATE INDEX "webhook_deliveries_workspace_id_webhook_id_created_at_idx"
  ON "webhook_deliveries"("workspace_id", "webhook_id", "created_at" DESC);
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries"("event_id");

ALTER TABLE "subscribers"
  ADD CONSTRAINT "subscribers_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "audience_lists"
  ADD CONSTRAINT "audience_lists_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscriber_list_memberships"
  ADD CONSTRAINT "subscriber_list_memberships_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscriber_list_memberships"
  ADD CONSTRAINT "subscriber_list_memberships_subscriber_id_fkey"
  FOREIGN KEY ("subscriber_id") REFERENCES "subscribers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscriber_list_memberships"
  ADD CONSTRAINT "subscriber_list_memberships_list_id_fkey"
  FOREIGN KEY ("list_id") REFERENCES "audience_lists"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "forms"
  ADD CONSTRAINT "forms_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "forms"
  ADD CONSTRAINT "forms_list_id_fkey"
  FOREIGN KEY ("list_id") REFERENCES "audience_lists"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "form_submissions"
  ADD CONSTRAINT "form_submissions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "form_submissions"
  ADD CONSTRAINT "form_submissions_form_id_fkey"
  FOREIGN KEY ("form_id") REFERENCES "forms"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "form_submissions"
  ADD CONSTRAINT "form_submissions_subscriber_id_fkey"
  FOREIGN KEY ("subscriber_id") REFERENCES "subscribers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "preview_tokens"
  ADD CONSTRAINT "preview_tokens_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "preview_tokens"
  ADD CONSTRAINT "preview_tokens_entry_id_fkey"
  FOREIGN KEY ("entry_id") REFERENCES "content_entries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_endpoints"
  ADD CONSTRAINT "webhook_endpoints_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey"
  FOREIGN KEY ("webhook_id") REFERENCES "webhook_endpoints"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
