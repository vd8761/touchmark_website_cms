import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BubbleMenu, EditorContent, useEditor, type Editor } from '@tiptap/react';

import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { MediaPicker } from '../MediaPicker';
import { cx } from '../primitives';
import { buildExtensions, providerFor } from './extensions';

/**
 * The block editor of §7.3.
 *
 * Replaces a textarea containing raw ProseMirror JSON. The stored shape does
 * not change — it was already correct (Open Decision #3: structured JSON, never
 * an HTML blob) — so this is purely an editing surface over a document format
 * that already existed. Anything written before this lands opens unchanged.
 *
 * Three affordances do most of the work, and they are the ones people expect
 * from every other editor they use:
 *
 *   * a selection toolbar, for formatting text you have already written;
 *   * a `/` menu, for inserting a block where the cursor is;
 *   * an outline, because the thing you navigate a long document by is its
 *     headings.
 */
export function RichTextEditor({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Menu state, mirrored into refs.
   *
   * `handleKeyDown` below is registered once with ProseMirror and is not
   * re-created per render, so it cannot read React state directly without
   * capturing whichever value existed when the editor was constructed.
   */
  const slashRef = useRef<string | null>(null);
  const highlightRef = useRef(0);
  const filteredRef = useRef<BlockCommand[]>([]);
  const runRef = useRef<(command: BlockCommand) => void>(() => {});

  const editor = useEditor({
    extensions: buildExtensions('Write, or press / to insert a block…'),
    // A malformed document must not take the editor down with it — the old
    // textarea let people save arbitrary JSON, so that content exists.
    content: isDocument(value) ? value : emptyDocument(),
    editable: !disabled,
    onUpdate: ({ editor: instance }) => onChange(instance.getJSON()),
    editorProps: {
      attributes: {
        class: 'rich-text-surface',
      },

      /**
       * The slash menu's keyboard handling belongs here, not on a wrapping div.
       *
       * ProseMirror listens on the contenteditable itself, so a handler on an
       * ancestor only sees the event on the way back up — by which point Enter
       * has already split the block and `preventDefault()` undoes nothing. That
       * produced two headings: the query text left behind as one, and the real
       * one after it.
       *
       * `handleKeyDown` is ProseMirror's own hook; returning true consumes the
       * key before any default behaviour runs.
       */
      handleKeyDown(view, event) {
        const query = slashRef.current;

        if (query === null) {
          if (event.key !== '/') return false;

          // Only at a word boundary, or typing "and/or" pops a menu mid-word.
          const { $from } = view.state.selection;
          const before = $from.parent.textBetween(
            Math.max(0, $from.parentOffset - 1),
            $from.parentOffset,
          );
          if (before === '' || before === ' ') {
            slashRef.current = '';
            setSlashQuery('');
            setHighlight(0);
          }
          // Let the "/" through: it is real text until a command replaces it.
          return false;
        }

        if (event.key === 'Escape') {
          closeSlash();
          return true;
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const next = highlightRef.current + (event.key === 'ArrowDown' ? 1 : -1);
          setHighlight(Math.max(0, Math.min(filteredRef.current.length - 1, next)));
          return true;
        }

        if (event.key === 'Enter') {
          const command = filteredRef.current[highlightRef.current];
          if (!command) {
            closeSlash();
            return false;
          }
          runRef.current(command);
          return true;
        }

        if (event.key === 'Backspace') {
          if (query === '') closeSlash();
          else {
            slashRef.current = query.slice(0, -1);
            setSlashQuery(slashRef.current);
          }
          return false;
        }

        if (event.key.length === 1) {
          slashRef.current = query + event.key;
          setSlashQuery(slashRef.current);
          setHighlight(0);
        }

        return false;
      },
    },
  });

  function closeSlash() {
    slashRef.current = null;
    setSlashQuery(null);
  }

  // Re-sync when the entry is reloaded from the server — after a save, a
  // publish or a version restore. Guarded on equality, because feeding the
  // editor its own output on every keystroke would reset the cursor to the top
  // of the document mid-sentence.
  useEffect(() => {
    if (!editor || !isDocument(value)) return;
    const current = editor.getJSON();
    if (JSON.stringify(current) === JSON.stringify(value)) return;
    editor.commands.setContent(value, false);
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const commands = useMemo(() => (editor ? blockCommands(editor, () => setPicking(true)) : []), [editor]);

  const filtered = useMemo(() => {
    if (slashQuery === null) return [];
    const term = slashQuery.toLowerCase();
    return commands.filter(
      (command) =>
        command.label.toLowerCase().includes(term) ||
        command.keywords.some((keyword) => keyword.includes(term)),
    );
  }, [commands, slashQuery]);

  const runCommand = useCallback(
    (command: BlockCommand) => {
      if (!editor) return;

      // Remove the "/query" the user typed, or it is left stranded in the block.
      //
      // The range comes from the *document*, not from a character count. React
      // state lags behind fast typing, so measuring the deletion that way
      // removed the wrong number of characters; searching back for the "/"
      // cannot be stale, because it inspects the text actually on screen.
      const { $from, from } = editor.state.selection;
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
      const slashAt = textBefore.lastIndexOf('/');

      if (slashAt !== -1) {
        editor
          .chain()
          .focus()
          .deleteRange({ from: from - (textBefore.length - slashAt), to: from })
          .run();
      }

      slashRef.current = null;
      setSlashQuery(null);
      command.run();
    },
    [editor],
  );

  // Kept current for `handleKeyDown`, which is registered once and would
  // otherwise read whatever these were when the editor was constructed.
  filteredRef.current = filtered;
  highlightRef.current = highlight;
  runRef.current = runCommand;

  if (!editor) return null;

  return (
    <div className="space-y-2" ref={containerRef}>
      <Toolbar editor={editor} disabled={disabled} onPickImage={() => setPicking(true)} />

      <div className="grid gap-4 lg:grid-cols-[10rem_1fr]">
        <Outline editor={editor} />

        <div className="relative min-w-0">
          <BubbleMenu
            editor={editor}
            tippyOptions={{ duration: 100 }}
            className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-lg"
          >
            <SelectionButtons editor={editor} />
          </BubbleMenu>

          <div className="rounded-lg border border-border bg-surface px-3 py-2">
            <EditorContent editor={editor} />
          </div>

          {slashQuery !== null && filtered.length > 0 && (
            <div className="absolute left-3 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
              <ul className="max-h-72 overflow-y-auto py-1">
                {filtered.map((command, index) => (
                  <li key={command.label}>
                    <button
                      type="button"
                      // mousedown, not click: click fires after blur, and the
                      // editor losing focus first collapses the selection the
                      // command needs.
                      onMouseDown={(event) => {
                        event.preventDefault();
                        runCommand(command);
                      }}
                      onMouseEnter={() => setHighlight(index)}
                      className={cx(
                        'flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm',
                        index === highlight ? 'bg-surface-subtle text-text' : 'text-text-secondary',
                      )}
                    >
                      <span className="font-medium text-text">{command.label}</span>
                      <span className="truncate text-xs text-text-secondary">{command.hint}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {picking && (
        <MediaImagePicker
          onClose={() => setPicking(false)}
          onPicked={(image) => {
            setPicking(false);
            editor
              .chain()
              .focus()
              .setImage({ src: image.url, alt: image.alt })
              .updateAttributes('image', { assetId: image.id })
              .run();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BlockCommand {
  label: string;
  hint: string;
  keywords: string[];
  run: () => void;
}

function blockCommands(editor: Editor, pickImage: () => void): BlockCommand[] {
  const chain = () => editor.chain().focus();

  return [
    { label: 'Heading 2', hint: 'Section title', keywords: ['h2', 'title'], run: () => chain().setNode('heading', { level: 2 }).run() },
    { label: 'Heading 3', hint: 'Sub-section', keywords: ['h3'], run: () => chain().setNode('heading', { level: 3 }).run() },
    { label: 'Heading 4', hint: 'Minor heading', keywords: ['h4'], run: () => chain().setNode('heading', { level: 4 }).run() },
    { label: 'Bullet list', hint: 'Unordered', keywords: ['ul', 'list'], run: () => chain().toggleBulletList().run() },
    { label: 'Numbered list', hint: 'Ordered', keywords: ['ol', 'list'], run: () => chain().toggleOrderedList().run() },
    { label: 'Quote', hint: 'Pull quote', keywords: ['blockquote'], run: () => chain().toggleBlockquote().run() },
    { label: 'Code block', hint: 'Preformatted', keywords: ['pre', 'snippet'], run: () => chain().toggleCodeBlock().run() },
    { label: 'Divider', hint: 'Horizontal rule', keywords: ['hr', 'rule'], run: () => chain().setHorizontalRule().run() },
    { label: 'Image', hint: 'From the media library', keywords: ['img', 'photo', 'media'], run: pickImage },
    {
      label: 'Table',
      hint: '3×3 with a header row',
      keywords: ['grid'],
      run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      label: 'Callout',
      hint: 'Aside — note or warning',
      keywords: ['note', 'aside', 'warning'],
      run: () =>
        chain()
          .insertContent({ type: 'callout', attrs: { tone: 'info' }, content: [{ type: 'paragraph' }] })
          .run(),
    },
    {
      label: 'Button',
      hint: 'Call to action',
      keywords: ['cta', 'link'],
      run: () => {
        const href = window.prompt('Where should the button link to?');
        if (!href) return;
        const label = window.prompt('Button text', 'Read more') ?? 'Read more';
        chain().insertContent({ type: 'cta', attrs: { href, label, variant: 'primary' } }).run();
      },
    },
    {
      label: 'Embed',
      hint: 'YouTube, Vimeo, X or any URL',
      keywords: ['video', 'youtube', 'iframe'],
      run: () => {
        const src = window.prompt('Paste the URL to embed');
        if (!src) return;
        chain().insertContent({ type: 'embed', attrs: { src, provider: providerFor(src) } }).run();
      },
    },
  ];
}

function Toolbar({
  editor,
  disabled,
  onPickImage,
}: {
  editor: Editor;
  disabled?: boolean;
  onPickImage: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-surface-subtle p-1">
      <ToolButton editor={editor} label="H2" active={{ name: 'heading', attrs: { level: 2 } }} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
      <ToolButton editor={editor} label="H3" active={{ name: 'heading', attrs: { level: 3 } }} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
      <Divider />
      <ToolButton editor={editor} label="B" bold active={{ name: 'bold' }} onClick={() => editor.chain().focus().toggleBold().run()} />
      <ToolButton editor={editor} label="I" italic active={{ name: 'italic' }} onClick={() => editor.chain().focus().toggleItalic().run()} />
      <ToolButton editor={editor} label="</>" active={{ name: 'code' }} onClick={() => editor.chain().focus().toggleCode().run()} />
      <Divider />
      <ToolButton editor={editor} label="•" active={{ name: 'bulletList' }} onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <ToolButton editor={editor} label="1." active={{ name: 'orderedList' }} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      <ToolButton editor={editor} label="❝" active={{ name: 'blockquote' }} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
      <Divider />
      <ToolButton editor={editor} label="Image" onClick={onPickImage} />
      <ToolButton editor={editor} label="Link" active={{ name: 'link' }} onClick={() => promptForLink(editor)} />
      <span className="ml-auto pr-1 text-[11px] text-text-secondary">
        {disabled ? 'Read only' : 'Press / for blocks'}
      </span>
    </div>
  );
}

function SelectionButtons({ editor }: { editor: Editor }) {
  return (
    <>
      <ToolButton editor={editor} label="B" bold active={{ name: 'bold' }} onClick={() => editor.chain().focus().toggleBold().run()} />
      <ToolButton editor={editor} label="I" italic active={{ name: 'italic' }} onClick={() => editor.chain().focus().toggleItalic().run()} />
      <ToolButton editor={editor} label="S" strike active={{ name: 'strike' }} onClick={() => editor.chain().focus().toggleStrike().run()} />
      <ToolButton editor={editor} label="</>" active={{ name: 'code' }} onClick={() => editor.chain().focus().toggleCode().run()} />
      <ToolButton editor={editor} label="Link" active={{ name: 'link' }} onClick={() => promptForLink(editor)} />
    </>
  );
}

function ToolButton({
  editor,
  label,
  active,
  bold,
  italic,
  strike,
  onClick,
}: {
  editor: Editor;
  label: string;
  active?: { name: string; attrs?: Record<string, unknown> };
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  onClick: () => void;
}) {
  const isActive = active ? editor.isActive(active.name, active.attrs) : false;

  return (
    <button
      type="button"
      // Without this the editor blurs on mousedown and the selection the
      // command is about to act on is gone by the time it runs.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      aria-pressed={isActive}
      className={cx(
        'rounded px-2 py-1 text-xs',
        bold && 'font-bold',
        italic && 'italic',
        strike && 'line-through',
        isActive ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface hover:text-text',
      )}
    >
      {label}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-4 w-px bg-border" />;
}

/**
 * The document outline of §7.3.
 *
 * Derived from the document on every render rather than kept in state: it is
 * cheap, and a cached outline that disagrees with the headings on screen is
 * worse than none.
 */
function Outline({ editor }: { editor: Editor }) {
  const headings: { level: number; text: string; pos: number }[] = [];

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      headings.push({ level: node.attrs.level as number, text: node.textContent, pos });
    }
  });

  if (headings.length === 0) {
    return (
      <aside className="hidden lg:block">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text/60">Outline</p>
        <p className="mt-1 text-xs text-text-secondary">Headings appear here.</p>
      </aside>
    );
  }

  return (
    <aside className="hidden lg:block">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text/60">Outline</p>
      <ul className="mt-1 space-y-0.5">
        {headings.map((heading) => (
          <li key={heading.pos}>
            <button
              type="button"
              onClick={() =>
                editor.chain().focus().setTextSelection(heading.pos + 1).scrollIntoView().run()
              }
              className="block w-full truncate text-left text-xs text-text-secondary hover:text-text"
              style={{ paddingLeft: `${(heading.level - 2) * 10}px` }}
              title={heading.text}
            >
              {heading.text || 'Untitled heading'}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** Picks an asset, then resolves its URL — MediaPicker returns ids only. */
function MediaImagePicker({
  onClose,
  onPicked,
}: {
  onClose: () => void;
  onPicked: (image: { id: string; url: string; alt: string }) => void;
}) {
  const { currentWorkspace } = useSession();

  return (
    <MediaPicker
      value={[]}
      multiple={false}
      onClose={onClose}
      onChange={async (ids) => {
        const id = ids[0];
        if (!id) return;

        const asset = await api.get<{ url: string | null; alt_text: string | null }>(
          `/admin/v1/workspaces/${currentWorkspace?.id}/media/${id}`,
        );
        if (asset.url) onPicked({ id, url: asset.url, alt: asset.alt_text ?? '' });
      }}
    />
  );
}

function promptForLink(editor: Editor) {
  const existing = editor.getAttributes('link').href as string | undefined;
  const href = window.prompt('Link to', existing ?? 'https://');

  if (href === null) return;
  if (href === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }

  editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

// ---------------------------------------------------------------------------

function isDocument(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: string }).type === 'doc'
  );
}

function emptyDocument() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}
