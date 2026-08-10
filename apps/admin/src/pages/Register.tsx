import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Button, Card, Field, Input } from '../components/primitives';

export function Register() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({ full_name: '', email: '', password: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldError = (field: string) => error?.fields?.find((f) => f.field === field)?.message;

  // Registration is open only until the platform has its first owner or admin;
  // after that the API answers 401/403 and accounts are created by an
  // administrator. That is a settled state, not a failed attempt, so it
  // replaces the form rather than appearing as an error above it.
  const registrationClosed =
    error?.code === 'session_expired' || error?.code === 'insufficient_permission';

  if (registrationClosed) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <Card className="w-full max-w-sm">
          <h1 className="text-lg font-semibold text-text">Registration is closed</h1>
          <p className="mt-2 text-sm text-text-secondary">
            {error?.detail ??
              'This platform already has an administrator, so accounts are created by ' +
                'administrators. Ask one to invite you.'}
          </p>
          <Link
            to="/login"
            className="mt-6 inline-block text-sm text-accent hover:underline"
          >
            Go to sign in
          </Link>
        </Card>
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.post('/admin/v1/auth/register', form);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      // A new account has no organisation yet, so onboarding starts there (§6.2).
      navigate('/onboarding');
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught);
      else throw caught;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <h1 className="text-lg font-semibold text-text">Create your account</h1>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Full name">
            <Input
              value={form.full_name}
              onChange={(event) => setForm({ ...form, full_name: event.target.value })}
              autoComplete="name"
            />
          </Field>

          <Field label="Email" error={fieldError('email')}>
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              autoComplete="username"
              required
            />
          </Field>

          <Field
            label="Password"
            hint="At least 12 characters. A few unrelated words works better than symbols."
            error={fieldError('password')}
          >
            <Input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              autoComplete="new-password"
              required
            />
          </Field>

          {error && !error.fields?.length && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
              <p className="text-sm text-text">{error.message}</p>
              {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
            </div>
          )}

          <Button type="submit" variant="primary" loading={busy} className="w-full">
            Create account
          </Button>
        </form>

        <p className="mt-4 text-sm text-text-secondary">
          Already have an account?{' '}
          <Link to="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    </div>
  );
}
