-- CreateEnum
CREATE TYPE "ContentTypeKind" AS ENUM ('collection', 'single');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('text', 'long_text', 'rich_text', 'markdown', 'number', 'decimal', 'boolean', 'date', 'datetime', 'enum', 'multi_enum', 'slug', 'url', 'email', 'colour', 'json', 'media', 'media_list', 'relation_one', 'relation_many', 'geo', 'code');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('draft', 'in_review', 'changes_requested', 'scheduled', 'published', 'archived');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('open', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "content_types" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "api_id" TEXT NOT NULL,
    "description" TEXT,
    "kind" "ContentTypeKind" NOT NULL DEFAULT 'collection',
    "icon" TEXT,
    "slug_field_id" UUID,
    "title_field_id" UUID,
    "has_slug" BOOLEAN NOT NULL DEFAULT true,
    "is_localised" BOOLEAN NOT NULL DEFAULT false,
    "enable_versioning" BOOLEAN NOT NULL DEFAULT true,
    "enable_scheduling" BOOLEAN NOT NULL DEFAULT true,
    "require_review" BOOLEAN NOT NULL DEFAULT false,
    "default_status" "EntryStatus" NOT NULL DEFAULT 'draft',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "content_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_fields" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_type_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "api_id" TEXT NOT NULL,
    "type" "FieldType" NOT NULL,
    "position" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "localised" BOOLEAN NOT NULL DEFAULT false,
    "unique_value" BOOLEAN NOT NULL DEFAULT false,
    "default_value" JSONB,
    "help_text" TEXT,
    "validation" JSONB NOT NULL DEFAULT '{}',
    "config" JSONB NOT NULL DEFAULT '{}',
    "group" TEXT,
    "deprecated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "content_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_type_id" UUID NOT NULL,
    "slug" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "translation_group_id" UUID NOT NULL,
    "status" "EntryStatus" NOT NULL DEFAULT 'draft',
    "data" JSONB NOT NULL DEFAULT '{}',
    "seo" JSONB NOT NULL DEFAULT '{}',
    "published_at" TIMESTAMPTZ(6),
    "scheduled_at" TIMESTAMPTZ(6),
    "unpublish_at" TIMESTAMPTZ(6),
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "published_version" INTEGER,
    "is_incomplete" BOOLEAN NOT NULL DEFAULT false,
    "author_id" UUID,
    "last_edited_by" UUID,
    "locked_by" UUID,
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "content_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "seo" JSONB NOT NULL DEFAULT '{}',
    "status_at_save" "EntryStatus" NOT NULL,
    "change_note" TEXT,
    "was_published" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "api_id" TEXT NOT NULL,
    "description" TEXT,
    "is_hierarchical" BOOLEAN NOT NULL DEFAULT false,
    "applies_to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "taxonomies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomy_terms" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "taxonomy_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "taxonomy_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_terms" (
    "entry_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,

    CONSTRAINT "entry_terms_pkey" PRIMARY KEY ("entry_id","term_id")
);

-- CreateTable
CREATE TABLE "menus" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "api_id" TEXT NOT NULL,
    "locale" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,
    "parent_id" UUID,
    "label" TEXT NOT NULL,
    "link_type" TEXT NOT NULL DEFAULT 'url',
    "entry_id" UUID,
    "term_id" UUID,
    "url" TEXT,
    "target" TEXT NOT NULL DEFAULT '_self',
    "icon" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "assigned_to" UUID,
    "status" "ReviewStatus" NOT NULL DEFAULT 'open',
    "comment" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "review_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_folders" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "media_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "folder_id" UUID,
    "filename" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "checksum" TEXT,
    "alt_text" TEXT,
    "alt_i18n" JSONB NOT NULL DEFAULT '{}',
    "caption" TEXT,
    "credit" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blurhash" TEXT,
    "variants" JSONB NOT NULL DEFAULT '[]',
    "uploaded_at" TIMESTAMPTZ(6),
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_usages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "field_api_id" TEXT NOT NULL,

    CONSTRAINT "media_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_types_workspace_id_sort_order_idx" ON "content_types"("workspace_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "content_types_workspace_id_api_id_key" ON "content_types"("workspace_id", "api_id");

-- CreateIndex
CREATE INDEX "content_fields_workspace_id_content_type_id_position_idx" ON "content_fields"("workspace_id", "content_type_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "content_fields_content_type_id_api_id_key" ON "content_fields"("content_type_id", "api_id");

-- CreateIndex
CREATE INDEX "content_entries_workspace_id_content_type_id_status_publish_idx" ON "content_entries"("workspace_id", "content_type_id", "status", "published_at" DESC);

-- CreateIndex
CREATE INDEX "content_entries_workspace_id_translation_group_id_idx" ON "content_entries"("workspace_id", "translation_group_id");

-- CreateIndex
CREATE INDEX "content_entries_status_scheduled_at_idx" ON "content_entries"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "content_entries_workspace_id_content_type_id_slug_locale_key" ON "content_entries"("workspace_id", "content_type_id", "slug", "locale");

-- CreateIndex
CREATE INDEX "content_versions_workspace_id_entry_id_version_idx" ON "content_versions"("workspace_id", "entry_id", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "content_versions_entry_id_version_key" ON "content_versions"("entry_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomies_workspace_id_api_id_key" ON "taxonomies"("workspace_id", "api_id");

-- CreateIndex
CREATE INDEX "taxonomy_terms_workspace_id_taxonomy_id_position_idx" ON "taxonomy_terms"("workspace_id", "taxonomy_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_terms_workspace_id_taxonomy_id_slug_key" ON "taxonomy_terms"("workspace_id", "taxonomy_id", "slug");

-- CreateIndex
CREATE INDEX "entry_terms_workspace_id_term_id_idx" ON "entry_terms"("workspace_id", "term_id");

-- CreateIndex
CREATE UNIQUE INDEX "menus_workspace_id_api_id_key" ON "menus"("workspace_id", "api_id");

-- CreateIndex
CREATE INDEX "menu_items_workspace_id_menu_id_position_idx" ON "menu_items"("workspace_id", "menu_id", "position");

-- CreateIndex
CREATE INDEX "review_requests_workspace_id_entry_id_status_idx" ON "review_requests"("workspace_id", "entry_id", "status");

-- CreateIndex
CREATE INDEX "review_requests_workspace_id_assigned_to_status_idx" ON "review_requests"("workspace_id", "assigned_to", "status");

-- CreateIndex
CREATE UNIQUE INDEX "media_folders_workspace_id_path_key" ON "media_folders"("workspace_id", "path");

-- CreateIndex
CREATE INDEX "media_assets_workspace_id_folder_id_created_at_idx" ON "media_assets"("workspace_id", "folder_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "media_assets_workspace_id_checksum_idx" ON "media_assets"("workspace_id", "checksum");

-- CreateIndex
CREATE INDEX "media_usages_workspace_id_entry_id_idx" ON "media_usages"("workspace_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_usages_asset_id_entry_id_field_api_id_key" ON "media_usages"("asset_id", "entry_id", "field_api_id");

-- AddForeignKey
ALTER TABLE "content_types" ADD CONSTRAINT "content_types_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_fields" ADD CONSTRAINT "content_fields_content_type_id_fkey" FOREIGN KEY ("content_type_id") REFERENCES "content_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_entries" ADD CONSTRAINT "content_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_entries" ADD CONSTRAINT "content_entries_content_type_id_fkey" FOREIGN KEY ("content_type_id") REFERENCES "content_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "content_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxonomies" ADD CONSTRAINT "taxonomies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxonomy_terms" ADD CONSTRAINT "taxonomy_terms_taxonomy_id_fkey" FOREIGN KEY ("taxonomy_id") REFERENCES "taxonomies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxonomy_terms" ADD CONSTRAINT "taxonomy_terms_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "taxonomy_terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_terms" ADD CONSTRAINT "entry_terms_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "content_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_terms" ADD CONSTRAINT "entry_terms_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "taxonomy_terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menus" ADD CONSTRAINT "menus_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "content_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "media_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "media_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_usages" ADD CONSTRAINT "media_usages_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
