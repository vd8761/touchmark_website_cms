import { useEffect, useRef, useState } from 'react';

/**
 * Saves after a pause in typing (§7.3: "autosave every 3s of inactivity").
 *
 * Debounced on the *content*, not on a keystroke event, so it works the same
 * whether the change came from a text input, a media picker or the block
 * editor — none of which share an event shape.
 *
 * Two behaviours matter more than the timer:
 *
 * **It stops after a failure.** A save that 409s or 422s would otherwise retry
 * on every subsequent keystroke, turning one problem into a request per
 * character and burying the error the author needs to read. It pauses until
 * `resume()` is called — which the manual Save button does, because that is the
 * author acknowledging the problem.
 *
 * **It never overlaps.** A save in flight blocks the next one, and the timer
 * restarts afterwards if the content moved on meanwhile. Two concurrent PATCHes
 * to the same entry is how you get a 409 against yourself.
 */
export type AutosaveState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'saving' }
  | { status: 'saved'; at: Date }
  | { status: 'paused' };

export function useAutosave({
  enabled,
  content,
  delayMs = 3000,
  onSave,
}: {
  /** False when there is nothing to save, or autosave is not allowed here. */
  enabled: boolean;
  /** Serialised content. A change to this string is what schedules a save. */
  content: string;
  delayMs?: number;
  onSave: () => Promise<unknown>;
}): { state: AutosaveState; resume: () => void; cancel: () => void } {
  const [state, setState] = useState<AutosaveState>({ status: 'idle' });

  const pausedRef = useRef(false);
  const savingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  // Held in a ref so changing the callback identity — which happens on every
  // render, since it closes over the draft — does not restart the timer and
  // push the save indefinitely into the future.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!enabled || pausedRef.current) return;

    setState((current) => (current.status === 'saving' ? current : { status: 'pending' }));

    const timer = window.setTimeout(async () => {
      if (savingRef.current || pausedRef.current) return;

      savingRef.current = true;
      setState({ status: 'saving' });

      try {
        await onSaveRef.current();
        setState({ status: 'saved', at: new Date() });
      } catch {
        // The error itself is surfaced by the caller's own error handling; all
        // this needs to do is stop trying.
        pausedRef.current = true;
        setState({ status: 'paused' });
      } finally {
        savingRef.current = false;
      }
    }, delayMs);

    timerRef.current = timer;
    return () => window.clearTimeout(timer);
  }, [content, enabled, delayMs]);

  // A save that finished, with nothing typed since, is simply "saved".
  useEffect(() => {
    if (!enabled) {
      setState((current) => (current.status === 'pending' ? { status: 'idle' } : current));
    }
  }, [enabled]);

  return {
    state,
    resume: () => {
      pausedRef.current = false;
      setState({ status: 'idle' });
    },
    cancel: () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      setState({ status: 'idle' });
    },
  };
}
