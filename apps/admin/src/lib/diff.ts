/**
 * Word-level text diff, and the field-level comparison built on it (§7.4).
 *
 * Hand-written rather than pulled from a package: this is one classic algorithm
 * over short strings, and the alternative is another dependency in a tree that
 * already fails `npm audit`. It is also the piece most worth being able to read
 * when a diff looks wrong.
 */

export type DiffOp = 'same' | 'added' | 'removed';

export interface DiffToken {
  op: DiffOp;
  text: string;
}

/**
 * Splits on whitespace boundaries, keeping the whitespace.
 *
 * Diffing by character makes a one-word change look like a dozen scattered
 * edits; diffing by line misses everything inside a paragraph, which is where
 * prose edits actually happen. Words are the unit a person reads a change in.
 */
function tokenise(value: string): string[] {
  return value.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Longest common subsequence over word tokens.
 *
 * O(n·m) in both time and memory, which is fine for a field and not fine for a
 * novel — hence the ceiling below, past which the diff degrades to
 * "replaced" rather than locking up the tab.
 */
const MAX_TOKENS = 2500;

export function diffWords(before: string, after: string): DiffToken[] {
  if (before === after) return before ? [{ op: 'same', text: before }] : [];

  const a = tokenise(before);
  const b = tokenise(after);

  if (a.length * b.length > MAX_TOKENS * MAX_TOKENS || a.length + b.length > MAX_TOKENS) {
    // Honest degradation: showing the whole field as replaced is accurate, and
    // far better than a frozen browser.
    return [
      ...(before ? [{ op: 'removed' as const, text: before }] : []),
      ...(after ? [{ op: 'added' as const, text: after }] : []),
    ];
  }

  // lengths[i][j] = LCS length of a[i:] and b[j:]
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;

  const push = (op: DiffOp, text: string) => {
    const last = tokens[tokens.length - 1];
    // Merged as we go, so a changed phrase renders as one highlight rather than
    // one per word with seams between them.
    if (last && last.op === op) last.text += text;
    else tokens.push({ op, text });
  };

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      push('removed', a[i]);
      i += 1;
    } else {
      push('added', b[j]);
      j += 1;
    }
  }

  while (i < a.length) push('removed', a[i++]);
  while (j < b.length) push('added', b[j++]);

  return absorbGaps(tokens);
}

/**
 * Joins runs of the same op separated only by unchanged whitespace.
 *
 * Editing "b c" to "x y" leaves the space between them technically unchanged,
 * so the raw walk emits [removed b][same ' '][removed c] — two highlight boxes
 * with a gap punched through the middle of one edited phrase. Absorbing that
 * whitespace renders the change as the single edit a reader perceives it to be.
 *
 * Only whitespace is absorbed. A real word between two edits is genuinely
 * unchanged and must keep showing as such.
 */
function absorbGaps(tokens: DiffToken[]): DiffToken[] {
  // A whitespace-only "same" token with edits on both sides is inside a change,
  // not between two of them. The walk emits edits interleaved as
  // removed/added/removed/added, so such a gap sits between *different* ops —
  // which is why it has to be identified up front rather than while merging.
  const isBridge = tokens.map(
    (token, index) =>
      token.op === 'same' &&
      token.text.trim() === '' &&
      index > 0 &&
      index < tokens.length - 1 &&
      tokens[index - 1].op !== 'same' &&
      tokens[index + 1].op !== 'same',
  );

  const merged: DiffToken[] = [];
  let index = 0;

  while (index < tokens.length) {
    if (tokens[index].op === 'same' && !isBridge[index]) {
      const previous = merged[merged.length - 1];
      if (previous?.op === 'same') previous.text += tokens[index].text;
      else merged.push({ ...tokens[index] });
      index += 1;
      continue;
    }

    // One hunk: every edit up to the next genuinely unchanged word.
    let removed = '';
    let added = '';

    while (index < tokens.length && (tokens[index].op !== 'same' || isBridge[index])) {
      const token = tokens[index];
      // A bridge belongs to both sides — it is unchanged text that happens to
      // sit inside the edited phrase.
      if (token.op === 'removed' || isBridge[index]) removed += token.text;
      if (token.op === 'added' || isBridge[index]) added += token.text;
      index += 1;
    }

    if (removed) merged.push({ op: 'removed', text: removed });
    if (added) merged.push({ op: 'added', text: added });
  }

  return merged;
}

// ---------------------------------------------------------------------------

export type FieldChange = 'unchanged' | 'changed' | 'added' | 'removed';

export interface FieldDiff {
  apiId: string;
  change: FieldChange;
  before: unknown;
  after: unknown;
}

/**
 * Compares two entry `data` objects field by field.
 *
 * Driven by the union of both sides' keys rather than the current schema, so a
 * field deleted from the content type still shows up when comparing versions
 * written while it existed. Losing that would make old versions look emptier
 * than they were.
 */
export function diffEntryData(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  order: string[] = [],
): FieldDiff[] {
  const keys = new Set([...order, ...Object.keys(before), ...Object.keys(after)]);

  const diffs: FieldDiff[] = [];

  for (const apiId of keys) {
    const hasBefore = isPresent(before[apiId]);
    const hasAfter = isPresent(after[apiId]);

    if (!hasBefore && !hasAfter) continue;

    let change: FieldChange;
    if (!hasBefore) change = 'added';
    else if (!hasAfter) change = 'removed';
    else change = equalValues(before[apiId], after[apiId]) ? 'unchanged' : 'changed';

    diffs.push({ apiId, change, before: before[apiId], after: after[apiId] });
  }

  return diffs;
}

/** Empty string, null and undefined all mean "nothing was in this field". */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/**
 * Structural equality.
 *
 * `JSON.stringify` comparison would report a change whenever two objects agree
 * but were built in a different key order — which is exactly what happens to
 * anything that has been through Postgres `jsonb`, so every rich-text field
 * would look edited on every comparison.
 */
export function equalValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => equalValues(item, b[index]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((key, index) => key === bKeys[index])) return false;

    return aKeys.every((key) =>
      equalValues((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }

  return false;
}

/**
 * A field value as comparable text.
 *
 * Rich text is flattened to its text content: a reader wants to know that a
 * paragraph changed, not that a ProseMirror node's attrs object gained a key.
 * Structural changes still register through `equalValues` above, so nothing is
 * hidden — this only decides how a change is *displayed*.
 */
export function valueToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (isRichTextDocument(value)) return richTextToPlain(value);

  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(', ');

  return JSON.stringify(value, null, 2);
}

function isRichTextDocument(value: unknown): value is { type: 'doc'; content?: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: string }).type === 'doc'
  );
}

/** Walks a ProseMirror document, keeping text and block boundaries. */
function richTextToPlain(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';

  const typed = node as { type?: string; text?: string; content?: unknown[] };
  if (typed.text) return typed.text;

  const inner = (typed.content ?? []).map(richTextToPlain).join('');

  // Block nodes end with a newline so paragraphs do not run together into one
  // unreadable line in the diff.
  return BLOCK_NODES.has(typed.type ?? '') ? `${inner}\n` : inner;
}

const BLOCK_NODES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'callout',
  'tableRow',
]);
