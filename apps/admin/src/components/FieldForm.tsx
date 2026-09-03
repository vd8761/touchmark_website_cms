import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { api, type ApiError } from '../lib/api';
import {
  FIELD_TYPE_GROUPS,
  type ContentTypeDto,
  type FieldDto,
  type FieldTypeName,
} from '../lib/content-types';
import { Button, Field, Input, cx } from './primitives';
import { FieldInput } from './FieldInput';

/**
 * Defining and configuring one field.
 *
 * Replaces a form that offered a type and a Required checkbox and nothing else.
 * The validation rules, defaults, help text and grouping were all supported by
 * the API and simply unreachable from the UI, so the only way to set a
 * character limit or an enum label was to call the endpoint by hand.
 *
 * Three things shape it:
 *
 * **Only what the server enforces.** Every control here maps to a rule
 * `field-validation.ts` actually applies. Offering a "min length" on a date —
 * or any rule the API would ignore — teaches people the schema is advisory,
 * which is worse than not offering it.
 *
 * **The API ID is shown while it is still changeable.** It is derived from the
 * name and permanent once saved (§7.1), so it is displayed live as you type
 * rather than discovered later in a payload.
 *
 * **The preview is the real control.** It renders `FieldInput` — the same
 * component the entry editor uses — against the draft definition, so the effect
 * of "required", an enum's labels or a help string is visible before saving
 * rather than after creating a field you cannot rename.
 */

/** What the API can actually validate, per type. Mirrors `field-validation.ts`. */
interface Capabilities {
  text?: boolean;
  numeric?: boolean;
  items?: boolean;
  options?: boolean;
  relation?: boolean;
  unique?: boolean;
  defaultValue?: boolean;
}

function capabilitiesFor(type: FieldTypeName): Capabilities {
  switch (type) {
    case 'text':
    case 'long_text':
    case 'markdown':
    case 'code':
      return { text: true, unique: true, defaultValue: true };
    case 'slug':
    case 'email':
    case 'url':
      return { unique: true, defaultValue: true };
    case 'number':
    case 'decimal':
      return { numeric: true, unique: true, defaultValue: true };
    case 'enum':
      return { options: true, defaultValue: true };
    case 'multi_enum':
      return { options: true, items: true };
    case 'media_list':
    case 'relation_many':
      return { items: true, relation: type === 'relation_many' };
    case 'relation_one':
      return { relation: true };
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'colour':
      return { defaultValue: true };
    default:
      // rich_text, json, media, geo — no rule the server would apply.
      return {};
  }
}

interface OptionRow {
  value: string;
  label: string;
}

export function FieldForm({
  base,
  contentTypes,
  existing,
  onCancel,
  onSaved,
}: {
  base: string;
  contentTypes: ContentTypeDto[];
  /** Present when editing. The type and API ID are then largely fixed. */
  existing?: FieldDto;
  onCancel: () => void;
  onSaved: (result: { entries_marked_incomplete?: number }) => void;
}) {
  const editing = Boolean(existing);

  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<FieldTypeName>(existing?.type ?? 'text');
  const [required, setRequired] = useState(existing?.required ?? false);
  const [unique, setUnique] = useState(existing?.unique_value ?? false);
  const [localised, setLocalised] = useState(existing?.localised ?? false);
  const [helpText, setHelpText] = useState(existing?.help_text ?? '');
  const [group, setGroup] = useState(existing?.group ?? '');
  const [relationTypeApiId, setRelationTypeApiId] = useState(
    existing?.config?.relationTypeApiId ?? '',
  );
  const [options, setOptions] = useState<OptionRow[]>(
    existing?.config?.options?.map((option) => ({
      value: option.value,
      label: option.label ?? '',
    })) ?? [{ value: '', label: '' }],
  );
  const [rules, setRules] = useState<Record<string, string>>(() => stringifyRules(existing));
  const [defaultValue, setDefaultValue] = useState<unknown>(existing?.default_value ?? null);

  const caps = capabilitiesFor(type);
  const apiId = existing?.api_id ?? toApiId(name);

  // The draft, in the exact shape the entry editor consumes — which is what
  // makes the preview honest rather than an approximation of one.
  const draft: FieldDto = useMemo(
    () => ({
      id: existing?.id ?? 'preview',
      name: name || 'Untitled field',
      api_id: apiId || 'untitled',
      type,
      position: existing?.position ?? 0,
      required,
      unique_value: unique,
      localised,
      default_value: defaultValue,
      help_text: helpText || null,
      validation: parseRules(rules),
      config: {
        ...(caps.options ? { options: cleanOptions(options) } : {}),
        ...(caps.relation ? { relationTypeApiId } : {}),
      },
      group: group || null,
      deprecated: false,
    }),
    [
      apiId,
      caps.options,
      caps.relation,
      defaultValue,
      existing,
      group,
      helpText,
      localised,
      name,
      options,
      relationTypeApiId,
      required,
      rules,
      type,
      unique,
    ],
  );

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        type,
        required,
        localised,
        ...(caps.unique ? { unique_value: unique } : {}),
        // Empty string, not undefined: the API reads '' as "clear this".
        help_text: helpText,
        group,
        validation: parseRules(rules),
        config: draft.config,
        ...(defaultValue === null || defaultValue === '' ? {} : { default_value: defaultValue }),
      };

      return existing
        ? api.patch<{ entries_marked_incomplete?: number }>(`${base}/${existing.id}`, body)
        : api.post<{ entries_marked_incomplete?: number }>(base, body);
    },
    onSuccess: onSaved,
  });

  const error = save.error as ApiError | null;

  const optionsIncomplete = caps.options && cleanOptions(options).length === 0;
  const relationMissing = caps.relation && !relationTypeApiId;

  return (
    <div className="space-y-5 rounded-xl border border-border bg-surface-subtle p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-text">{editing ? 'Edit field' : 'Add a field'}</p>
        {apiId && (
          <p className="font-mono text-xs text-text-secondary">
            data.<span className="text-text">{apiId}</span>
            {!editing && <span className="ml-1.5 text-text-secondary">· permanent once saved</span>}
          </p>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0 space-y-5">
          <Field
            label="Name"
            hint={
              editing
                ? 'Renaming is safe — the API ID never changes.'
                : 'The API ID is derived from this and is permanent.'
            }
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Hero Image"
              autoFocus
            />
          </Field>

          <TypePicker type={type} editing={editing} onChange={setType} />

          {caps.relation && (
            <Field
              label="Links to"
              hint="Authors get a searchable picker of this type's entries."
            >
              <Select
                value={relationTypeApiId}
                onChange={setRelationTypeApiId}
                options={[
                  { value: '', label: 'Choose a content type…' },
                  ...contentTypes.map((option) => ({
                    value: option.api_id,
                    label: option.name,
                  })),
                ]}
              />
            </Field>
          )}

          {caps.options && <OptionsEditor options={options} onChange={setOptions} />}

          <Rules type={type} caps={caps} rules={rules} onChange={setRules} />

          <Field
            label="Help text"
            hint="Shown under the input in the editor. The place to explain length limits or house style."
          >
            <Input
              value={helpText}
              onChange={(event) => setHelpText(event.target.value)}
              placeholder="Keep under 60 characters — this is the browser tab title."
            />
          </Field>

          <Field
            label="Group"
            hint="Fields sharing a group are shown together. Leave empty for the main column."
          >
            <Input
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              placeholder="SEO"
            />
          </Field>

          <div className="space-y-2.5">
            <Toggle
              checked={required}
              onChange={setRequired}
              label="Required"
              hint={
                editing && !existing?.required
                  ? 'Existing entries will be marked incomplete and cannot be re-published until this field is filled. Already-published versions stay live.'
                  : 'Entries cannot be published without a value. Supplying a default below avoids marking existing entries incomplete.'
              }
            />
            {caps.unique && (
              <Toggle
                checked={unique}
                onChange={setUnique}
                label="Unique"
                hint="No two entries of this type may share a value."
              />
            )}
            <Toggle
              checked={localised}
              onChange={setLocalised}
              label="Translatable"
              hint="Each locale holds its own value. Leave off for things that do not change per language, like a price or an image."
            />
          </div>
        </div>

        <aside className="space-y-2 lg:border-l lg:border-border lg:pl-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text/60">
            Preview
          </p>
          <p className="text-xs text-text-secondary">
            Exactly how this appears to an author.
          </p>
          <div className="rounded-lg border border-border bg-surface p-3">
            <FieldInput field={draft} value={defaultValue} onChange={setDefaultValue} />
          </div>
          {caps.defaultValue && (
            <p className="text-xs text-text-secondary">
              Whatever you enter above is saved as the field’s default value.
            </p>
          )}
        </aside>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm text-text">{error.message}</p>
          {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
          {error.fields?.map((fieldError) => (
            <p key={fieldError.field} className="mt-1 text-xs text-text-secondary">
              {fieldError.field}: {fieldError.message}
            </p>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={save.isPending}
          // A relation with no target, or an enum with no options, renders as an
          // unusable control — so neither can be saved in the first place.
          disabled={!name || Boolean(relationMissing) || Boolean(optionsIncomplete)}
          onClick={() => save.mutate()}
        >
          {editing ? 'Save changes' : 'Add field'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TypePicker({
  type,
  editing,
  onChange,
}: {
  type: FieldTypeName;
  editing: boolean;
  onChange: (type: FieldTypeName) => void;
}) {
  const active = FIELD_TYPE_GROUPS.flatMap((group) => group.types).find(
    (option) => option.type === type,
  );

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text">Type</p>

      {editing && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-text-secondary">
          Only safe widenings are allowed after creation — text to long text, for instance. Anything
          that could lose data is refused by the API (§7.1).
        </p>
      )}

      {FIELD_TYPE_GROUPS.map((group) => (
        <div key={group.group}>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            {group.group}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {group.types.map((option) => (
              <button
                key={option.type}
                type="button"
                title={option.hint}
                onClick={() => onChange(option.type)}
                className={cx(
                  'rounded-lg border px-2.5 py-1 text-xs',
                  type === option.type
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-text-secondary hover:bg-surface',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* The hint was previously a title attribute only, so it took a hover to
          discover and never appeared on touch. */}
      {active && <p className="text-xs text-text-secondary">{active.hint}</p>}
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: OptionRow[];
  onChange: (options: OptionRow[]) => void;
}) {
  const update = (index: number, patch: Partial<OptionRow>) =>
    onChange(options.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Field
      label="Options"
      hint="The value is stored and sent to your site; the label is what authors see. Values are permanent in the sense that changing one orphans any entry already using it."
    >
      <div className="space-y-1.5">
        {options.map((row, index) => (
          <div key={index} className="flex gap-1.5">
            <Input
              value={row.value}
              onChange={(event) => update(index, { value: event.target.value })}
              placeholder="value"
              className="font-mono"
            />
            <Input
              value={row.label}
              onChange={(event) => update(index, { label: event.target.value })}
              placeholder="Label shown to authors (optional)"
            />
            <button
              type="button"
              onClick={() => onChange(options.filter((_, i) => i !== index))}
              disabled={options.length === 1}
              className="shrink-0 rounded-lg border border-border px-2 text-sm text-text-secondary hover:text-text disabled:opacity-40"
              aria-label={`Remove option ${index + 1}`}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...options, { value: '', label: '' }])}
          className="text-xs text-accent hover:underline"
        >
          + Add option
        </button>
      </div>
    </Field>
  );
}

function Rules({
  type,
  caps,
  rules,
  onChange,
}: {
  type: FieldTypeName;
  caps: Capabilities;
  rules: Record<string, string>;
  onChange: (rules: Record<string, string>) => void;
}) {
  if (!caps.text && !caps.numeric && !caps.items) return null;

  const set = (key: string, value: string) => onChange({ ...rules, [key]: value });

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-text">Validation</p>

      {caps.text && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Minimum length">
              <Input
                type="number"
                min={0}
                value={rules.minLength ?? ''}
                onChange={(event) => set('minLength', event.target.value)}
              />
            </Field>
            <Field label="Maximum length">
              <Input
                type="number"
                min={0}
                value={rules.maxLength ?? ''}
                onChange={(event) => set('maxLength', event.target.value)}
                placeholder={type === 'text' ? '120' : ''}
              />
            </Field>
          </div>
          <Field
            label="Pattern"
            hint="A regular expression the value must match. Leave empty for no constraint."
          >
            <Input
              value={rules.regex ?? ''}
              onChange={(event) => set('regex', event.target.value)}
              placeholder="^[A-Z]{2}-\d{4}$"
              className="font-mono"
            />
          </Field>
          {rules.regex && (
            <Field
              label="Message when the pattern fails"
              hint="Authors cannot read a regex. Say what the value should look like."
            >
              <Input
                value={rules.regexMessage ?? ''}
                onChange={(event) => set('regexMessage', event.target.value)}
                placeholder="Use two letters, a dash, then four digits — AB-1234."
              />
            </Field>
          )}
        </>
      )}

      {caps.numeric && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum">
            <Input
              type="number"
              value={rules.min ?? ''}
              onChange={(event) => set('min', event.target.value)}
            />
          </Field>
          <Field label="Maximum">
            <Input
              type="number"
              value={rules.max ?? ''}
              onChange={(event) => set('max', event.target.value)}
            />
          </Field>
        </div>
      )}

      {caps.items && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fewest items">
            <Input
              type="number"
              min={0}
              value={rules.minItems ?? ''}
              onChange={(event) => set('minItems', event.target.value)}
            />
          </Field>
          <Field label="Most items">
            <Input
              type="number"
              min={0}
              value={rules.maxItems ?? ''}
              onChange={(event) => set('maxItems', event.target.value)}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-text">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1"
      />
      <span>
        {label}
        {/* §7.1 wants the consequence stated before the action, not after. */}
        <span className="block text-xs text-text-secondary">{hint}</span>
      </span>
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------

/**
 * The same derivation the server uses (`content-types.service.ts#toApiId`).
 *
 * Duplicated deliberately: this is a preview of what the server will decide,
 * and it must agree with it. If the rule ever changes, it changes in both — the
 * alternative is showing an api_id that turns out not to be the one you got.
 */
function toApiId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f$1')
    .slice(0, 50);
}

const RULE_KEYS = ['min', 'max', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const;

function stringifyRules(field?: FieldDto): Record<string, string> {
  const source = (field?.validation ?? {}) as Record<string, unknown>;
  const rules: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) rules[key] = String(value);
  }

  return rules;
}

/**
 * Empty inputs are omitted rather than sent as 0 or "".
 *
 * A blank "minimum length" means no minimum; sending `minLength: 0` would be a
 * rule that always passes but shows up in the schema as though one exists.
 */
function parseRules(rules: Record<string, string>): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};

  for (const key of RULE_KEYS) {
    const raw = rules[key];
    if (raw === undefined || raw.trim() === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) parsed[key] = value;
  }

  if (rules.regex?.trim()) {
    parsed.regex = rules.regex.trim();
    if (rules.regexMessage?.trim()) parsed.regexMessage = rules.regexMessage.trim();
  }

  return parsed;
}

function cleanOptions(options: OptionRow[]): { value: string; label?: string }[] {
  return options
    .map((row) => ({ value: row.value.trim(), label: row.label.trim() || undefined }))
    .filter((row) => row.value !== '');
}
