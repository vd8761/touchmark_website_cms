import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Button, Card, Field, Input } from './primitives';

/**
 * The ownership-transfer form, shared by organisation and site settings.
 *
 * Two decisions worth stating:
 *
 *  * The person is named by email address, because that is the identifier
 *    people actually know each other by. The API resolves it against the
 *    organisation's members and refuses anyone outside it.
 *  * The name has to be typed to confirm, the same as deletion. Transferring is
 *    not reversible from this side — once it lands, only the new owner can hand
 *    it back — so it gets the same friction §17.17 demands of destructive
 *    actions.
 */
export function TransferOwnership({
  scope,
  name,
  endpoint,
  ownerLabel,
  consequence,
  disabled,
  onTransferred,
}: {
  scope: 'organisation' | 'site';
  /** The organisation or site name, typed by the user to confirm. */
  name: string;
  endpoint: string;
  /** Who owns it today, shown so the user can see what they are changing. */
  ownerLabel: string | null;
  /** What happens to the current owner, in one sentence. */
  consequence: string;
  disabled?: boolean;
  onTransferred: () => void | Promise<unknown>;
}) {
  const [email, setEmail] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const transfer = useMutation({
    mutationFn: () =>
      api.post<{ owner_email: string }>(endpoint, {
        email: email.trim(),
        confirm_name: confirmName,
      }),
    onSuccess: async (result) => {
      setError(null);
      setDone(result?.owner_email ?? email.trim());
      setEmail('');
      setConfirmName('');
      await onTransferred();
    },
    onError: (caught) => {
      setDone(null);
      setError(caught as ApiError);
    },
  });

  const ready = email.trim().length > 0 && confirmName.trim() === name;

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-text">Ownership</h2>
        <p className="mt-1 text-xs text-text-secondary">
          {ownerLabel
            ? `This ${scope} is owned by ${ownerLabel}.`
            : `This ${scope} has no recorded owner yet.`}{' '}
          {consequence}
        </p>
      </div>

      <Field
        label="Transfer to"
        hint={`The email address of an existing organisation member. Invite them first if they are not in the organisation yet.`}
      >
        <Input
          type="email"
          value={email}
          disabled={disabled}
          placeholder="new.owner@example.com"
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>

      <Field label="Confirm" hint={`Type “${name}” to confirm.`}>
        <Input
          value={confirmName}
          disabled={disabled}
          placeholder={name}
          onChange={(event) => setConfirmName(event.target.value)}
        />
      </Field>

      <div className="flex items-center gap-3">
        <Button
          variant="danger"
          loading={transfer.isPending}
          disabled={disabled || !ready}
          onClick={() => transfer.mutate()}
        >
          Transfer ownership
        </Button>
        {!disabled && !ready && (
          <span className="text-xs text-text-secondary">
            Enter an email and type the name exactly to enable this.
          </span>
        )}
      </div>

      {done && (
        <p className="text-sm text-success">
          Ownership transferred to {done}. Both of you have been emailed.
        </p>
      )}

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm text-text">{error.message}</p>
          {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
        </div>
      )}
    </Card>
  );
}
