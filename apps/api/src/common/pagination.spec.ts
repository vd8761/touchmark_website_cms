import { pageArgs, parseLimit, toPage } from './pagination';

describe('parseLimit', () => {
  it('defaults when absent or unparseable', () => {
    expect(parseLimit(undefined)).toBe(25);
    expect(parseLimit('')).toBe(25);
    expect(parseLimit('not-a-number')).toBe(25);
  });

  it('accepts the string form query parameters actually arrive as', () => {
    expect(parseLimit('10')).toBe(10);
    expect(parseLimit(10)).toBe(10);
  });

  it('clamps rather than rejecting, at both ends', () => {
    // A caller asking for 100000 rows gets a page, not a 400 — the limit is a
    // protection for the server, and failing the request protects nothing.
    expect(parseLimit(100_000)).toBe(100);
    expect(parseLimit(0)).toBe(25);
    expect(parseLimit(-5)).toBe(25);
    expect(parseLimit(7.9)).toBe(7);
  });
});

describe('pageArgs', () => {
  it('over-fetches by one so has_more needs no second query', () => {
    expect(pageArgs(25)).toEqual({ take: 26 });
  });

  it('steps over the cursor row, which Prisma would otherwise repeat', () => {
    expect(pageArgs(25, 'abc')).toEqual({ take: 26, cursor: { id: 'abc' }, skip: 1 });
  });
});

describe('toPage', () => {
  const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `id-${i}` }));

  it('trims the over-fetched row and reports another page', () => {
    const page = toPage(rows(4), 3, 40);

    expect(page.items).toHaveLength(3);
    expect(page.meta.has_more).toBe(true);
    // The cursor is the last row *returned*, not the extra one that was peeked.
    expect(page.meta.next_cursor).toBe('id-2');
    expect(page.meta.total).toBe(40);
  });

  it('ends the sequence when the page is not full', () => {
    const page = toPage(rows(2), 3, 2);

    expect(page.items).toHaveLength(2);
    expect(page.meta.has_more).toBe(false);
    expect(page.meta.next_cursor).toBeNull();
  });

  it('handles an exactly-full final page without offering a dead cursor', () => {
    // The boundary that gets this wrong everywhere: 3 of 3 rows, limit 3. There
    // is no fourth row, so there must be no next cursor.
    const page = toPage(rows(3), 3, 3);

    expect(page.meta.has_more).toBe(false);
    expect(page.meta.next_cursor).toBeNull();
  });

  it('reports the matching total, not the page size', () => {
    const page = toPage(rows(3), 25, 900);
    expect(page.meta.total).toBe(900);
  });

  it('survives an empty result', () => {
    const page = toPage([], 25, 0);
    expect(page.items).toEqual([]);
    expect(page.meta).toEqual({ total: 0, limit: 25, has_more: false, next_cursor: null });
  });
});
