import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Button, Card, EmptyState, ErrorState, Input, Skeleton } from '../components/primitives';
import { EntryPicker } from '../components/EntryPicker';
import type { ContentTypeDto } from '../lib/content-types';
import { useSession } from '../lib/session';

interface MenuSummary {
  id: string;
  name: string;
  api_id: string;
  item_count: number;
}

interface MenuItem {
  id?: string;
  label: string;
  link_type: 'entry' | 'url' | 'term' | 'none';
  entry_id?: string | null;
  url?: string | null;
  target?: '_self' | '_blank';
  visible?: boolean;
  children?: MenuItem[];
}

interface MenuDetail {
  id: string;
  name: string;
  api_id: string;
  items: MenuItem[];
}

const MAX_DEPTH = 3;

/**
 * The menu builder (§17.8).
 *
 * Save is explicit and replaces the whole tree in one request — §17.8 is
 * specific that menus "are too easy to break by autosave". The live JSON
 * preview shows exactly what `GET /v1/menus/{api_id}` will return.
 */
export function Menus() {
  const { currentWorkspace, can } = useSession();
  const queryClient = useQueryClient();
  const ws = currentWorkspace?.id;
  const base = `/admin/v1/workspaces/${ws}/menus`;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const menusQuery = useQuery({
    queryKey: ['menus', ws],
    queryFn: () => api.list<MenuSummary>(base),
    enabled: Boolean(ws),
  });

  const create = useMutation({
    mutationFn: () => api.post<MenuDetail>(base, { name: newName }),
    onSuccess: (menu) => {
      setNewName('');
      setSelectedId(menu.id);
      void queryClient.invalidateQueries({ queryKey: ['menus', ws] });
    },
  });

  const manageable = can('menu.manage');

  if (menusQuery.isLoading) return <Skeleton rows={4} />;

  if (menusQuery.error) {
    const apiError = menusQuery.error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load menus"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void menusQuery.refetch()}
      />
    );
  }

  const menus = menusQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">Menus</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Navigation structures your site fetches and renders. Up to three levels deep.
        </p>
      </header>

      {manageable && (
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New menu name"
            className="max-w-xs"
          />
          <Button
            variant="secondary"
            loading={create.isPending}
            disabled={!newName}
            onClick={() => create.mutate()}
          >
            ＋ Create menu
          </Button>
        </div>
      )}

      {menus.length === 0 ? (
        <EmptyState
          title="No menus yet"
          description="Create one — a main navigation, a footer — and your site can fetch it as a nested tree."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <ul className="space-y-2">
            {menus.map((menu) => (
              <li key={menu.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(menu.id)}
                  className={`w-full rounded-xl border p-4 text-left ${
                    menu.id === selectedId
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-surface hover:bg-surface-subtle'
                  }`}
                >
                  <span className="font-medium text-text">{menu.name}</span>
                  <p className="mt-1 font-mono text-xs text-text-secondary">{menu.api_id}</p>
                  <p className="mt-1 text-xs text-text-secondary">{menu.item_count} items</p>
                </button>
              </li>
            ))}
          </ul>

          {selectedId ? (
            <MenuEditor key={selectedId} menuId={selectedId} base={base} editable={manageable} />
          ) : (
            <Card>
              <p className="text-sm text-text-secondary">Select a menu to edit its items.</p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function MenuEditor({
  menuId,
  base,
  editable,
}: {
  menuId: string;
  base: string;
  editable: boolean;
}) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<MenuItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const menuQuery = useQuery({
    queryKey: ['menu', menuId],
    queryFn: () => api.get<MenuDetail>(`${base}/${menuId}`),
  });

  // Menu items can link to an entry of any type, so the picker needs the list.
  const workspaceBase = base.replace(/\/menus$/, '');
  const typesQuery = useQuery({
    queryKey: ['content-types-for-menu', workspaceBase],
    queryFn: () => api.list<ContentTypeDto>(`${workspaceBase}/content-types`),
  });
  const contentTypes = typesQuery.data?.items ?? [];

  useEffect(() => {
    if (menuQuery.data) {
      setItems(menuQuery.data.items ?? []);
      setDirty(false);
    }
  }, [menuQuery.data]);

  const save = useMutation({
    mutationFn: () => api.post<MenuDetail>(`${base}/${menuId}/items`, { items: strip(items) }),
    onSuccess: (menu) => {
      setItems(menu.items ?? []);
      setDirty(false);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['menus'] });
    },
    onError: (e) => setError(e as ApiError),
  });

  function mutate(fn: (draft: MenuItem[]) => MenuItem[]) {
    setItems((current) => fn(structuredClone(current)));
    setDirty(true);
  }

  if (menuQuery.isLoading) return <Skeleton rows={5} />;

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">{menuQuery.data?.name}</h2>
          {editable && (
            <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
              {dirty ? 'Save menu' : 'Saved'}
            </Button>
          )}
        </div>
        <p className="font-mono text-xs text-text-secondary">
          GET /v1/menus/{menuQuery.data?.api_id}
        </p>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text">Items</h3>

        {items.length === 0 ? (
          <p className="text-sm text-text-secondary">No items yet.</p>
        ) : (
          <ItemList
            items={items}
            path={[]}
            depth={1}
            editable={editable}
            contentTypes={contentTypes}
            onChange={(path, patch) => mutate((draft) => updateAt(draft, path, patch))}
            onRemove={(path) => mutate((draft) => removeAt(draft, path))}
            onAddChild={(path) => mutate((draft) => addChildAt(draft, path))}
            onMove={(path, delta) => mutate((draft) => moveAt(draft, path, delta))}
          />
        )}

        {editable && (
          <Button
            variant="secondary"
            onClick={() =>
              mutate((draft) => [
                ...draft,
                { label: 'New item', link_type: 'url', url: '', target: '_self', visible: true },
              ])
            }
          >
            ＋ Add item
          </Button>
        )}

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
            <p className="text-sm text-text">{error.message}</p>
            {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
          </div>
        )}
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-text">API preview</h3>
        <p className="mt-0.5 text-xs text-text-secondary">
          Exactly what the Delivery API will return for this menu.
        </p>
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-subtle p-3 text-xs">
          {JSON.stringify(strip(items), null, 2)}
        </pre>
      </Card>
    </div>
  );
}

function ItemList({
  items,
  path,
  depth,
  editable,
  contentTypes,
  onChange,
  onRemove,
  onAddChild,
  onMove,
}: {
  items: MenuItem[];
  path: number[];
  depth: number;
  editable: boolean;
  contentTypes: ContentTypeDto[];
  onChange: (path: number[], patch: Partial<MenuItem>) => void;
  onRemove: (path: number[]) => void;
  onAddChild: (path: number[]) => void;
  onMove: (path: number[], delta: number) => void;
}) {
  return (
    <ul className={depth > 1 ? 'ml-4 border-l border-border pl-3' : ''}>
      {items.map((item, index) => {
        const here = [...path, index];
        return (
          <li key={here.join('-')} className="py-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={item.label}
                disabled={!editable}
                onChange={(e) => onChange(here, { label: e.target.value })}
                className="max-w-[12rem]"
              />
              <select
                value={item.link_type}
                disabled={!editable}
                onChange={(e) => onChange(here, { link_type: e.target.value as MenuItem['link_type'] })}
                className="rounded-lg border border-border bg-surface px-2 py-2 text-sm"
              >
                <option value="url">URL</option>
                <option value="entry">Entry</option>
                <option value="none">No link</option>
              </select>

              {item.link_type === 'url' && (
                <Input
                  value={item.url ?? ''}
                  disabled={!editable}
                  placeholder="https://"
                  onChange={(e) => onChange(here, { url: e.target.value })}
                  className="max-w-[16rem]"
                />
              )}
              {item.link_type === 'entry' && (
                <MenuEntryLink
                  entryId={item.entry_id ?? null}
                  contentTypes={contentTypes}
                  editable={editable}
                  onChange={(entryId) => onChange(here, { entry_id: entryId })}
                />
              )}

              {editable && (
                <div className="flex items-center gap-1 text-xs">
                  <button type="button" onClick={() => onMove(here, -1)} className="px-1 text-text-secondary hover:text-text" aria-label="Move up">
                    ↑
                  </button>
                  <button type="button" onClick={() => onMove(here, 1)} className="px-1 text-text-secondary hover:text-text" aria-label="Move down">
                    ↓
                  </button>
                  {/* The depth cap matches the API's, so an over-nested tree is
                      never built and then rejected on save. */}
                  {depth < MAX_DEPTH && (
                    <button type="button" onClick={() => onAddChild(here)} className="px-1 text-accent hover:underline">
                      ＋ child
                    </button>
                  )}
                  <button type="button" onClick={() => onRemove(here)} className="px-1 text-danger hover:underline">
                    Remove
                  </button>
                </div>
              )}
            </div>

            {item.children && item.children.length > 0 && (
              <ItemList
                items={item.children}
                path={here}
                depth={depth + 1}
                editable={editable}
                contentTypes={contentTypes}
                onChange={onChange}
                onRemove={onRemove}
                onAddChild={onAddChild}
                onMove={onMove}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// -- tree helpers ------------------------------------------------------------

function nodeAt(items: MenuItem[], path: number[]): { list: MenuItem[]; index: number } {
  let list = items;
  for (const step of path.slice(0, -1)) {
    list = list[step].children ?? (list[step].children = []);
  }
  return { list, index: path[path.length - 1] };
}

function updateAt(items: MenuItem[], path: number[], patch: Partial<MenuItem>): MenuItem[] {
  const { list, index } = nodeAt(items, path);
  list[index] = { ...list[index], ...patch };
  return items;
}

function removeAt(items: MenuItem[], path: number[]): MenuItem[] {
  const { list, index } = nodeAt(items, path);
  list.splice(index, 1);
  return items;
}

function addChildAt(items: MenuItem[], path: number[]): MenuItem[] {
  const { list, index } = nodeAt(items, path);
  list[index].children = [
    ...(list[index].children ?? []),
    { label: 'New item', link_type: 'url', url: '', target: '_self', visible: true },
  ];
  return items;
}

function moveAt(items: MenuItem[], path: number[], delta: number): MenuItem[] {
  const { list, index } = nodeAt(items, path);
  const target = index + delta;
  if (target < 0 || target >= list.length) return items;
  [list[index], list[target]] = [list[target], list[index]];
  return items;
}

/**
 * Server-assigned ids are dropped before saving: the API replaces the whole
 * tree, so sending stale ids would imply an update semantics it does not have.
 */
function strip(items: MenuItem[]): MenuItem[] {
  return items.map((item) => ({
    label: item.label,
    link_type: item.link_type,
    ...(item.link_type === 'entry' ? { entry_id: item.entry_id ?? null } : {}),
    ...(item.link_type === 'url' ? { url: item.url ?? '' } : {}),
    target: item.target ?? '_self',
    visible: item.visible ?? true,
    ...(item.children?.length ? { children: strip(item.children) } : {}),
  }));
}


/**
 * An entry link in a menu.
 *
 * Menu items may point at an entry of any type, but the entry search is
 * per-type, so the type comes first. The alternative — a cross-type search
 * endpoint — is not worth adding for a field that is set once and rarely
 * changed.
 *
 * Whatever the picker resolves to, the Delivery API renders the entry's
 * *current* slug at request time (§7.6), so renaming a page never breaks a menu.
 */
function MenuEntryLink({
  entryId,
  contentTypes,
  editable,
  onChange,
}: {
  entryId: string | null;
  contentTypes: ContentTypeDto[];
  editable: boolean;
  onChange: (entryId: string | null) => void;
}) {
  const [typeApiId, setTypeApiId] = useState(contentTypes[0]?.api_id ?? '');

  return (
    <div className="flex min-w-[20rem] flex-1 items-start gap-2">
      <select
        value={typeApiId}
        disabled={!editable}
        onChange={(event) => setTypeApiId(event.target.value)}
        className="rounded-lg border border-border bg-surface px-2 py-2 text-sm"
      >
        {contentTypes.map((type) => (
          <option key={type.id} value={type.api_id}>
            {type.name}
          </option>
        ))}
      </select>

      <div className="flex-1">
        <EntryPicker
          value={entryId}
          multiple={false}
          typeApiId={typeApiId || undefined}
          disabled={!editable}
          onChange={(next) => onChange((next as string | null) ?? null)}
        />
      </div>
    </div>
  );
}
