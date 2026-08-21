import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

import styles from './ContextMenu.module.css';

export interface ContextMenuItem {
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

interface ContextMenuProps {
  readonly open: boolean;
  readonly position: { readonly x: number; readonly y: number };
  readonly items: readonly ContextMenuItem[];
  readonly onClose: () => void;
}

/**
 * Shared right-click/menu primitive — closes on outside-click or Escape, stays within the viewport
 * (measured and clamped after render), and supports basic arrow-key navigation plus Enter/Escape,
 * per the task's own "no need for full ARIA menu spec" scope.
 */
export function ContextMenu({
  open,
  position,
  items,
  onClose,
}: ContextMenuProps): ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [clampedPosition, setClampedPosition] = useState(position);

  useLayoutEffect(() => {
    if (!open) return;
    const node = menuRef.current;
    if (!node) {
      setClampedPosition(position);
      return;
    }
    const rect = node.getBoundingClientRect();
    const margin = 4;
    const x = Math.min(position.x, window.innerWidth - rect.width - margin);
    const y = Math.min(position.y, window.innerHeight - rect.height - margin);
    setClampedPosition({ x: Math.max(margin, x), y: Math.max(margin, y) });
    setActiveIndex(0);
  }, [open, position]);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event: PointerEvent): void {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    function handleKeyDown(event: KeyboardEvent): void {
      const enabled = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !item.disabled);
      if (enabled.length === 0) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev) => {
          const currentPos = enabled.findIndex(({ index }) => index === prev);
          const next = enabled[(currentPos + 1) % enabled.length];
          return next ? next.index : prev;
        });
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev) => {
          const currentPos = enabled.findIndex(({ index }) => index === prev);
          const next = enabled[(currentPos - 1 + enabled.length) % enabled.length];
          return next ? next.index : prev;
        });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const current = items[activeIndex];
        if (current && !current.disabled) {
          current.onSelect();
          onClose();
        }
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, items, activeIndex, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={styles.menu}
      style={{ left: clampedPosition.x, top: clampedPosition.y }}
    >
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`${styles.item} ${item.danger ? styles.danger : ''} ${
              index === activeIndex ? styles.active : ''
            }`}
            onMouseEnter={() => {
              setActiveIndex(index);
            }}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {Icon && <Icon size={16} aria-hidden="true" />}
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
