/*
  Warnings:

  - You are about to drop the column `workspace_id` on the `jobs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "jobs" DROP COLUMN "workspace_id";
