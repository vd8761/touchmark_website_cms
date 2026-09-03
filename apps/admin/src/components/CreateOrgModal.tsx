import { useState } from 'react';
import type { OrganisationDto } from '@cms/shared';

import { ApiError, api } from '../lib/api';
import { Button, Field, Input } from './primitives';
import { useSession } from '../lib/session';

const MAX_LOGO_BYTES = 512 * 1024;

export function CreateOrgModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (org: OrganisationDto) => void;
}) {
  const { refresh } = useSession();
  const [name, setName] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;

    setBusy(true);
    setError(null);
    try {
      const created = await api.post<OrganisationDto>('/admin/v1/orgs', {
        name: name.trim(),
        ...(logo ? { logo_url: logo } : {}),
      });
      await refresh();
      onCreated?.(created);
      onClose();
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
      aria-labelledby="create-org-title"
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <h2 id="create-org-title" className="text-lg font-semibold text-text">
            Create new organisation
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-secondary hover:bg-surface-subtle hover:text-text"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <p className="text-sm text-text-secondary">
            An organisation holds your team and billing. Sites live inside it — most teams use their
            company or client name.
          </p>

          <Field label="Organisation name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Acme Corp"
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
                className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-surface-subtle"
                aria-hidden={!logo}
              >
                {logo ? (
                  <img src={logo} alt="Logo preview" className="h-full w-full object-contain" />
                ) : (
                  <span className="text-xs text-text-secondary">No logo</span>
                )}
              </span>

              <label className="inline-flex cursor-pointer items-center rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-subtle">
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
                  className="text-xs text-text-secondary hover:text-text"
                >
                  Remove
                </button>
              )}
            </div>
          </Field>

          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
              <p>{error.message}</p>
              {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
              Create organisation
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
