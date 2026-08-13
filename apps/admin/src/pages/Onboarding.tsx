import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OrganisationDto, WorkspaceDto } from '@cms/shared';

import { ApiError, api } from '../lib/api';
import { Button, Card, Field, Input } from '../components/primitives';
import { useSession } from '../lib/session';

/**
 * §6.2: signup → verify email → create organisation → create first site →
 * choose a starter content model → invite teammates → dashboard.
 *
 * The starter models are offered here and recorded on the site; provisioning
 * their content types happens when the content module lands (Phase 1).
 */
const STARTER_MODELS = [
  { id: 'marketing', name: 'Marketing site', description: 'Page, Blog Post, Author, Category' },
  { id: 'blog', name: 'Blog or publication', description: 'Post, Author, Category, Tag' },
  { id: 'saas', name: 'Product / SaaS', description: 'Page, Feature, Changelog, Customer Story' },
  { id: 'docs', name: 'Documentation', description: 'Doc Page, Doc Category' },
  { id: 'blank', name: 'Blank', description: 'No types — build your own' },
] as const;

export function Onboarding() {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const [step, setStep] = useState<'org' | 'site'>('org');
  const [org, setOrg] = useState<OrganisationDto | null>(null);
  const [orgName, setOrgName] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [siteName, setSiteName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [model, setModel] = useState<string>('marketing');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  // The logo is read into a data: URL and sent inline with the organisation, so
  // branding is available the moment the org exists — before any site (and its
  // media library) has been created. We keep it small: it is embedded in every
  // page load, not served from a CDN.
  const MAX_LOGO_BYTES = 512 * 1024;

  function onLogoChange(event: React.ChangeEvent<HTMLInputElement>) {
    setLogoError(null);
    const file = event.target.files?.[0];
    if (!file) {
      setLogo(null);
      return;
    }
    if (!file.type.startsWith('image/')) {
      setLogoError('Choose an image file (PNG, JPG or SVG).');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError('That image is over 512 KB. Please use a smaller logo.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => setLogoError('Could not read that file. Try another image.');
    reader.readAsDataURL(file);
  }

  async function createOrg(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<OrganisationDto>('/admin/v1/orgs', {
        name: orgName,
        ...(logo ? { logo_url: logo } : {}),
      });
      setOrg(created);
      setStep('site');
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught);
      else throw caught;
    } finally {
      setBusy(false);
    }
  }

  async function createSite(event: React.FormEvent) {
    event.preventDefault();
    if (!org) return;

    setBusy(true);
    setError(null);
    try {
      const site = await api.post<WorkspaceDto>(`/admin/v1/orgs/${org.id}/workspaces`, {
        name: siteName,
        starter_model: model,
        ...(siteUrl ? { primary_url: siteUrl } : {}),
      });
      await refresh();
      navigate(`/o/${org.slug}/s/${site.slug}`);
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught);
      else throw caught;
    } finally {
      setBusy(false);
    }
  }

  // Creating an organisation makes you its Owner, so after the platform has an
  // administrator the API reserves it for administrators and everyone else
  // joins by invitation. For those people onboarding has nothing to offer, so
  // it says so rather than presenting a form that cannot succeed.
  if (error?.code === 'insufficient_permission') {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <Card className="w-full max-w-sm">
          <h1 className="text-lg font-semibold text-text">You are not in a site yet</h1>
          <p className="mt-2 text-sm text-text-secondary">
            {error.detail ??
              'Ask an administrator to invite you to an organisation. The invitation ' +
                'link will bring you straight in.'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-lg">
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Step {step === 'org' ? '1' : '2'} of 2
        </p>

        {step === 'org' ? (
          <form onSubmit={createOrg} className="mt-2 space-y-4">
            <h1 className="text-lg font-semibold text-text">Name your organisation</h1>
            <p className="text-sm text-text-secondary">
              An organisation holds your team and billing. Sites live inside it — most people
              use their company name.
            </p>

            <Field label="Organisation name">
              <Input
                value={orgName}
                onChange={(event) => setOrgName(event.target.value)}
                placeholder="Acme Inc"
                required
                autoFocus
              />
            </Field>

            <Field
              label="Logo"
              hint="Used for CMS branding across your sites. PNG, JPG or SVG, up to 512 KB. Optional."
              error={logoError ?? undefined}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-surface-subtle"
                  aria-hidden={!logo}
                >
                  {logo ? (
                    <img src={logo} alt="Logo preview" className="h-full w-full object-contain" />
                  ) : (
                    <span className="text-xs text-text-secondary">No logo</span>
                  )}
                </span>

                <label className="inline-flex cursor-pointer items-center rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text hover:bg-surface-subtle">
                  {logo ? 'Change logo' : 'Upload logo'}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={onLogoChange}
                  />
                </label>

                {logo && (
                  <button
                    type="button"
                    onClick={() => {
                      setLogo(null);
                      setLogoError(null);
                    }}
                    className="text-sm text-text-secondary hover:text-text"
                  >
                    Remove
                  </button>
                )}
              </div>
            </Field>

            {error && <p className="text-sm text-danger">{error.message}</p>}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              Continue
            </Button>
          </form>
        ) : (
          <form onSubmit={createSite} className="mt-2 space-y-4">
            <h1 className="text-lg font-semibold text-text">Create your first site</h1>
            <p className="text-sm text-text-secondary">
              A site is one website’s content, audience and email. Everything in it is isolated
              from your other sites.
            </p>

            <Field label="Site name">
              <Input
                value={siteName}
                onChange={(event) => setSiteName(event.target.value)}
                placeholder="Marketing Site"
                required
                autoFocus
              />
            </Field>

            <Field
              label="Live site URL"
              hint="Optional, and informational only — we never fetch or verify it."
            >
              <Input
                type="url"
                value={siteUrl}
                onChange={(event) => setSiteUrl(event.target.value)}
                placeholder="https://acme.com"
              />
            </Field>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text">Start from a content model</legend>
              {STARTER_MODELS.map((option) => (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                    model === option.id ? 'border-accent bg-accent/5' : 'border-border'
                  }`}
                >
                  <input
                    type="radio"
                    name="starter_model"
                    value={option.id}
                    checked={model === option.id}
                    onChange={() => setModel(option.id)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium text-text">{option.name}</span>
                    <span className="block text-xs text-text-secondary">{option.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {error && <p className="text-sm text-danger">{error.message}</p>}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              Create site
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
