import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { ApiError, api } from '../lib/api';
import { Button, Card, Field, Input } from '../components/primitives';

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setValidationError(null);

    if (!token) {
      setValidationError('Missing reset token. Please request a new password reset link.');
      return;
    }

    if (password.length < 12) {
      setValidationError('Password must be at least 12 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setValidationError('Passwords do not match.');
      return;
    }

    setBusy(true);

    try {
      await api.post('/admin/v1/auth/reset-password', {
        token,
        password,
      });
      setSuccess(true);
      setTimeout(() => navigate('/login'), 2500);
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
    <div className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <h1 className="text-lg font-semibold text-text">Choose a new password</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Passwords must be at least 12 characters.
        </p>

        {success ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 text-sm text-text">
              <p className="font-medium text-accent">Password updated!</p>
              <p className="mt-1 text-text-secondary">
                Your password has been changed. Redirecting to sign in…
              </p>
            </div>
            <Link
              to="/login"
              className="block text-center text-sm font-medium text-accent hover:underline"
            >
              Click here if you are not redirected
            </Link>
          </div>
        ) : !token ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
              <p className="font-medium">Invalid or missing reset link</p>
              <p className="mt-1 text-xs text-text-secondary">
                No reset token was found in the link. Please request a new password reset link.
              </p>
            </div>
            <Link
              to="/forgot-password"
              className="block text-center text-sm font-medium text-accent hover:underline"
            >
              Request a new reset link
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <Field label="New password" hint="At least 12 characters.">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
                autoFocus
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
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
                <p className="text-sm text-text">{error.message}</p>
                {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
              </div>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              Reset password
            </Button>

            <div className="text-center">
              <Link to="/login" className="text-sm text-text-secondary hover:text-text">
                ← Back to sign in
              </Link>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
