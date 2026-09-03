import { describe, expect, it } from 'vitest';

import { Callout, CallToAction, Embed, providerFor } from './extensions';

/**
 * The document schema is the contract with every site reading the API, so the
 * parts worth pinning are the ones a consumer would break on: node names and
 * attribute names. Renaming either silently orphans content that is already
 * stored, and nothing in the API would catch it — the server only checks that
 * the root node is a `doc`.
 */
describe('rich-text schema', () => {
  it('keeps the node names consumers match on', () => {
    expect(Callout.name).toBe('callout');
    expect(CallToAction.name).toBe('cta');
    expect(Embed.name).toBe('embed');
  });

  it('gives a callout a tone, defaulting to info', () => {
    const attributes = Callout.config.addAttributes?.call({} as never) as Record<
      string,
      { default: unknown }
    >;
    expect(attributes.tone.default).toBe('info');
  });

  it('stores a CTA as label + href, not as marked-up text', () => {
    const attributes = CallToAction.config.addAttributes?.call({} as never) as Record<
      string,
      { default: unknown }
    >;
    expect(Object.keys(attributes).sort()).toEqual(['href', 'label', 'variant']);
  });

  it('stores an embed as a URL, never as provider markup', () => {
    const attributes = Embed.config.addAttributes?.call({} as never) as Record<
      string,
      { default: unknown }
    >;
    // An iframe frozen into the document would hand every consumer a
    // third-party script they did not choose to run.
    expect(Object.keys(attributes).sort()).toEqual(['provider', 'src']);
  });
});

describe('providerFor', () => {
  it('recognises the providers worth special-casing', () => {
    expect(providerFor('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(providerFor('https://youtu.be/abc')).toBe('youtube');
    expect(providerFor('https://vimeo.com/123')).toBe('vimeo');
    expect(providerFor('https://x.com/user/status/1')).toBe('x');
    expect(providerFor('https://twitter.com/user/status/1')).toBe('x');
  });

  it('falls back to generic rather than guessing', () => {
    expect(providerFor('https://example.com/thing')).toBe('generic');
    expect(providerFor('not a url')).toBe('generic');
  });
});
