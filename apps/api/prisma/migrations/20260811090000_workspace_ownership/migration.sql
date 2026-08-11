-- Site ownership (§6.3 transfer).
--
-- `created_by` is history and must not move, so ownership gets its own column.
-- Existing sites are backfilled from their creator, which is who has been
-- acting as owner all along.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "owner_id" UUID;

-- Backfill: the creator is the incumbent owner.
UPDATE "workspaces" SET "owner_id" = "created_by" WHERE "owner_id" IS NULL;

-- CreateIndex
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces"("owner_id");

-- AddForeignKey
ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
