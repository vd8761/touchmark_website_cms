import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Button, Card, Field, Input } from '../components/primitives';

export function Login() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.post('/admin/v1/auth/login', {
        email,
        password,
        ...(mfaCode ? { mfa_code: mfaCode } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'mfa_required') {
        setMfaRequired(true);
      } else if (caught instanceof ApiError) {
        setError(caught);
      } else {
        throw caught;
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <h1 className="text-lg font-semibold text-text">Sign in</h1>
        <p className="mt-1 text-sm text-text-secondary">Manage your content, audience and email.</p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </Field>

          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>

          {mfaRequired && (
            <Field label="Authentication code" hint="From your authenticator app.">
              <Input
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </Field>
          )}

          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
              <p className="text-sm text-text">{error.message}</p>
              {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
            </div>
          )}

          <Button type="submit" variant="primary" loading={busy} className="w-full">
            Sign in
          </Button>
        </form>

        <div className="mt-4 text-sm">
          <Link to="/forgot-password" className="text-text-secondary hover:text-text">
            Forgot password?
          </Link>
        </div>
      </Card>
    </div>
  );
}
