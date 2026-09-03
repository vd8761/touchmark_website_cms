import { useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, api } from '../lib/api';
import { Button, Card, Field, Input } from '../components/primitives';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;

    setBusy(true);
    setError(null);

    try {
      await api.post('/admin/v1/auth/forgot-password', {
        email: email.trim(),
      });
      setSent(true);
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
        <h1 className="text-lg font-semibold text-text">Reset your password</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Enter your email address and we will send you a link to reset your password.
        </p>

        {sent ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 text-sm text-text">
              <p className="font-medium text-accent">Check your inbox</p>
              <p className="mt-1 text-text-secondary">
                If an account exists for <strong className="text-text">{email}</strong>, we have
                sent a reset link. The link expires in 30 minutes and can be used once.
              </p>
            </div>
            <Link
              to="/login"
              className="block text-center text-sm font-medium text-accent hover:underline"
            >
              ← Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
                autoFocus
                placeholder="name@example.com"
              />
            </Field>

            {error && (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
                <p className="text-sm text-text">{error.message}</p>
                {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
              </div>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              Send reset link
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
