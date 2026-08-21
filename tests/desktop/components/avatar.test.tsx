// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Avatar, colorFor, initialsFor } from '../../../apps/desktop/src/renderer/ui/Avatar.js';

afterEach(() => {
  cleanup();
});

describe('Avatar (T13.1)', () => {
  it('derives stable initials from a normal display name', () => {
    expect(initialsFor('Alice Smith')).toBe('AS');
    expect(initialsFor('Alice')).toBe('A');
  });

  it('never throws on an empty name, and falls back to a neutral placeholder', () => {
    expect(() => initialsFor('')).not.toThrow();
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('   ')).toBe('?');
  });

  it('never throws on a very long name, and bounds its output to at most two codepoints', () => {
    const longName = 'A'.repeat(5000) + ' ' + 'B'.repeat(5000);
    expect(() => initialsFor(longName)).not.toThrow();
    const initials = initialsFor(longName);
    expect(Array.from(initials).length).toBeLessThanOrEqual(2);
    expect(initials).toBe('AB');
  });

  it('is deterministic across repeated calls for the same name (no Math.random)', () => {
    const name = 'Repeatable Name';
    const first = initialsFor(name);
    const second = initialsFor(name);
    const firstColor = colorFor(name);
    const secondColor = colorFor(name);
    expect(first).toBe(second);
    expect(firstColor).toBe(secondColor);
  });

  it('is stable across multiple renders of the same component instance and across remounts', () => {
    const { unmount, rerender } = render(<Avatar name="Stable Name" />);
    const firstText = screen.getByText('SN').textContent;

    rerender(<Avatar name="Stable Name" />);
    expect(screen.getByText('SN').textContent).toBe(firstText);

    unmount();
    render(<Avatar name="Stable Name" />);
    expect(screen.getByText('SN').textContent).toBe(firstText);
  });

  it('renders without throwing for an empty name', () => {
    expect(() => render(<Avatar name="" />)).not.toThrow();
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});
