import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { CreateSiteModal } from './components/CreateSiteModal';
import { SessionProvider, useSession } from './lib/session';
import { ApiKeys } from './pages/ApiKeys';
import { ApiLogs } from './pages/ApiLogs';
import { AuditLog } from './pages/AuditLog';
import { ContentList } from './pages/ContentList';
import { ContentTypes } from './pages/ContentTypes';
import { Dashboard } from './pages/Dashboard';
import { DeveloperGuide } from './pages/DeveloperGuide';
import { EmailConfigurations } from './pages/EmailConfigurations';
import { EntryEditor } from './pages/EntryEditor';
import { MediaLibrary } from './pages/MediaLibrary';
import { Menus } from './pages/Menus';
import { Login } from './pages/Login';
import { Members } from './pages/Members';
import { Onboarding } from './pages/Onboarding';
import { OrganisationSettings } from './pages/OrganisationSettings';
import { Register } from './pages/Register';
import { SiteEmail } from './pages/SiteEmail';
import { Taxonomies } from './pages/Taxonomies';
import { Webhooks } from './pages/Webhooks';
import { SiteSettings } from './pages/SiteSettings';

/**
 * Routing follows §6.3: "The selected workspace is stored in the session and
 * reflected in the URL: /o/:orgSlug/s/:siteSlug/... URL is the source of truth
 * so links are shareable."
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      <Route
        path="/onboarding"
        element={
          <SessionProvider>
            <Onboarding />
          </SessionProvider>
        }
      />

      <Route
        path="/o/:orgSlug/sites/new"
        element={
          <SessionProvider>
            <NewSiteRoute />
          </SessionProvider>
        }
      />
      <Route
        path="/sites/new"
        element={
          <SessionProvider>
            <NewSiteRoute />
          </SessionProvider>
        }
      />

      <Route path="/o/:orgSlug/s/:siteSlug/*" element={<SiteRoutes />} />

      {/* No site in the URL: send the user to their first one, or to onboarding. */}
      <Route
        path="*"
        element={
          <SessionProvider>
            <LandingRedirect />
          </SessionProvider>
        }
      />
    </Routes>
  );
}

function NewSiteRoute() {
  const { orgSlug } = useParams();
  const navigate = useNavigate();
  const { organisations } = useSession();
  const org = organisations.find((o) => o.slug === orgSlug);

  return (
    <CreateSiteModal
      initialOrgId={org?.id}
      onClose={() => navigate(-1)}
    />
  );
}

function SiteRoutes() {
  const { orgSlug, siteSlug } = useParams();

  return (
    <SessionProvider orgSlug={orgSlug} siteSlug={siteSlug}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="content/:typeApiId" element={<ContentList />} />
          <Route path="content/:typeApiId/:entryId" element={<EntryEditor />} />
          <Route path="media" element={<MediaLibrary />} />
          <Route path="taxonomies" element={<Taxonomies />} />
          <Route path="menus" element={<Menus />} />
          <Route path="api-keys" element={<ApiKeys />} />
          <Route path="webhooks" element={<Webhooks />} />
          <Route path="logs" element={<ApiLogs />} />
          <Route path="guides" element={<DeveloperGuide />} />
          <Route path="settings/content-types" element={<ContentTypes />} />
          <Route path="settings" element={<SiteSettings />} />
          <Route path="settings/members" element={<Members />} />
          <Route path="settings/email" element={<SiteEmail />} />
          <Route path="settings/audit-log" element={<AuditLog />} />
          {/* Organisation-level, but reached from inside a site so the shell
              (and its site switcher) stays in place. */}
          <Route path="settings/org" element={<OrganisationSettings />} />
          <Route path="settings/org/email" element={<EmailConfigurations />} />
          <Route path="*" element={<NotYetBuilt />} />
        </Route>
      </Routes>
    </SessionProvider>
  );
}

function LandingRedirect() {
  const { loading, me, organisations, workspaces } = useSession();

  if (loading) {
    return <div className="grid h-full place-items-center text-sm text-text-secondary">Loading…</div>;
  }

  if (!me) return <Navigate to="/login" replace />;
  if (organisations.length === 0 || workspaces.length === 0) {
    return <Navigate to="/onboarding" replace />;
  }

  const site = workspaces[0];
  const org = organisations.find((o) => o.id === site.organisation_id) ?? organisations[0];
  return <Navigate to={`/o/${org.slug}/s/${site.slug}`} replace />;
}

function NotYetBuilt() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface px-6 py-14 text-center">
      <h2 className="text-base font-semibold text-text">Not built yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-text-secondary">
        This screen arrives with a later phase. Phase 0 covers accounts, organisations, sites,
        roles and members.
      </p>
    </div>
  );
}
