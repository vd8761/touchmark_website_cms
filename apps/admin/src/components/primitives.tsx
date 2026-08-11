import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

/**
 * Design-system primitives (Phase 0 deliverable, §19).
 *
 * Deliberately small: a Phase 0 primitive set that is honest about being a
 * starting point is more useful than a speculative component library. Each of
 * these encodes a decision from §17 that would otherwise be re-litigated in
 * every screen.
 */

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary: 'bg-surface border border-border text-text hover:bg-surface-subtle',
  ghost: 'text-text-secondary hover:bg-surface-subtle hover:text-text',
  danger: 'bg-danger text-white hover:opacity-90',
};

export function Button({
  variant = 'secondary',
  className,
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-text">{label}</span>
      {/* Help text sits below the label and above the input (§17.5), so it is
          read before the field rather than discovered after filling it in. */}
      {hint && <span className="block text-xs text-text-secondary">{hint}</span>}
      {children}
      {error && (
        <span className="block text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text',
        'placeholder:text-text-secondary focus:border-accent',
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------

/**
 * An identifier the user is expected to copy rather than read — a workspace id,
 * an organisation id, a request id.
 *
 * These are UUIDs. Nobody transcribes one correctly, so the whole value is
 * shown in a monospaced box that selects cleanly and sits next to a copy
 * button; burying one mid-sentence makes it look like prose and hides the fact
 * that it is the thing every API path is built from.
 */
export function CopyableId({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-text">{label}</p>
      {hint && <p className="text-xs text-text-secondary">{hint}</p>}
      <div className="flex items-stretch gap-2">
        <code className="flex-1 select-all overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-surface-subtle px-3 py-2 text-xs text-text">
          {value}
        </code>
        <Button variant="secondary" onClick={copy} className="shrink-0">
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-xl border border-border bg-surface p-5', className)}>{children}</div>
  );
}

const TONE_CLASSES = {
  neutral: 'bg-surface-subtle text-text-secondary border-border',
  success: 'bg-success/10 text-success border-success/20',
  warning: 'bg-warning/10 text-warning border-warning/20',
  danger: 'bg-danger/10 text-danger border-danger/20',
  accent: 'bg-accent/10 text-accent border-accent/20',
} as const;

export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof TONE_CLASSES;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The six cross-cutting states of §17.18. Having them as primitives is what
// makes "every list and detail screen implements all six" achievable rather
// than aspirational.

export function Skeleton({ rows = 5 }: { rows?: number }) {
  // Skeletons match the final layout — §17.18 explicitly rules out a centred
  // full-page spinner.
  return (
    <div className="space-y-2" aria-busy aria-label="Loading">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="h-12 animate-pulse rounded-lg bg-surface-subtle" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  docsHref,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  docsHref?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface px-6 py-14 text-center">
      <h3 className="text-base font-semibold text-text">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-text-secondary">{description}</p>
      {(action || docsHref) && (
        <div className="mt-5 flex items-center justify-center gap-3">
          {action}
          {docsHref && (
            <a
              href={docsHref}
              className="text-sm font-medium text-accent underline-offset-4 hover:underline"
            >
              Read the guide
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function ErrorState({
  message,
  detail,
  code,
  requestId,
  onRetry,
}: {
  message: string;
  detail?: string;
  code?: string;
  requestId?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-danger/30 bg-danger/5 p-5">
      <p className="text-sm font-semibold text-text">{message}</p>
      {detail && <p className="mt-1 text-sm text-text-secondary">{detail}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        )}
        {/* §17.18 requires the request id with a copy button — it is the only
            thing that makes a support ticket actionable. */}
        {requestId && (
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(requestId)}
            className="font-mono text-xs text-text-secondary hover:text-text"
            title="Copy request id"
          >
            {code ? `${code} · ` : ''}
            {requestId} ⧉
          </button>
        )}
      </div>
    </div>
  );
}

export function PermissionDenied({ requiredRole }: { requiredRole: string }) {
  return (
    <EmptyState
      title="You don’t have access to this"
      description={`This screen needs the ${requiredRole} role in this site. A Site Admin can grant it.`}
      action={<Button variant="secondary">Request access</Button>}
    />
  );
}
