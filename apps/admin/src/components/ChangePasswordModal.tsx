import { useState } from 'react';

import { ApiError, api } from '../lib/api';
import { Button, Field, Input } from './primitives';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setValidationError(null);

    if (newPassword.length < 12) {
      setValidationError('New password must be at least 12 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setValidationError('New passwords do not match.');
      return;
    }

    setBusy(true);

    try {
      await api.post('/admin/v1/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      setSuccess(true);
      setTimeout(() => {
        onClose();
      }, 2000);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught);
      } else {
        setError(new ApiError('unknown', (caught as Error).message, undefined, '', 500));
      }
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
      aria-labelledby="change-password-title"
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <h2 id="change-password-title" className="text-lg font-semibold text-text">
            Change password
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

        {success ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 text-sm text-text">
              <p className="font-medium text-accent">Password changed successfully!</p>
              <p className="mt-1 text-text-secondary">
                Your password has been updated. This dialog will close shortly.
              </p>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <p className="text-sm text-text-secondary">
              Update your account password. Choose a strong password with at least 12 characters.
            </p>

            <Field label="Current password">
              <Input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
                autoFocus
              />
            </Field>

            <Field label="New password" hint="Minimum 12 characters.">
              <Input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                required
                minLength={12}
              />
            </Field>

            <Field label="Confirm new password">
              <Input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                required
                minLength={12}
              />
            </Field>

            {validationError && (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
                <p>{validationError}</p>
              </div>
            )}

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
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={!currentPassword || !newPassword || !confirmPassword}
              >
                Update password
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
