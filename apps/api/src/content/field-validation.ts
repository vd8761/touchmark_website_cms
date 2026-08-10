import type { FieldType } from '@prisma/client';
import type { FieldError } from '@cms/shared';

/**
 * Validates an entry's `data` jsonb against its content type's field
 * definitions (§4.2: the Content service "validates against schema").
 *
 * Pure and dependency-free on purpose: the same rules have to run in the API on
 * save, in the Delivery API when serving, and eventually in the portal for
 * inline feedback. Anything that reaches for the database belongs in the
 * service, not here.
 *
 * Two levels of strictness, because they answer different questions:
 *   * `validateEntry(..., { requireRequired: false })` — "can this be saved as a
 *     draft?" A half-finished draft must always be saveable, or authors lose
 *     work.
 *   * `requireRequired: true` — "can this be published?" Everything must be
 *     present and well-formed.
 */

export interface FieldDefinition {
  apiId: string;
  name: string;
  type: FieldType;
  required: boolean;
  uniqueValue: boolean;
  localised: boolean;
  validation: FieldValidation;
  config: FieldConfig;
  deprecatedAt?: Date | null;
}

export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  regex?: string;
  regexMessage?: string;
  allowedValues?: string[];
  maxItems?: number;
  minItems?: number;
}

export interface FieldConfig {
  options?: { value: string; label?: string }[];
  relationTypeApiId?: string;
  multiple?: boolean;
  accept?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: FieldError[];
  /** Values coerced to their canonical form — what should actually be stored. */
  data: Record<string, unknown>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function validateEntry(
  fields: FieldDefinition[],
  data: Record<string, unknown>,
  options: { requireRequired: boolean } = { requireRequired: false },
): ValidationResult {
  const errors: FieldError[] = [];
  const output: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = data[field.apiId];

    // A deprecated field is still served by the API but no longer accepted for
    // new writes (§7.1). Existing values pass through untouched so deprecation
    // never destroys data.
    if (field.deprecatedAt) {
      if (raw !== undefined) output[field.apiId] = raw;
      continue;
    }

    if (isEmpty(raw)) {
      if (field.required && options.requireRequired) {
        errors.push({
          field: field.apiId,
          code: 'required',
          message: `${field.name} is required.`,
        });
      }
      // Distinguish "not supplied" from "explicitly cleared": only the latter
      // writes a null, so a partial update cannot silently blank other fields.
      if (raw === null) output[field.apiId] = null;
      continue;
    }

    const result = validateValue(field, raw);
    if (result.error) {
      errors.push({ field: field.apiId, code: result.error.code, message: result.error.message });
    } else {
      output[field.apiId] = result.value;
    }
  }

  // Unknown keys are dropped rather than stored. Keeping them would let the
  // jsonb column accumulate fields that no schema describes, which then appear
  // in Delivery API responses and become an accidental contract.
  return { valid: errors.length === 0, errors, data: output };
}

interface ValueResult {
  value?: unknown;
  error?: { code: string; message: string };
}

function validateValue(field: FieldDefinition, raw: unknown): ValueResult {
  const { validation: rules, name } = field;

  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'markdown':
    case 'code': {
      if (typeof raw !== 'string') return typeError(name, 'text');
      const value = raw;
      const lengthError = checkLength(value, rules, name);
      if (lengthError) return lengthError;
      if (rules.regex && !new RegExp(rules.regex).test(value)) {
        return {
          error: {
            code: 'pattern',
            message: rules.regexMessage ?? `${name} is not in the expected format.`,
          },
        };
      }
      return { value };
    }

    case 'slug': {
      if (typeof raw !== 'string') return typeError(name, 'text');
      const value = raw.trim().toLowerCase();
      if (!SLUG.test(value)) {
        return {
          error: {
            code: 'pattern',
            message: `${name} may contain only lowercase letters, numbers and hyphens.`,
          },
        };
      }
      return { value };
    }

    case 'email': {
      if (typeof raw !== 'string') return typeError(name, 'text');
      const value = raw.trim().toLowerCase();
      if (!EMAIL.test(value)) {
        return { error: { code: 'format', message: `${name} must be a valid email address.` } };
      }
      return { value };
    }

    case 'url': {
      if (typeof raw !== 'string') return typeError(name, 'text');
      try {
        const url = new URL(raw.trim());
        // Only web schemes: a javascript: or data: URL stored here would be
        // rendered by the consuming site and become an XSS vector there.
        if (!['http:', 'https:'].includes(url.protocol)) {
          return {
            error: { code: 'format', message: `${name} must be an http or https URL.` },
          };
        }
        return { value: url.toString() };
      } catch {
        return { error: { code: 'format', message: `${name} must be a valid URL.` } };
      }
    }

    case 'colour': {
      if (typeof raw !== 'string' || !HEX_COLOUR.test(raw.trim())) {
        return { error: { code: 'format', message: `${name} must be a hex colour, e.g. #4F46E5.` } };
      }
      return { value: raw.trim() };
    }

    case 'number':
    case 'decimal': {
      const value = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return typeError(name, 'number');
      }
      if (field.type === 'number' && !Number.isInteger(value)) {
        return { error: { code: 'type', message: `${name} must be a whole number.` } };
      }
      if (rules.min !== undefined && value < rules.min) {
        return { error: { code: 'min', message: `${name} must be at least ${rules.min}.` } };
      }
      if (rules.max !== undefined && value > rules.max) {
        return { error: { code: 'max', message: `${name} must be at most ${rules.max}.` } };
      }
      return { value };
    }

    case 'boolean': {
      if (typeof raw !== 'boolean') return typeError(name, 'true or false');
      return { value: raw };
    }

    case 'date':
    case 'datetime': {
      if (typeof raw !== 'string') return typeError(name, 'date');
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        return { error: { code: 'format', message: `${name} must be a valid date.` } };
      }
      // Dates are stored without a time component so a timezone shift cannot
      // move a date-only value onto the previous or next day.
      return { value: field.type === 'date' ? parsed.toISOString().slice(0, 10) : parsed.toISOString() };
    }

    case 'enum': {
      if (typeof raw !== 'string') return typeError(name, 'text');
      const allowed = allowedOptions(field);
      if (allowed.length && !allowed.includes(raw)) {
        return {
          error: { code: 'not_allowed', message: `${name} must be one of: ${allowed.join(', ')}.` },
        };
      }
      return { value: raw };
    }

    case 'multi_enum': {
      if (!Array.isArray(raw)) return typeError(name, 'list');
      const allowed = allowedOptions(field);
      const invalid = raw.filter((v) => typeof v !== 'string' || (allowed.length && !allowed.includes(v)));
      if (invalid.length) {
        return {
          error: {
            code: 'not_allowed',
            message: `${name} contains values that are not allowed: ${invalid.join(', ')}.`,
          },
        };
      }
      const countError = checkCount(raw, rules, name);
      if (countError) return countError;
      // De-duplicated: the same tag twice is meaningless and breaks counts.
      return { value: [...new Set(raw as string[])] };
    }

    case 'rich_text': {
      // Structured JSON, per Open Decision #3: "HTML locks consumers into a
      // rendering model and makes migration painful."
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return typeError(name, 'rich text document');
      }
      const doc = raw as { type?: string };
      if (doc.type !== 'doc') {
        return {
          error: {
            code: 'format',
            message: `${name} must be a rich-text document with a root node of type "doc".`,
          },
        };
      }
      return { value: raw };
    }

    case 'json': {
      if (typeof raw === 'string') {
        try {
          return { value: JSON.parse(raw) };
        } catch {
          return { error: { code: 'format', message: `${name} must be valid JSON.` } };
        }
      }
      return { value: raw };
    }

    case 'media':
    case 'relation_one': {
      if (typeof raw !== 'string') return typeError(name, 'single reference');
      return { value: raw };
    }

    case 'media_list':
    case 'relation_many': {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
        return typeError(name, 'list of references');
      }
      const countError = checkCount(raw, rules, name);
      if (countError) return countError;
      return { value: raw };
    }

    case 'geo': {
      const point = raw as { lat?: unknown; lng?: unknown };
      if (typeof point?.lat !== 'number' || typeof point?.lng !== 'number') {
        return typeError(name, 'coordinate with lat and lng');
      }
      if (point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) {
        return { error: { code: 'range', message: `${name} is not a valid coordinate.` } };
      }
      return { value: { lat: point.lat, lng: point.lng } };
    }

    default:
      // A field type with no branch must fail rather than silently storing
      // whatever arrived — fail closed (§1.2).
      return {
        error: {
          code: 'unsupported_type',
          message: `${name} uses field type '${field.type}', which this version cannot validate.`,
        },
      };
  }
}

function allowedOptions(field: FieldDefinition): string[] {
  if (field.validation.allowedValues?.length) return field.validation.allowedValues;
  return (field.config.options ?? []).map((option) => option.value);
}

function checkLength(value: string, rules: FieldValidation, name: string): ValueResult | null {
  if (rules.minLength !== undefined && value.length < rules.minLength) {
    return {
      error: { code: 'too_short', message: `${name} must be at least ${rules.minLength} characters.` },
    };
  }
  if (rules.maxLength !== undefined && value.length > rules.maxLength) {
    return {
      error: { code: 'too_long', message: `${name} must be at most ${rules.maxLength} characters.` },
    };
  }
  return null;
}

function checkCount(value: unknown[], rules: FieldValidation, name: string): ValueResult | null {
  if (rules.minItems !== undefined && value.length < rules.minItems) {
    return {
      error: { code: 'too_few', message: `${name} needs at least ${rules.minItems} item(s).` },
    };
  }
  if (rules.maxItems !== undefined && value.length > rules.maxItems) {
    return {
      error: { code: 'too_many', message: `${name} allows at most ${rules.maxItems} item(s).` },
    };
  }
  return null;
}

function typeError(name: string, expected: string): ValueResult {
  return { error: { code: 'type', message: `${name} must be a ${expected}.` } };
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * §7.1: adding a required field marks existing entries "incomplete" — flagged
 * in the list and blocked from re-publish until filled, while the already
 * published version stays live.
 */
export function isEntryComplete(fields: FieldDefinition[], data: Record<string, unknown>): boolean {
  return validateEntry(fields, data, { requireRequired: true }).valid;
}

/**
 * The safe field-type conversions of §7.1: "Only for safe widenings
 * (text→long_text, number→decimal). Others require creating a new field."
 *
 * Safe means every existing value remains valid under the new type without
 * being rewritten.
 */
const SAFE_TYPE_CHANGES: Partial<Record<FieldType, FieldType[]>> = {
  text: ['long_text', 'markdown'],
  long_text: ['markdown'],
  number: ['decimal'],
  slug: ['text'],
  email: ['text'],
  url: ['text'],
  enum: ['multi_enum'],
  media: ['media_list'],
  relation_one: ['relation_many'],
};

export function isSafeTypeChange(from: FieldType, to: FieldType): boolean {
  if (from === to) return true;
  return (SAFE_TYPE_CHANGES[from] ?? []).includes(to);
}

export function safeTargetsFor(from: FieldType): FieldType[] {
  return SAFE_TYPE_CHANGES[from] ?? [];
}
