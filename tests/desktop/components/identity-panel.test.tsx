// @vitest-environment jsdom
//
// T13.1.1 QA: `IdentityPanel`'s "Danger zone" restyle must not weaken the underlying destructive
// confirmation — the `window.confirm` gate (unchanged text, unchanged gating of the real
// `onRegenerate` call) is the one hard invariant this file protects. No test for this component
// existed before T13.1.1 (it wasn't touched by T13.1's own suite); kept to exactly this scope plus
// minimal rendering smoke coverage.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdentityPanel } from '../../../apps/desktop/src/renderer/identity/IdentityPanel.js';
import { createIdentity } from '../fixtures/desktop-app-mock.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const REGENERATE_CONFIRM_MESSAGE =
  'Regenerate your local identity? This creates a brand-new cryptographic identity. ' +
  'Servers you have connected to before will see this as a new, unrecognized identity, and you ' +
  'may lose any permissions associated with the old one. This cannot be undone.';

function renderPanel(overrides: Partial<Parameters<typeof IdentityPanel>[0]> = {}) {
  const onNicknameChange = vi.fn().mockResolvedValue(true);
  const onRegenerate = vi.fn().mockResolvedValue(undefined);
  const props: Parameters<typeof IdentityPanel>[0] = {
    nickname: 'Nova',
    identity: createIdentity(),
    onNicknameChange,
    onRegenerate,
    ...overrides,
  };
  const result = render(<IdentityPanel {...props} />);
  return { ...result, onNicknameChange, onRegenerate, identity: props.identity };
}

describe('IdentityPanel (T13.1.1 — danger-zone confirmation gate unchanged)', () => {
  it('renders the real nickname and Identity ID — never fabricated placeholders', () => {
    const { identity } = renderPanel();
    expect(screen.getByDisplayValue('Nova')).toBeInTheDocument();
    expect(screen.getByText(identity.identityId)).toBeInTheDocument();
  });

  it('clicking Regenerate Identity asks for confirmation with the exact, unweakened warning text', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Identity' }));

    expect(confirmSpy).toHaveBeenCalledWith(REGENERATE_CONFIRM_MESSAGE);
  });

  it('does NOT call the real onRegenerate action when the user cancels the confirmation', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onRegenerate } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Identity' }));

    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it('DOES call the real onRegenerate action once the user confirms — the confirmation genuinely gates production behavior', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onRegenerate } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Identity' }));

    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });
});
