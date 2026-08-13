import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OrganisationDto, WorkspaceDto } from '@cms/shared';

import { noteRecentSite, readRecentSites, useSession } from '../lib/session';
import { cx } from './primitives';

/**
 * The workspace switcher of §6.3 and §17.2.
 *
 * Behaviours the spec calls for, all implemented here:
 *  - org name above site name, with the site's colour chip;
 *  - a 640px popover: search at top, organisations left, that org's sites right;
 *  - recently used sites pinned to the top (last 5, per user);
 *  - `⌘\` opens it, arrow keys navigate, Escape closes;
 *  - switching preserves the current route where it exists in the target site,
 *    else falls back to that site's dashboard;
 *  - the URL is the source of truth, so links are shareable.
 */
export function WorkspaceSwitcher() {
  const { organisations, workspaces, currentOrg, currentWorkspace } = useSession();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedOrgId = activeOrgId ?? currentOrg?.id ?? organisations[0]?.id ?? null;

  const recents = useMemo(() => readRecentSites(), [open]);

  const visibleSites = useMemo(() => {
    const term = query.trim().toLowerCase();

    // A search spans every organisation — when you know the site's name you
    // should not have to remember which org it is in.
    const pool = term
      ? workspaces.filter((w) => w.name.toLowerCase().includes(term) || w.slug.includes(term))
      : workspaces.filter((w) => w.organisation_id === selectedOrgId);

    const rank = (site: WorkspaceDto) => {
      const index = recents.indexOf(site.id);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };

    return [...pool].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [query, workspaces, selectedOrgId, recents]);

  // ⌘\ / Ctrl+\ opens the switcher from anywhere (§6.3).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === 'Escape') setOpen(false);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      // Focus the search on open — the fastest path for someone with many sites.
      queueMicrotask(() => searchRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  function switchTo(site: WorkspaceDto) {
    const org = organisations.find((o) => o.id === site.organisation_id);
    if (!org) return;

    noteRecentSite(site.id);
    setOpen(false);

    // Preserve the current sub-route where it can exist in the target site.
    // Content-type routes are the exception — a type that does not exist there
    // would 404, so those fall back to the dashboard. With no content module
    // yet, only the settings sub-tree is known to be portable.
    const suffix = portableSuffix(window.location.pathname);
    navigate(`/o/${org.slug}/s/${site.slug}${suffix}`);
  }

  function onListKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, visibleSites.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const site = visibleSites[highlight];
      if (site) switchTo(site);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-subtle"
      >
        {currentOrg?.logo_url ? (
          <img
            src={currentOrg.logo_url}
            alt=""
            aria-hidden
            className="h-8 w-8 shrink-0 rounded-lg object-contain"
          />
        ) : (
          <span
            aria-hidden
            className="h-8 w-8 shrink-0 rounded-lg"
            style={{ backgroundColor: currentWorkspace?.colour ?? '#4F46E5' }}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-text-secondary">
            {currentOrg?.name ?? '—'}
          </span>
          <span className="block truncate text-sm font-semibold text-text">
            {currentWorkspace?.name ?? 'Select a site'}
          </span>
        </span>
        <span aria-hidden className="text-text-secondary">
          ⌄
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Switch site"
          className="absolute left-0 z-50 mt-1 w-[640px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-surface-raised shadow-xl"
          onKeyDown={onListKeyDown}
        >
          <div className="border-b border-border p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              placeholder="Search sites across all organisations…"
              className="w-full rounded-lg bg-surface-subtle px-3 py-2 text-sm outline-none placeholder:text-text-secondary"
            />
          </div>

          <div className="flex max-h-[380px]">
            <OrganisationList
              organisations={organisations}
              selectedId={selectedOrgId}
              disabled={query.trim().length > 0}
              onSelect={(id) => {
                setActiveOrgId(id);
                setHighlight(0);
              }}
            />

            <ul className="flex-1 overflow-y-auto p-1.5">
              {visibleSites.length === 0 && (
                <li className="px-3 py-8 text-center text-sm text-text-secondary">
                  No sites match “{query}”.
                </li>
              )}

              {visibleSites.map((site, index) => {
                const isRecent = recents.includes(site.id) && !query;
                return (
                  <li key={site.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => switchTo(site)}
                      className={cx(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                        index === highlight ? 'bg-surface-subtle' : 'hover:bg-surface-subtle',
                      )}
                    >
                      <span
                        aria-hidden
                        className="h-5 w-5 shrink-0 rounded"
                        style={{ backgroundColor: site.colour }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-text">{site.name}</span>
                        {query && (
                          <span className="block truncate text-xs text-text-secondary">
                            {organisations.find((o) => o.id === site.organisation_id)?.name}
                          </span>
                        )}
                      </span>
                      {site.status === 'archived' && (
                        <span className="text-xs text-text-secondary">Archived</span>
                      )}
                      {isRecent && !query && (
                        <span className="text-[10px] uppercase tracking-wide text-text-secondary">
                          Recent
                        </span>
                      )}
                      {site.id === currentWorkspace?.id && <span aria-hidden>✓</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* The id of the site you are currently in, one click from anywhere.
              Site settings has the full identifiers card; this is the shortcut
              for when you just need to paste it into a request. */}
          {currentWorkspace && (
            <div className="flex items-center gap-2 border-t border-border px-3 py-2">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                Site ID
              </span>
              <code className="min-w-0 flex-1 select-all truncate text-xs text-text-secondary">
                {currentWorkspace.id}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(currentWorkspace.id)}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-accent hover:bg-surface-subtle"
              >
                Copy
              </button>
            </div>
          )}

          <div className="border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate(`/o/${currentOrg?.slug ?? ''}/sites/new`);
              }}
              className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-accent hover:bg-surface-subtle"
            >
              ＋ New site
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OrganisationList({
  organisations,
  selectedId,
  disabled,
  onSelect,
}: {
  organisations: OrganisationDto[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <ul
      className={cx(
        'w-56 shrink-0 overflow-y-auto border-r border-border p-1.5',
        disabled && 'opacity-40',
      )}
    >
      <li className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
        Organisations
      </li>
      {organisations.map((org) => (
        <li key={org.id}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect(org.id)}
            className={cx(
              'w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm',
              org.id === selectedId ? 'bg-surface-subtle font-medium text-text' : 'text-text-secondary',
              !disabled && 'hover:bg-surface-subtle',
            )}
          >
            {org.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The part of the current path that is safe to carry into another site.
 *
 * §6.3 asks for the route to be preserved "where the route exists in the target
 * site". Rather than guess, this allows a small list of routes known to exist
 * in every site and sends everything else to the dashboard. Phase 1 extends it
 * by checking the target site's content types before preserving a content route.
 */
const PORTABLE_ROUTES = ['/settings', '/settings/members', '/media', '/subscribers'];

function portableSuffix(pathname: string): string {
  const match = /^\/o\/[^/]+\/s\/[^/]+(\/.*)?$/.exec(pathname);
  const suffix = match?.[1] ?? '';
  return PORTABLE_ROUTES.includes(suffix) ? suffix : '';
}
