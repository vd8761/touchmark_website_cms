-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('resend');

-- CreateEnum
CREATE TYPE "EmailConfigStatus" AS ENUM ('pending', 'active', 'invalid', 'disabled');

-- CreateEnum
CREATE TYPE "SenderIdentityStatus" AS ENUM ('pending', 'verified', 'failed', 'revoked');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "default_sender_identity_id" UUID,
ADD COLUMN     "email_configuration_id" UUID;

-- CreateTable
CREATE TABLE "email_configurations" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "EmailProvider" NOT NULL DEFAULT 'resend',
    "api_key_ciphertext" TEXT NOT NULL,
    "api_key_last_four" TEXT NOT NULL,
    "webhook_secret" TEXT NOT NULL,
    "webhook_last_event_at" TIMESTAMPTZ(6),
    "webhook_event_count" INTEGER NOT NULL DEFAULT 0,
    "status" "EmailConfigStatus" NOT NULL DEFAULT 'pending',
    "status_detail" TEXT,
    "verified_domains" JSONB NOT NULL DEFAULT '[]',
    "last_verified_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_identities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "email_configuration_id" UUID NOT NULL,
    "from_name" TEXT NOT NULL,
    "from_email" CITEXT NOT NULL,
    "reply_to_email" CITEXT,
    "status" "SenderIdentityStatus" NOT NULL DEFAULT 'pending',
    "status_detail" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sender_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_configurations_organisation_id_status_idx" ON "email_configurations"("organisation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "email_configurations_organisation_id_name_key" ON "email_configurations"("organisation_id", "name");

-- CreateIndex
CREATE INDEX "sender_identities_workspace_id_status_idx" ON "sender_identities"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sender_identities_workspace_id_from_email_key" ON "sender_identities"("workspace_id", "from_email");

-- AddForeignKey
ALTER TABLE "email_configurations" ADD CONSTRAINT "email_configurations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_identities" ADD CONSTRAINT "sender_identities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_identities" ADD CONSTRAINT "sender_identities_email_configuration_id_fkey" FOREIGN KEY ("email_configuration_id") REFERENCES "email_configurations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_email_configuration_id_fkey" FOREIGN KEY ("email_configuration_id") REFERENCES "email_configurations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
