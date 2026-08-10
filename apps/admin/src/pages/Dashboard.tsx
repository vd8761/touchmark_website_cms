import { Card, EmptyState, Pill } from '../components/primitives';
import { useSession } from '../lib/session';

/**
 * The Phase 0 dashboard.
 *
 * §17.3 specifies a rich dashboard — KPI cards with sparklines, an activity
 * chart, "needs your attention", top content. Every one of those reads from
 * data that does not exist until the content, audience, email and analytics
 * modules land. Rendering them as empty shells now would be a worse experience
 * than saying plainly what is here and what is next, so this shows the site's
 * real state and an honest roadmap.
 */
export function Dashboard() {
  const { currentWorkspace, currentOrg } = useSession();

  if (!currentWorkspace) {
    return (
      <EmptyState
        title="No site selected"
        description="Create a site to start modelling content and collecting subscribers."
      />
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm text-text-secondary">{currentOrg?.name}</p>
        <h1 className="text-2xl font-semibold text-text">{currentWorkspace.name}</h1>
      </header>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-secondary">Your role</p>
          <p className="mt-2 text-lg font-semibold capitalize text-text">
            {currentWorkspace.role?.replace('_', ' ') ?? '—'}
          </p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-secondary">Status</p>
          <p className="mt-2">
            <Pill tone={currentWorkspace.status === 'active' ? 'success' : 'warning'}>
              {currentWorkspace.status}
            </Pill>
          </p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-secondary">Timezone</p>
          <p className="mt-2 text-lg font-semibold text-text">{currentWorkspace.timezone}</p>
          <p className="text-xs text-text-secondary">Drives scheduling and reports</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-secondary">Locales</p>
          <p className="mt-2 text-lg font-semibold text-text">
            {currentWorkspace.locales.join(', ')}
          </p>
          <p className="text-xs text-text-secondary">
            Default: {currentWorkspace.default_locale}
          </p>
        </Card>
      </div>

      <Card>
        <h2 className="text-sm font-semibold text-text">What’s next</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Phase 0 is complete: accounts, organisations, sites, roles and the isolation
          guarantees they rest on. The dashboard specified in §17.3 fills in as the modules
          that produce its numbers arrive.
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          {[
            ['Phase 1', 'Content types, entries, versioning, media, taxonomies, menus'],
            ['Phase 2', 'Delivery API, API keys, rate limiting, OpenAPI docs — first shippable milestone'],
            ['Phase 3', 'Subscribers, lists, segments, forms, double opt-in'],
            ['Phase 4', 'Sender identities, campaigns, the send pipeline'],
            ['Phase 5', 'Automations, analytics rollups, this dashboard in full'],
          ].map(([phase, description]) => (
            <li key={phase} className="flex gap-3">
              <span className="w-16 shrink-0 text-xs font-medium text-text-secondary">{phase}</span>
              <span className="text-text-secondary">{description}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
