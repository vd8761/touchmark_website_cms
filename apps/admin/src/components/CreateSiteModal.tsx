import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceDto } from '@cms/shared';

import { ApiError, api } from '../lib/api';
import { Button, Field, Input } from './primitives';
import { noteRecentSite, useSession } from '../lib/session';

const STARTER_MODELS = [
  { id: 'marketing', name: 'Marketing site', description: 'Page, Blog Post, Author, Category' },
  { id: 'blog', name: 'Blog or publication', description: 'Post, Author, Category, Tag' },
  { id: 'saas', name: 'Product / SaaS', description: 'Page, Feature, Changelog, Customer Story' },
  { id: 'docs', name: 'Documentation', description: 'Doc Page, Doc Category' },
  { id: 'blank', name: 'Blank', description: 'No types — build your own' },
] as const;

const COLOUR_OPTIONS = [
  '#4F46E5', // Indigo
  '#2563EB', // Blue
  '#059669', // Emerald
  '#D97706', // Amber
  '#DC2626', // Red
  '#7C3AED', // Purple
  '#DB2777', // Pink
  '#0D9488', // Teal
];

export function CreateSiteModal({
  initialOrgId,
  onClose,
  onRequestCreateOrg,
}: {
  initialOrgId?: string | null;
  onClose: () => void;
  onRequestCreateOrg?: () => void;
}) {
  const { organisations, currentOrg, refresh } = useSession();
  const navigate = useNavigate();

  const [step, setStep] = useState<'select_org' | 'site_details'>(() => {
    // If an initialOrgId or currentOrg is provided and exists, we can start on details,
    // but allow the user to easily switch or select org.
    // However, the prompt specifically noted:
    // "to create a new site, i should first select the organisation in a pop-up and then adding new site steps."
    // So if there are multiple organisations, starting at 'select_org' or showing organisation selection first is great!
    return 'select_org';
  });

  const [selectedOrgId, setSelectedOrgId] = useState<string>(
    initialOrgId ?? currentOrg?.id ?? organisations[0]?.id ?? '',
  );

  const [siteName, setSiteName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [colour, setColour] = useState(COLOUR_OPTIONS[0]);
  const [starterModel, setStarterModel] = useState<string>('marketing');
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedOrg = organisations.find((o) => o.id === selectedOrgId) ?? organisations[0];

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedOrg || !siteName.trim()) return;

    setBusy(true);
    setError(null);
    try {
      const site = await api.post<WorkspaceDto>(`/admin/v1/orgs/${selectedOrg.id}/workspaces`, {
        name: siteName.trim(),
        starter_model: starterModel,
        colour,
        ...(siteUrl.trim() ? { primary_url: siteUrl.trim() } : {}),
      });

      await refresh();
      noteRecentSite(site.id);
      onClose();
      navigate(`/o/${selectedOrg.slug}/s/${site.slug}`);
    } catch (caught) {
      if (caught instanceof ApiError) setError({ message: caught.message, detail: caught.detail });
      else setError({ message: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-site-title"
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-surface p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 id="create-site-title" className="text-lg font-semibold text-text">
              Create a new site
            </h2>
            <p className="text-xs text-text-secondary">
              {step === 'select_org' ? 'Step 1 of 2: Select organisation' : 'Step 2 of 2: Site details'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-secondary hover:bg-surface-subtle hover:text-text"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {step === 'select_org' ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-text-secondary">
              Select the organisation this site should belong to:
            </p>

            {organisations.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <p className="text-sm text-text-secondary">No organisations found.</p>
                {onRequestCreateOrg && (
                  <Button
                    variant="primary"
                    className="mt-3"
                    onClick={() => {
                      onClose();
                      onRequestCreateOrg();
                    }}
                  >
                    ＋ Create an organisation
                  </Button>
                )}
              </div>
            ) : (
              <div className="max-h-60 space-y-2 overflow-y-auto">
                {organisations.map((org) => {
                  const isSelected = org.id === selectedOrgId;
                  return (
                    <button
                      key={org.id}
                      type="button"
                      onClick={() => setSelectedOrgId(org.id)}
                      className={`flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                        isSelected
                          ? 'border-accent bg-accent/5 text-text'
                          : 'border-border text-text hover:bg-surface-subtle'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {org.logo_url ? (
                          <img
                            src={org.logo_url}
                            alt=""
                            className="h-7 w-7 rounded object-contain"
                          />
                        ) : (
                          <div className="grid h-7 w-7 place-items-center rounded bg-surface-subtle text-xs font-semibold uppercase text-text-secondary">
                            {org.name.slice(0, 2)}
                          </div>
                        )}
                        <div>
                          <p className="text-sm font-medium">{org.name}</p>
                          <p className="text-xs text-text-secondary">Slug: {org.slug}</p>
                        </div>
                      </div>
                      <div
                        className={`h-4 w-4 rounded-full border flex items-center justify-center ${
                          isSelected ? 'border-accent bg-accent' : 'border-border'
                        }`}
                      >
                        {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {onRequestCreateOrg && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onRequestCreateOrg();
                  }}
                  className="text-xs text-accent hover:underline"
                >
                  ＋ Create another organisation
                </button>
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={!selectedOrgId}
                onClick={() => setStep('site_details')}
              >
                Next: Site details →
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div className="flex items-center justify-between rounded-lg bg-surface-subtle p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-secondary">Organisation:</span>
                <span className="text-xs font-semibold text-text">{selectedOrg?.name}</span>
              </div>
              <button
                type="button"
                onClick={() => setStep('select_org')}
                className="text-xs text-accent hover:underline"
              >
                Change
              </button>
            </div>

            <Field label="Site name">
              <Input
                value={siteName}
                onChange={(event) => setSiteName(event.target.value)}
                placeholder="e.g. Touchmark Marketing"
                required
                autoFocus
              />
            </Field>

            <Field
              label="Live site URL"
              hint="Optional: The domain where this site is hosted."
            >
              <Input
                type="url"
                value={siteUrl}
                onChange={(event) => setSiteUrl(event.target.value)}
                placeholder="https://example.com"
              />
            </Field>

            <Field label="Badge colour" hint="Used in the workspace switcher and header">
              <div className="flex flex-wrap items-center gap-2">
                {COLOUR_OPTIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColour(c)}
                    className={`h-7 w-7 rounded-lg border transition-transform ${
                      colour === c ? 'scale-110 border-text ring-2 ring-accent' : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: c }}
                    aria-label={`Select colour ${c}`}
                  />
                ))}
              </div>
            </Field>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text">Starter content model</legend>
              <p className="text-xs text-text-secondary">
                Pre-configures standard content types for your new site.
              </p>
              {STARTER_MODELS.map((option) => (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors ${
                    starterModel === option.id ? 'border-accent bg-accent/5' : 'border-border hover:bg-surface-subtle'
                  }`}
                >
                  <input
                    type="radio"
                    name="starter_model"
                    value={option.id}
                    checked={starterModel === option.id}
                    onChange={() => setStarterModel(option.id)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium text-text">{option.name}</span>
                    <span className="block text-xs text-text-secondary">{option.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {error && (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
                <p>{error.message}</p>
                {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
              </div>
            )}

            <div className="flex justify-between gap-2 border-t border-border pt-4">
              <Button type="button" variant="ghost" onClick={() => setStep('select_org')} disabled={busy}>
                ← Back
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy}
                  disabled={!siteName.trim()}
                >
                  Create site
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
