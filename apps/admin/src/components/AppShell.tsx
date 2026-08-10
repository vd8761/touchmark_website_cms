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
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [{ label: 'Dashboard', to: '', ready: true }],
  },
  {
    section: 'Content',
    items: [
      // Content types are inserted here at runtime — see contentTypeItems().
      { label: 'Content types', to: 'settings/content-types', permission: 'contenttype.manage', ready: true },
      { label: 'Media', to: 'media', permission: 'media.view', ready: true },
      { label: 'Taxonomies', to: 'taxonomies', permission: 'taxonomy.view', ready: true },
      { label: 'Menus', to: 'menus', permission: 'menu.manage', ready: true },
    ],
  },
  {
    section: 'Audience',
    items: [
      { label: 'Subscribers', to: 'subscribers', permission: 'subscriber.view' },
      { label: 'Lists & segments', to: 'lists', permission: 'list.manage' },
      { label: 'Forms', to: 'forms', permission: 'form.view' },
    ],
  },
  {
    section: 'Email',
    items: [
      { label: 'Campaigns', to: 'campaigns', permission: 'campaign.view' },
      { label: 'Automations', to: 'automations', permission: 'automation.manage' },
      { label: 'Sending', to: 'settings/email', permission: 'senderidentity.manage', ready: true },
    ],
  },
  {
    section: 'Developers',
    items: [
      { label: 'API keys', to: 'api-keys', permission: 'apikey.manage', ready: true },
      { label: 'Webhooks', to: 'webhooks', permission: 'webhook.manage', ready: true },
      { label: 'Logs', to: 'logs', permission: 'apilog.view', ready: true },
    ],
  },
  {
    section: 'Settings',
    items: [
      { label: 'Site settings', to: 'settings', permission: 'workspace.settings.edit', ready: true },
      { label: 'Email configurations', to: 'settings/org/email', orgOnly: true, ready: true },
      { label: 'Members', to: 'settings/members', permission: 'workspace.view', ready: true },
      { label: 'Audit log', to: 'settings/audit-log', permission: 'auditlog.view', ready: true },
    ],
  },
];

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

        <nav className="flex-1 overflow-y-auto p-2">
          {NAV.map((group) => {
            const dynamic: NavItem[] =
              group.section === 'Content'
                ? (contentTypes.data?.items ?? []).map((type) => ({
                    label: type.name,
                    to: `content/${type.api_id}`,
                    permission: 'content.view' as Permission,
                    ready: true,
                  }))
                : [];

            const items = [...dynamic, ...group.items].filter((item) =>
              item.orgOnly ? isOrgAdmin : !item.permission || can(item.permission),
            );
            if (items.length === 0) return null;

            return (
              <div key={group.section} className="mb-4">
                {!collapsed && (
                  <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
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
                            'flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm',
                            isActive
                              ? 'bg-surface-subtle font-semibold text-text'
                              : 'text-text-secondary hover:bg-surface-subtle hover:text-text',
                            collapsed && 'justify-center',
                          )
                        }
                      >
                        <span className={cx('truncate', collapsed && 'sr-only')}>{item.label}</span>
                        {collapsed && <span aria-hidden>{item.label[0]}</span>}
                        {!collapsed && item.ready === undefined && (
                          <span className="text-[10px] text-text-secondary">soon</span>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
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
