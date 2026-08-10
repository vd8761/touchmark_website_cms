/** Wire types for the content module, mirroring the API's snake_case shapes. */

export interface FieldDto {
  id: string;
  name: string;
  api_id: string;
  type: FieldTypeName;
  position: number;
  required: boolean;
  unique_value: boolean;
  localised: boolean;
  default_value: unknown;
  help_text: string | null;
  validation: Record<string, unknown>;
  config: {
    options?: { value: string; label?: string }[];
    /** Which content type a relation field points at, by api_id. */
    relationTypeApiId?: string;
  };
  group: string | null;
  deprecated: boolean;
}

export interface ContentTypeDto {
  id: string;
  name: string;
  api_id: string;
  description: string | null;
  kind: 'collection' | 'single';
  icon: string | null;
  has_slug: boolean;
  is_localised: boolean;
  enable_versioning: boolean;
  enable_scheduling: boolean;
  require_review: boolean;
  sort_order: number;
  schema_version: number;
  entry_count?: number;
  fields: FieldDto[];
  created_at: string;
}

export type EntryStatus =
  | 'draft'
  | 'in_review'
  | 'changes_requested'
  | 'scheduled'
  | 'published'
  | 'archived';

export interface EntryDto {
  id: string;
  type: string;
  slug: string | null;
  locale: string;
  status: EntryStatus;
  data: Record<string, unknown>;
  seo: Record<string, unknown>;
  published_at: string | null;
  scheduled_at: string | null;
  current_version: number;
  published_version: number | null;
  is_incomplete: boolean;
  has_unpublished_changes: boolean;
  author_id: string | null;
  locked_by: string | null;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface VersionDto {
  id: string;
  version: number;
  status_at_save: EntryStatus;
  change_note: string | null;
  was_published: boolean;
  created_at: string;
}

export type FieldTypeName =
  | 'text'
  | 'long_text'
  | 'rich_text'
  | 'markdown'
  | 'number'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'multi_enum'
  | 'slug'
  | 'url'
  | 'email'
  | 'colour'
  | 'json'
  | 'media'
  | 'media_list'
  | 'relation_one'
  | 'relation_many'
  | 'geo'
  | 'code';

/** The field-type picker of §17.6, grouped as the spec specifies. */
export const FIELD_TYPE_GROUPS: { group: string; types: { type: FieldTypeName; label: string; hint: string }[] }[] = [
  {
    group: 'Text',
    types: [
      { type: 'text', label: 'Text', hint: 'A single line' },
      { type: 'long_text', label: 'Long text', hint: 'Multiple lines, no formatting' },
      { type: 'rich_text', label: 'Rich text', hint: 'Formatted body content' },
      { type: 'markdown', label: 'Markdown', hint: 'Raw markdown source' },
      { type: 'slug', label: 'Slug', hint: 'URL-safe identifier' },
      { type: 'code', label: 'Code', hint: 'Preformatted source' },
    ],
  },
  {
    group: 'Number & date',
    types: [
      { type: 'number', label: 'Number', hint: 'Whole numbers' },
      { type: 'decimal', label: 'Decimal', hint: 'Fractional numbers' },
      { type: 'date', label: 'Date', hint: 'Day only, no time' },
      { type: 'datetime', label: 'Date & time', hint: 'Instant in time' },
    ],
  },
  {
    group: 'Choice',
    types: [
      { type: 'boolean', label: 'Toggle', hint: 'True or false' },
      { type: 'enum', label: 'Select', hint: 'One of a fixed list' },
      { type: 'multi_enum', label: 'Multi-select', hint: 'Several of a fixed list' },
    ],
  },
  {
    group: 'Media',
    types: [
      { type: 'media', label: 'Media', hint: 'One asset' },
      { type: 'media_list', label: 'Media list', hint: 'Several assets' },
    ],
  },
  {
    group: 'Relations',
    types: [
      { type: 'relation_one', label: 'Reference', hint: 'One other entry' },
      { type: 'relation_many', label: 'References', hint: 'Several other entries' },
    ],
  },
  {
    group: 'Advanced',
    types: [
      { type: 'email', label: 'Email', hint: 'Validated address' },
      { type: 'url', label: 'URL', hint: 'http or https only' },
      { type: 'colour', label: 'Colour', hint: 'Hex value' },
      { type: 'json', label: 'JSON', hint: 'Arbitrary structured data' },
      { type: 'geo', label: 'Coordinates', hint: 'Latitude and longitude' },
    ],
  },
];

export const STATUS_TONE: Record<EntryStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'accent'> = {
  draft: 'neutral',
  in_review: 'warning',
  changes_requested: 'danger',
  scheduled: 'accent',
  published: 'success',
  archived: 'neutral',
};

export const STATUS_LABEL: Record<EntryStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  scheduled: 'Scheduled',
  published: 'Published',
  archived: 'Archived',
};

/** The entry's display title: the first text-ish field with a value. */
export function entryTitle(entry: EntryDto, fields: FieldDto[]): string {
  for (const field of fields) {
    if (!['text', 'slug', 'long_text', 'markdown'].includes(field.type)) continue;
    const value = entry.data[field.api_id];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return entry.slug ?? 'Untitled';
}
