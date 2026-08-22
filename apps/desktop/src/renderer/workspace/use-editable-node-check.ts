import { useEffect, useRef, useState } from 'react';

import type { VoiceChannelActions } from '../voice/use-voice-channel.js';

export type EditableCheckResult = 'pending' | 'allowed' | 'denied';

/**
 * T13.2 — the optimistic per-node Manage-rights check every admin context-menu item gates on when
 * the caller lacks the relevant *global* permission (see this task's own gating-rules doc comment,
 * `services/realtime/src/protocol-handlers.ts`'s `handleChannelGetEditableNode`): calls
 * `actions.getEditableChannelNode(nodeId)` and resolves to `'allowed'`/`'denied'` — never surfaced as
 * an error toast on denial, since a `CHANNEL_ACCESS_DENIED`/`CHANNEL_NOT_FOUND` rejection here simply
 * means the corresponding menu item should not have been offered at all. `nodeId === undefined`
 * (e.g. deleting a top-level node with no parent to check delegated Manage against) resolves
 * immediately to `'denied'` without ever calling the server — there is nothing to check.
 */
export function useEditableNodeCheck(
  actions: VoiceChannelActions,
  nodeId: string | undefined,
  /** Skips the network call entirely and resolves to `'allowed'` immediately — used when the caller
   * already holds the relevant *global* permission, per this task's "global permission is the
   * immediate, synchronous gate" rule. */
  skip: boolean,
): EditableCheckResult {
  const [result, setResult] = useState<EditableCheckResult>(skip ? 'allowed' : 'pending');
  const requestedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (skip) {
      setResult('allowed');
      requestedRef.current = undefined;
      return;
    }
    if (!nodeId) {
      setResult('denied');
      requestedRef.current = undefined;
      return;
    }
    if (requestedRef.current === nodeId) return;
    requestedRef.current = nodeId;
    setResult('pending');
    let cancelled = false;
    actions
      .getEditableChannelNode(nodeId)
      .then(() => {
        if (!cancelled) setResult('allowed');
      })
      .catch(() => {
        if (!cancelled) setResult('denied');
      });
    return () => {
      cancelled = true;
    };
  }, [actions, nodeId, skip]);

  return result;
}
