import type { FieldType } from '@prisma/client';

import {
  type FieldDefinition,
  isSafeTypeChange,
  validateEntry,
} from './field-validation';

function field(partial: Partial<FieldDefinition> & { apiId: string; type: FieldType }): FieldDefinition {
  return {
    name: partial.apiId,
    required: false,
    uniqueValue: false,
    localised: false,
    validation: {},
    config: {},
    ...partial,
  };
}

describe('validateEntry', () => {
  describe('draft versus publish strictness', () => {
    const fields = [field({ apiId: 'title', type: 'text', required: true, name: 'Title' })];

    it('lets an incomplete draft save', () => {
      // Authors must never lose work because a required field is not filled yet.
      const result = validateEntry(fields, {}, { requireRequired: false });
      expect(result.valid).toBe(true);
    });

    it('blocks publishing an incomplete entry', () => {
      const result = validateEntry(fields, {}, { requireRequired: true });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({ field: 'title', code: 'required' });
    });
  });

  it('drops unknown keys rather than storing them', () => {
    // Otherwise the jsonb column accumulates fields no schema describes, which
    // then leak into Delivery API responses and become an accidental contract.
    const result = validateEntry([field({ apiId: 'title', type: 'text' })], {
      title: 'Hello',
      rogue: 'should not persist',
    });

    expect(result.data).toEqual({ title: 'Hello' });
  });

  it('distinguishes "not supplied" from "explicitly cleared"', () => {
    const fields = [field({ apiId: 'a', type: 'text' }), field({ apiId: 'b', type: 'text' })];
    const result = validateEntry(fields, { b: null });

    expect('a' in result.data).toBe(false); // untouched
    expect(result.data.b).toBeNull(); // deliberately cleared
  });

  it('passes deprecated field values through untouched', () => {
    // §7.1: a deprecated field is hidden from the editor but still served, so
    // deprecation must never destroy data.
    const fields = [field({ apiId: 'legacy', type: 'text', deprecatedAt: new Date() })];
    const result = validateEntry(fields, { legacy: 'old value' }, { requireRequired: true });

    expect(result.valid).toBe(true);
    expect(result.data.legacy).toBe('old value');
  });

  it('does not demand a value for a deprecated required field', () => {
    const fields = [
      field({ apiId: 'legacy', type: 'text', required: true, deprecatedAt: new Date() }),
    ];
    expect(validateEntry(fields, {}, { requireRequired: true }).valid).toBe(true);
  });

  describe('type coercion and rejection', () => {
    it('rejects a non-integer for a number field', () => {
      const result = validateEntry([field({ apiId: 'n', type: 'number', name: 'Count' })], { n: 1.5 });
      expect(result.errors[0].message).toMatch(/whole number/);
    });

    it('accepts a decimal for a decimal field', () => {
      expect(validateEntry([field({ apiId: 'n', type: 'decimal' })], { n: 1.5 }).data.n).toBe(1.5);
    });

    it('enforces min and max', () => {
      const fields = [field({ apiId: 'n', type: 'number', validation: { min: 1, max: 10 } })];
      expect(validateEntry(fields, { n: 0 }).valid).toBe(false);
      expect(validateEntry(fields, { n: 11 }).valid).toBe(false);
      expect(validateEntry(fields, { n: 5 }).valid).toBe(true);
    });

    it('normalises slugs and rejects malformed ones', () => {
      const fields = [field({ apiId: 's', type: 'slug' })];
      expect(validateEntry(fields, { s: 'Hello-World' }).data.s).toBe('hello-world');
      expect(validateEntry(fields, { s: 'not a slug!' }).valid).toBe(false);
    });

    it('lowercases emails and rejects invalid ones', () => {
      const fields = [field({ apiId: 'e', type: 'email' })];
      expect(validateEntry(fields, { e: 'Someone@Acme.COM' }).data.e).toBe('someone@acme.com');
      expect(validateEntry(fields, { e: 'not-an-email' }).valid).toBe(false);
    });

    it('rejects javascript: and data: URLs', () => {
      // These would be rendered by the consuming site and become an XSS vector
      // there — the CMS is the right place to stop them.
      const fields = [field({ apiId: 'u', type: 'url' })];
      expect(validateEntry(fields, { u: 'javascript:alert(1)' }).valid).toBe(false);
      expect(validateEntry(fields, { u: 'data:text/html,<script>' }).valid).toBe(false);
      expect(validateEntry(fields, { u: 'https://acme.com/x' }).valid).toBe(true);
    });

    it('stores a date field without a time component', () => {
      // A stored timestamp would shift across timezones and land on the wrong
      // day for a date-only value.
      const result = validateEntry([field({ apiId: 'd', type: 'date' })], {
        d: '2026-03-15T23:30:00Z',
      });
      expect(result.data.d).toBe('2026-03-15');
    });

    it('requires a rich-text document root', () => {
      const fields = [field({ apiId: 'body', type: 'rich_text' })];
      expect(validateEntry(fields, { body: '<p>html</p>' }).valid).toBe(false);
      expect(validateEntry(fields, { body: { type: 'doc', content: [] } }).valid).toBe(true);
    });

    it('validates enum values against the configured options', () => {
      const fields = [
        field({
          apiId: 'status',
          type: 'enum',
          config: { options: [{ value: 'a' }, { value: 'b' }] },
        }),
      ];
      expect(validateEntry(fields, { status: 'a' }).valid).toBe(true);
      expect(validateEntry(fields, { status: 'z' }).valid).toBe(false);
    });

    it('de-duplicates multi_enum values', () => {
      const fields = [
        field({ apiId: 'tags', type: 'multi_enum', config: { options: [{ value: 'x' }, { value: 'y' }] } }),
      ];
      expect(validateEntry(fields, { tags: ['x', 'x', 'y'] }).data.tags).toEqual(['x', 'y']);
    });

    it('enforces item counts on lists', () => {
      const fields = [
        field({ apiId: 'imgs', type: 'media_list', validation: { maxItems: 2 }, name: 'Images' }),
      ];
      expect(validateEntry(fields, { imgs: ['a', 'b', 'c'] }).valid).toBe(false);
      expect(validateEntry(fields, { imgs: ['a', 'b'] }).valid).toBe(true);
    });

    it('rejects out-of-range coordinates', () => {
      const fields = [field({ apiId: 'g', type: 'geo' })];
      expect(validateEntry(fields, { g: { lat: 12, lng: 77 } }).valid).toBe(true);
      expect(validateEntry(fields, { g: { lat: 200, lng: 77 } }).valid).toBe(false);
    });
  });

  it('reports every failing field, not just the first', () => {
    // A form that surfaces one error at a time makes the user submit repeatedly.
    const fields = [
      field({ apiId: 'a', type: 'number', name: 'A' }),
      field({ apiId: 'b', type: 'email', name: 'B' }),
    ];
    const result = validateEntry(fields, { a: 'nope', b: 'also nope' });

    expect(result.errors.map((e) => e.field).sort()).toEqual(['a', 'b']);
  });
});

describe('isSafeTypeChange', () => {
  it('allows the widenings the spec names', () => {
    // §7.1: "Only for safe widenings (text→long_text, number→decimal)."
    expect(isSafeTypeChange('text', 'long_text')).toBe(true);
    expect(isSafeTypeChange('number', 'decimal')).toBe(true);
  });

  it('refuses narrowing and unrelated changes', () => {
    expect(isSafeTypeChange('long_text', 'text')).toBe(false);
    expect(isSafeTypeChange('decimal', 'number')).toBe(false);
    expect(isSafeTypeChange('text', 'number')).toBe(false);
    expect(isSafeTypeChange('rich_text', 'text')).toBe(false);
  });

  it('treats a no-op change as safe', () => {
    expect(isSafeTypeChange('text', 'text')).toBe(true);
  });

  it('allows single→multi widenings, which never invalidate a stored value', () => {
    expect(isSafeTypeChange('media', 'media_list')).toBe(true);
    expect(isSafeTypeChange('relation_one', 'relation_many')).toBe(true);
    expect(isSafeTypeChange('media_list', 'media')).toBe(false);
  });
});
