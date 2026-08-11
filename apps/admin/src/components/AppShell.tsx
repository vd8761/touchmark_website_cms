import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Permission } from '@cms/shared';

import { api } from '../lib/api';
import type { ContentTypeDto } from '../lib/content-types';
import { useSession } from '../lib/session';
import { cx } from './primitives';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * The app shell of §17.2: fixed sidebar, top bar with the workspace switcher,
 * and the main region.
 *
 * Sidebar items the user's role cannot reach are omitted entirely rather than
 * disabled — §17.2 is explicit about this, and a disabled item that never
 * becomes enabled is just a durable source of confusion.
 */

interface NavItem {
  label: string;
  to: string;
  permission?: Permission;
  /** Gated on an organisation role rather than a site role. */
  orgOnly?: boolean;
  /** Phase this arrives in; items beyond Phase 0 are shown as "soon". */
  ready?: boolean;
  icon: IconName;
}

/**
 * The grouping answers one question per section: what is this thing *for*?
 *
 * CONTENT holds only the entries people write — the content types that define
 * them are not content, they are the schema, and mixing the two put "Blog
 * posts" in the same list as "Content types" and made both harder to find.
 * STRUCTURE is how content is organised (taxonomies, menus, the media it draws
 * on); CONFIGURATION is everything you set up once and rarely touch, including
 * the content model. Site- and organisation-level configuration are separated
 * by a labelled sub-heading rather than being interleaved, because "Members"
 * and "Email configurations" answering to different scopes was invisible.
 */
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [{ label: 'Dashboard', to: '', ready: true, icon: 'dashboard' }],
  },
  {
    // Content types are inserted here at runtime, and nothing else lives here —
    // see the `dynamic` list in the render below.
    section: 'Content',
    items: [],
  },
  {
    section: 'Structure',
    items: [
      { label: 'Media', to: 'media', permission: 'media.view', ready: true, icon: 'media' },
      { label: 'Taxonomies', to: 'taxonomies', permission: 'taxonomy.view', ready: true, icon: 'tag' },
      { label: 'Menus', to: 'menus', permission: 'menu.manage', ready: true, icon: 'menu' },
    ],
  },
  {
    section: 'Audience',
    items: [
      { label: 'Subscribers', to: 'subscribers', permission: 'subscriber.view', icon: 'people' },
      { label: 'Lists & segments', to: 'lists', permission: 'list.manage', icon: 'list' },
      { label: 'Forms', to: 'forms', permission: 'form.view', icon: 'form' },
    ],
  },
  {
    section: 'Email',
    items: [
      { label: 'Campaigns', to: 'campaigns', permission: 'campaign.view', icon: 'send' },
      { label: 'Automations', to: 'automations', permission: 'automation.manage', icon: 'bolt' },
    ],
  },
  {
    section: 'Developers',
    items: [
      { label: 'API keys', to: 'api-keys', permission: 'apikey.manage', ready: true, icon: 'key' },
      { label: 'Webhooks', to: 'webhooks', permission: 'webhook.manage', ready: true, icon: 'webhook' },
      { label: 'Request logs', to: 'logs', permission: 'apilog.view', ready: true, icon: 'logs' },
    ],
  },
  {
    section: 'Site configuration',
    items: [
      {
        label: 'Content model',
        to: 'settings/content-types',
        permission: 'contenttype.manage',
        ready: true,
        icon: 'schema',
      },
      { label: 'Site settings', to: 'settings', permission: 'workspace.settings.edit', ready: true, icon: 'settings' },
      { label: 'Site members', to: 'settings/members', permission: 'workspace.view', ready: true, icon: 'people' },
      { label: 'Sending', to: 'settings/email', permission: 'senderidentity.manage', ready: true, icon: 'send' },
      { label: 'Audit log', to: 'settings/audit-log', permission: 'auditlog.view', ready: true, icon: 'logs' },
    ],
  },
  {
    section: 'Organisation',
    items: [
      { label: 'Organisation settings', to: 'settings/org', orgOnly: true, ready: true, icon: 'building' },
      { label: 'Email configurations', to: 'settings/org/email', orgOnly: true, ready: true, icon: 'mail' },
    ],
  },
];

/**
 * Icons, inline rather than from a library.
 *
 * Two reasons: the collapsed rail was showing the first letter of each label,
 * which made "Media" and "Menus" identical, and the expanded list had nothing
 * to anchor the eye — every row was the same weight of grey text, which is what
 * made the titles hard to pick out. Fourteen 24×24 paths are cheaper than a
 * dependency and never drift out of step with the palette, since they inherit
 * `currentColor`.
 */
const ICONS = {
  dashboard: 'M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z',
  doc: 'M6 2h7l5 5v15H6V2Zm7 1.5V8h4.5M9 13h6M9 17h6',
  media: 'M3 5h18v14H3V5Zm0 10 5-5 4 4 3-3 6 6M8.5 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z',
  tag: 'M3 3h8l10 10-8 8L3 11V3Zm4 4h.01',
  menu: 'M4 6h16M4 12h16M4 18h10',
  people: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  form: 'M4 3h16v18H4V3Zm4 5h8M8 12h8M8 16h4',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  key: 'M14 7a4 4 0 1 1-3.2 6.4L4 20H2v-2l6.6-6.8A4 4 0 0 1 14 7Zm2.5 2.5h.01',
  webhook: 'M9 8a3 3 0 1 1 5 2.2L17 16m-9-3-3 5m1-1a3 3 0 1 0 3 3h8a3 3 0 1 0-3-3',
  logs: 'M4 4h16v16H4V4Zm3 4h10M7 12h10M7 16h6',
  schema: 'M9 3h6v4H9V3ZM3 17h6v4H3v-4Zm12 0h6v4h-6v-4ZM12 7v4M6 17v-2h12v2',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8.4-3a8.4 8.4 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a8.4 8.4 0 0 0-2.2-1.3L15.4 3h-4l-.4 2.5a8.4 8.4 0 0 0-2.2 1.3l-2.3-1-2 3.4 2 1.5a8.4 8.4 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1a8.4 8.4 0 0 0 2.2 1.3l.4 2.5h4l.4-2.5a8.4 8.4 0 0 0 2.2-1.3l2.3 1 2-3.4-2-1.5c.06-.43.1-.86.1-1.3Z',
  building: 'M3 21h18M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M15 9h3a1 1 0 0 1 1 1v11M9 7h2M9 11h2M9 15h2',
  mail: 'M3 5h18v14H3V5Zm0 1 9 7 9-7',
} as const;

type IconName = keyof typeof ICONS;

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function AppShell() {
  const { currentOrg, currentWorkspace, can, loading } = useSession();
  // Provider credentials are organisation property, so the link is shown to
  // organisation Owners and Admins rather than to Site Admins.
  const isOrgAdmin = currentOrg?.role === 'owner' || currentOrg?.role === 'admin';

  // §17.2: "Content types appear dynamically under CONTENT with their
  // configured icons and order." The sidebar is therefore data-driven, not a
  // static list — a type created a moment ago shows up without a deploy.
  const contentTypes = useQuery({
    queryKey: ['content-types', currentWorkspace?.id],
    queryFn: () =>
      api.list<ContentTypeDto>(`/admin/v1/workspaces/${currentWorkspace?.id}/content-types`),
    enabled: Boolean(currentWorkspace?.id) && can('content.view'),
    staleTime: 60_000,
  });
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('cms.sidebar-collapsed') === 'true',
  );

  // `[` collapses the sidebar to an icon rail; the state is per user (§17.2).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable;
      if (!typing && event.key === '[') {
        setCollapsed((value) => {
          localStorage.setItem('cms.sidebar-collapsed', String(!value));
          return !value;
        });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (loading) {
    return <div className="grid h-full place-items-center text-sm text-text-secondary">Loading…</div>;
  }

  const base = `/o/${currentOrg?.slug ?? ''}/s/${currentWorkspace?.slug ?? ''}`;

  async function signOut() {
    await api.post('/admin/v1/auth/logout').catch(() => undefined);
    navigate('/login');
  }

  return (
    <div className="flex h-full">
      <aside
        className={cx(
          'flex shrink-0 flex-col border-r border-border bg-surface transition-all',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        <div className="border-b border-border p-2">
          {collapsed ? (
            <div
              aria-hidden
              className="mx-auto h-8 w-8 rounded-lg"
              style={{ backgroundColor: currentWorkspace?.colour ?? '#4F46E5' }}
            />
          ) : (
            <WorkspaceSwitcher />
          )}
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-2 py-3">
          {NAV.map((group, groupIndex) => {
            const dynamic: NavItem[] =
              group.section === 'Content'
                ? (contentTypes.data?.items ?? []).map((type) => ({
                    label: type.name,
                    to: `content/${type.api_id}`,
                    permission: 'content.view' as Permission,
                    ready: true,
                    icon: 'doc' as IconName,
                  }))
                : [];

            const items = [...dynamic, ...group.items].filter((item) =>
              item.orgOnly ? isOrgAdmin : !item.permission || can(item.permission),
            );
            if (items.length === 0) return null;

            return (
              <div key={group.section}>
                {collapsed ? (
                  // A hairline stands in for the heading, so the rail keeps the
                  // grouping instead of collapsing into one undifferentiated
                  // column of icons.
                  groupIndex > 0 && <div aria-hidden className="mx-3 mb-2 border-t border-border" />
                ) : (
                  // Bumped from 10px/secondary to 11px at 60% of the *primary*
                  // text colour: the old headings sat at the same weight and
                  // colour as the items beneath them, so the groups read as one
                  // long list and the titles were easy to miss entirely.
                  <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text/60">
                    {group.section}
                  </p>
                )}
                <ul className="space-y-0.5">
                  {items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to ? `${base}/${item.to}` : base}
                        end={item.to === ''}
                        title={collapsed ? item.label : undefined}
                        className={({ isActive }) =>
                          cx(
                            // The active row gets a left marker as well as a
                            // fill: on a subtle palette a background change
                            // alone is easy to miss, and "where am I" is the
                            // question the sidebar exists to answer.
                            'relative flex items-center gap-2.5 rounded-lg py-1.5 pl-2.5 pr-2 text-sm',
                            'before:absolute before:left-0 before:top-1/2 before:h-4 before:w-0.5',
                            'before:-translate-y-1/2 before:rounded-full',
                            isActive
                              ? 'bg-surface-subtle font-semibold text-text before:bg-accent'
                              : 'font-medium text-text-secondary hover:bg-surface-subtle hover:text-text',
                            collapsed && 'justify-center pl-2',
                          )
                        }
                      >
                        <Icon name={item.icon} />
                        <span className={cx('flex-1 truncate', collapsed && 'sr-only')}>
                          {item.label}
                        </span>
                        {!collapsed && item.ready === undefined && (
                          <span className="rounded bg-surface-subtle px-1 py-px text-[10px] font-medium uppercase text-text-secondary">
                            Soon
                          </span>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        {!collapsed && (
          <p className="border-t border-border px-3 py-2 text-[11px] text-text-secondary">
            Press <kbd className="rounded border border-border px-1">[</kbd> to collapse
          </p>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-4">
          <div className="text-sm text-text-secondary">
            {currentWorkspace?.status === 'archived' && (
              <span className="rounded-full bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">
                This site is archived and read-only
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg px-2.5 py-1.5 text-sm text-text-secondary hover:bg-surface-subtle"
              title="Command palette (⌘K) — arrives with the content module"
            >
              Search ⌘K
            </button>
            <button
              type="button"
              onClick={signOut}
              className="rounded-lg px-2.5 py-1.5 text-sm text-text-secondary hover:bg-surface-subtle"
            >
              Sign out
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
