import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import StarterKit from '@tiptap/starter-kit';
import { mergeAttributes, Node } from '@tiptap/core';

/**
 * The document schema.
 *
 * This file *is* the contract with every site reading the API. A node defined
 * here becomes a shape in the stored JSON, and once an editor has saved one,
 * removing it orphans that content — so nodes are added deliberately rather
 * than because an extension was available.
 *
 * The server only requires a root of `{ type: 'doc' }` and accepts whatever is
 * inside, which means nothing here can be caught by validation. The discipline
 * has to live at this layer.
 */

/**
 * A callout — an aside with an intent.
 *
 * Stored as its own node with a `tone` attribute rather than as a styled
 * blockquote, because a consumer needs to know it is a warning to render it as
 * one. Styling is the site's business; the meaning is ours to record.
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'paragraph+',
  defining: true,

  addAttributes() {
    return {
      tone: {
        default: 'info',
        parseHTML: (element) => element.getAttribute('data-tone') ?? 'info',
        renderHTML: (attributes) => ({ 'data-tone': attributes.tone }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-callout': '' }), 0];
  },
});

/**
 * A call-to-action button.
 *
 * A leaf node holding a label and href rather than a styled link, so a site can
 * render it as a real button component instead of guessing from a class name.
 */
export const CallToAction = Node.create({
  name: 'cta',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      label: { default: 'Read more' },
      href: { default: '' },
      variant: { default: 'primary' },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-cta]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, { 'data-cta': '' }),
      (HTMLAttributes.label as string) ?? 'Read more',
    ];
  },
});

/**
 * An external embed — YouTube, Vimeo, X, or anything else with a URL.
 *
 * The URL is stored, never an iframe. Storing provider markup would freeze
 * today's embed code into the content and hand every consumer a third-party
 * script they did not choose to run.
 */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: '' },
      provider: { default: 'generic' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-embed]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-embed': '' })];
  },
});

/**
 * Images carry the asset id alongside the URL.
 *
 * A URL alone rots: presigned links expire, buckets move, and a CDN domain
 * changes. Keeping `assetId` means a consumer can always re-resolve the current
 * URL through the media endpoint, and the CMS can find which documents use an
 * asset.
 */
const MediaImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      assetId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-asset-id'),
        renderHTML: (attributes) =>
          attributes.assetId ? { 'data-asset-id': attributes.assetId } : {},
      },
    };
  },
});

/** Recognises the provider so a consumer does not have to parse the URL again. */
export function providerFor(url: string): string {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/vimeo\.com/i.test(url)) return 'vimeo';
  if (/(twitter\.com|x\.com)/i.test(url)) return 'x';
  return 'generic';
}

export function buildExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      // H1 is the entry's title field. Offering it inside the body produces two
      // competing top-level headings on the rendered page, which is an
      // accessibility problem and an SEO one.
      heading: { levels: [2, 3, 4] },
      codeBlock: { HTMLAttributes: { class: 'rich-code' } },
    }),
    MediaImage.configure({ inline: false, allowBase64: false }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      // Pasted javascript: URLs become executable in a consumer that renders
      // this document, so the scheme allowlist is a real boundary.
      protocols: ['http', 'https', 'mailto', 'tel'],
      HTMLAttributes: { rel: 'noopener noreferrer' },
    }),
    Placeholder.configure({ placeholder }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Callout,
    CallToAction,
    Embed,
  ];
}
