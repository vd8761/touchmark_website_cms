import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type MeResponse,
  type OrganisationDto,
  type Permission,
  permissionsForWorkspaceRole,
  type WorkspaceDto,
} from '@cms/shared';

import { api, withRefresh } from './api';

interface SessionValue {
  me: MeResponse | null;
  loading: boolean;
  organisations: OrganisationDto[];
  workspaces: WorkspaceDto[];
  currentOrg: OrganisationDto | null;
  currentWorkspace: WorkspaceDto | null;
  /**
   * Permissions for the current site, computed from the same shared mapping the
   * server enforces with. The UI uses it to hide what a role cannot reach —
   * §17.2: "Items the user's role cannot access are hidden entirely, not shown
   * disabled." This is presentation only; the server decides.
   */
  can: (permission: Permission) => boolean;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({
  children,
  orgSlug,
  siteSlug,
}: {
  children: ReactNode;
  orgSlug?: string;
  siteSlug?: string;
}) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => withRefresh(() => api.get<MeResponse>('/admin/v1/auth/me')),
    retry: false,
    staleTime: 60_000,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['me'] });
  }, [queryClient]);

  const value = useMemo<SessionValue>(() => {
    const organisations = data?.organisations ?? [];
    const workspaces = data?.workspaces ?? [];

    // The URL is the source of truth for which site is open (§6.3), so a
    // shared link always opens the site it names.
    const currentOrg =
      organisations.find((o) => o.slug === orgSlug) ?? organisations[0] ?? null;

    const inOrg = workspaces.filter((w) => w.organisation_id === currentOrg?.id);
    const currentWorkspace = inOrg.find((w) => w.slug === siteSlug) ?? inOrg[0] ?? null;

    const permissions = new Set<Permission>(
      currentWorkspace?.role ? permissionsForWorkspaceRole(currentWorkspace.role) : [],
    );

    return {
      me: data ?? null,
      loading: isLoading,
      organisations,
      workspaces,
      currentOrg,
      currentWorkspace,
      can: (permission) => permissions.has(permission),
      refresh,
    };
  }, [data, isLoading, orgSlug, siteSlug, refresh]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider.');
  return value;
}

/** Sites this user opened most recently, pinned to the top of the switcher (§6.3). */
const RECENTS_KEY = 'cms.recent-sites';
const RECENTS_LIMIT = 5;

export function readRecentSites(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function noteRecentSite(workspaceId: string): void {
  try {
    const next = [workspaceId, ...readRecentSites().filter((id) => id !== workspaceId)].slice(
      0,
      RECENTS_LIMIT,
    );
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // A browser with storage disabled loses recents, not functionality.
  }
}
