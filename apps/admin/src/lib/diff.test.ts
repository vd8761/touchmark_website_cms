import { describe, expect, it } from 'vitest';

import { diffEntryData, diffWords, equalValues, valueToText } from './diff';

const rendered = (before: string, after: string) =>
  diffWords(before, after)
    .map((token) => `${token.op[0]}:${token.text}`)
    .join('|');

describe('diffWords', () => {
  it('reports no change as a single unchanged run', () => {
    expect(diffWords('hello world', 'hello world')).toEqual([
      { op: 'same', text: 'hello world' },
    ]);
  });

  it('isolates the word that changed', () => {
    expect(rendered('the quick brown fox', 'the slow brown fox')).toBe(
      's:the |r:quick|a:slow|s: brown fox',
    );
  });

  it('merges adjacent tokens so a changed phrase is one highlight', () => {
    const tokens = diffWords('a b c d', 'a x y d');

    // Not one highlight per word with visible seams between them.
    expect(tokens.filter((token) => token.op === 'removed')).toHaveLength(1);
    expect(tokens.filter((token) => token.op === 'added')).toHaveLength(1);
  });

  it('handles insertion at either end', () => {
    expect(rendered('world', 'hello world')).toBe('a:hello |s:world');
    expect(rendered('hello', 'hello world')).toBe('s:hello|a: world');
  });

  it('handles a field going from empty to filled, and back', () => {
    expect(diffWords('', 'new text')).toEqual([{ op: 'added', text: 'new text' }]);
    expect(diffWords('old text', '')).toEqual([{ op: 'removed', text: 'old text' }]);
    expect(diffWords('', '')).toEqual([]);
  });

  it('preserves whitespace so the text still reads correctly', () => {
    const rebuilt = diffWords('one two', 'one three two')
      .filter((token) => token.op !== 'removed')
      .map((token) => token.text)
      .join('');

    expect(rebuilt).toBe('one three two');
  });

  it('degrades instead of hanging on a very large field', () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ');
    const tokens = diffWords(huge, `${huge} extra`);

    // O(n·m) over 4000 words would be 16M cells; reporting a wholesale
    // replacement is accurate and does not freeze the tab.
    expect(tokens.map((token) => token.op)).toEqual(['removed', 'added']);
  });
});

describe('equalValues', () => {
  it('ignores key order, which jsonb reorders on every round trip', () => {
    // Without this every rich-text field would look edited on every comparison.
    expect(equalValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('compares nested structures by value', () => {
    expect(equalValues({ a: [{ b: 1 }] }, { a: [{ b: 1 }] })).toBe(true);
    expect(equalValues({ a: [{ b: 1 }] }, { a: [{ b: 2 }] })).toBe(false);
  });

  it('does not treat a different length or type as equal', () => {
    expect(equalValues([1, 2], [1, 2, 3])).toBe(false);
    expect(equalValues('1', 1)).toBe(false);
    expect(equalValues(null, undefined)).toBe(false);
  });
});

describe('diffEntryData', () => {
  it('classifies added, removed, changed and unchanged', () => {
    const diffs = diffEntryData(
      { kept: 'same', edited: 'before', gone: 'value' },
      { kept: 'same', edited: 'after', fresh: 'value' },
    );

    const byId = Object.fromEntries(diffs.map((diff) => [diff.apiId, diff.change]));
    expect(byId).toEqual({
      kept: 'unchanged',
      edited: 'changed',
      gone: 'removed',
      fresh: 'added',
    });
  });

  it('treats empty string, null and [] as absent rather than as a value', () => {
    const diffs = diffEntryData({ a: '', b: null, c: [] }, { a: '', b: null, c: [] });
    // None of these held anything, so none of them are a row in the diff.
    expect(diffs).toEqual([]);
  });

  it('includes fields no longer in the schema', () => {
    const diffs = diffEntryData({ removed_field: 'old value' }, {}, ['title']);

    // Dropping these would make old versions look emptier than they were.
    expect(diffs.map((diff) => diff.apiId)).toContain('removed_field');
  });

  it('follows the schema order for fields that are still defined', () => {
    const diffs = diffEntryData(
      { body: 'b', title: 't' },
      { body: 'b2', title: 't2' },
      ['title', 'body'],
    );

    expect(diffs.map((diff) => diff.apiId)).toEqual(['title', 'body']);
  });
});

describe('valueToText', () => {
  it('flattens a rich-text document to readable prose', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body text.' }] },
      ],
    };

    // A reader wants to know the paragraph changed, not that a node's attrs
    // object gained a key.
    expect(valueToText(doc)).toBe('Title\nBody text.\n');
  });

  it('keeps blocks on separate lines rather than running them together', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
      ],
    };

    expect(valueToText(doc)).toBe('One\nTwo\n');
  });

  it('renders scalars and lists usefully', () => {
    expect(valueToText(42)).toBe('42');
    expect(valueToText(true)).toBe('true');
    expect(valueToText(['a', 'b'])).toBe('a, b');
    expect(valueToText(null)).toBe('');
  });
});
