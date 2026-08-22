import type {
  AclPolicyKind,
  ChannelNodeView,
  ManagePolicyKind,
  NodeKind,
} from '@disco-voador/protocol';

/**
 * T13.2 — the one place this Renderer builds a hierarchy out of the flat `ChannelNodeView[]` the
 * server sends on every `voice:catalog` — every consumer (`ChannelSidebar`, the Server Settings
 * Channels admin surface, the Create/Edit modals' parent picker) calls into this module rather than
 * each re-deriving its own tree/ancestor-walk logic.
 */

/** Order-insensitive equality for a group-id list — used by every admin modal's "submit only the
 * changed fields" diff (a re-ordered but otherwise identical selection is not a real change). */
export function sameGroupIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((id) => bSet.has(id));
}

export interface ChannelTreeNode extends ChannelNodeView {
  readonly children: readonly ChannelTreeNode[];
}

function sortSiblings(nodes: ChannelNodeView[]): ChannelNodeView[] {
  return [...nodes].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Builds the nested tree (root nodes — no `parentId`, or a `parentId` not present in `nodes` — at
 * the top level) from the flat, already-visibility-filtered list `voice:catalog` sends. Every
 * `voice:catalog` message replaces the input wholesale, so this is a pure, cheap rebuild each time
 * — no incremental patching, matching the backend's own "resend the whole small bounded thing"
 * design (see `packages/protocol/src/messages/channels.ts`). */
export function buildChannelTree(nodes: readonly ChannelNodeView[]): readonly ChannelTreeNode[] {
  const byParent = new Map<string | undefined, ChannelNodeView[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const nodeIds = new Set(nodes.map((node) => node.nodeId));

  function attach(node: ChannelNodeView): ChannelTreeNode {
    const children = sortSiblings(byParent.get(node.nodeId) ?? []).map(attach);
    return { ...node, children };
  }

  // A root is a node with no `parentId`, *or* one whose `parentId` does not resolve to anything in
  // this (already visibility-filtered) list — the latter can legitimately happen: a node's parent
  // category may be invisible to this identity while the child itself is visible (an `'inherit'`
  // child under an `'everyone'`-overridden ancestor further up is not the same case, but a directly
  // hidden parent with a visible child is possible under this ACL model), so treating it as a
  // top-level node here (rather than silently dropping it) is the only way to avoid losing a channel
  // this identity is genuinely allowed to see.
  const roots = nodes.filter((node) => node.parentId === undefined || !nodeIds.has(node.parentId));
  return sortSiblings(roots).map(attach);
}

export function findNode(
  nodes: readonly ChannelNodeView[],
  nodeId: string,
): ChannelNodeView | undefined {
  return nodes.find((node) => node.nodeId === nodeId);
}

/** `[self, parent, ..., root]` — stops at the first ancestor id this list does not contain (a hidden
 * ancestor, or a genuine root). Guards against a malformed/cyclic parent chain (should never happen
 * server-side, but a defensive `seen` set costs nothing here). */
export function ancestorChain(
  nodes: readonly ChannelNodeView[],
  nodeId: string,
): readonly ChannelNodeView[] {
  const chain: ChannelNodeView[] = [];
  const seen = new Set<string>();
  let current = findNode(nodes, nodeId);
  while (current && !seen.has(current.nodeId)) {
    seen.add(current.nodeId);
    chain.push(current);
    current = current.parentId ? findNode(nodes, current.parentId) : undefined;
  }
  return chain;
}

export interface ResolvedPolicy<K> {
  /** The ancestor whose own explicit (non-`'inherit'`) setting this resolved from, or `undefined`
   * when every ancestor (including `nodeId` itself) is `'inherit'` — the hardcoded root default. */
  readonly source: ChannelNodeView | undefined;
  readonly policy: K;
}

/** Read-only, display-only reimplementation of `ChannelPort`'s nearest-non-`'inherit'`-ancestor walk
 * (see `services/realtime/src/channel-port.ts`'s doc comment for the authoritative algorithm this
 * mirrors) — used only to show an admin *where* an "Inherit" policy resolves from in the Edit
 * dialog. This never makes or influences a real access decision; the server is the only authority
 * for that (see this module's own file-level doc comment). */
export function resolveNearestPolicy<K extends string>(
  nodes: readonly ChannelNodeView[],
  nodeId: string,
  axis: 'joinPolicy' | 'managePolicy',
  rootDefault: K,
): ResolvedPolicy<K> {
  const chain = ancestorChain(nodes, nodeId);
  for (const ancestor of chain) {
    const value = ancestor[axis] as unknown as K | 'inherit';
    if (value !== 'inherit') {
      return { source: ancestor, policy: value };
    }
  }
  return { source: undefined, policy: rootDefault };
}

/** Visibility bounds *all descendants* (top-down, not nearest-ancestor) — see `channel-port.ts`'s
 * doc comment: any ancestor's `'selected-groups'` failing makes the whole subtree invisible
 * regardless of the node's own setting, and an `'everyone'` ancestor clears any restriction found so
 * far. For *display* purposes (never a security decision), this returns the first non-`'inherit'`
 * ancestor found root-down, exactly mirroring how the real algorithm evaluates the chain — an admin
 * editing "Inherit" sees the same ancestor the server would actually enforce against. */
export function resolveVisibilityPolicy(
  nodes: readonly ChannelNodeView[],
  nodeId: string,
): ResolvedPolicy<AclPolicyKind> {
  const chain = [...ancestorChain(nodes, nodeId)].reverse(); // root-first
  for (const ancestor of chain) {
    if (ancestor.visibilityPolicy !== 'inherit') {
      return { source: ancestor, policy: ancestor.visibilityPolicy };
    }
  }
  return { source: undefined, policy: 'everyone' };
}

export function resolveJoinPolicy(
  nodes: readonly ChannelNodeView[],
  nodeId: string,
): ResolvedPolicy<AclPolicyKind> {
  return resolveNearestPolicy(nodes, nodeId, 'joinPolicy', 'everyone');
}

export function resolveManagePolicy(
  nodes: readonly ChannelNodeView[],
  nodeId: string,
): ResolvedPolicy<ManagePolicyKind> {
  return resolveNearestPolicy(nodes, nodeId, 'managePolicy', 'inherit');
}

/** 0-based depth (root = 0) — mirrors `ChannelStore`'s own internal depth semantics (see
 * `packages/protocol/src/channels.ts`'s `MAX_CHANNEL_DEPTH` doc comment). Used only to grey out an
 * invalid parent choice in the Create/Move parent picker — the server independently re-enforces the
 * real bound regardless. */
export function depthOf(nodes: readonly ChannelNodeView[], nodeId: string): number {
  return ancestorChain(nodes, nodeId).length - 1;
}

/** Every id in `nodeId`'s own subtree, including `nodeId` itself — used by the Move dialog to
 * exclude a node's own descendants from its valid-target list (moving a node into its own
 * descendant is a cycle the server would also reject via `CHANNEL_PARENT_INVALID`, but excluding it
 * client-side avoids ever presenting an option guaranteed to fail) and by the delete-confirmation
 * dialog's cascade-count copy. */
export function collectSubtreeIds(
  nodes: readonly ChannelNodeView[],
  nodeId: string,
): ReadonlySet<string> {
  const byParent = new Map<string | undefined, ChannelNodeView[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const ids = new Set<string>();
  function visit(id: string): void {
    if (ids.has(id)) return;
    ids.add(id);
    for (const child of byParent.get(id) ?? []) visit(child.nodeId);
  }
  visit(nodeId);
  return ids;
}

/** The number of nodes in `nodeId`'s subtree, not counting `nodeId` itself — used for a truthful
 * "this will also delete N channel(s) inside it" confirmation when deleting a category (deletion
 * always cascades the whole subtree server-side; there is no separate "still has children"
 * rejection). */
export function countDescendants(nodes: readonly ChannelNodeView[], nodeId: string): number {
  return collectSubtreeIds(nodes, nodeId).size - 1;
}

export interface PickerEntry {
  readonly nodeId: string;
  readonly name: string;
  readonly depth: number;
  readonly kind: NodeKind;
  /** `true` when this entry should not be a selectable target (own subtree, or already at
   * `MAX_CHANNEL_DEPTH`) — the caller renders it as a disabled `<option>` rather than omitting it,
   * so the tree's real shape stays visible even for an invalid choice. */
  readonly disabled: boolean;
}

/** Flattens the real tree into a depth-annotated list for a parent/move picker `<select>`,
 * excluding `excludeSubtreeOf`'s own subtree entirely (never even a disabled option — a node cannot
 * be shown as a location "inside itself") and marking any entry already at `maxDepth` as disabled
 * (greyed out, not hidden — the tree's real shape stays visible). `maxDepth` is 0-based, matching
 * `depthOf`'s own convention (a node at `maxDepth` cannot accept a child, since that child would sit
 * one level deeper). */
export function flattenTreeForPicker(
  nodes: readonly ChannelNodeView[],
  options: { readonly excludeSubtreeOf?: string; readonly maxDepth: number } = { maxDepth: 3 },
): readonly PickerEntry[] {
  const excluded = options.excludeSubtreeOf
    ? collectSubtreeIds(nodes, options.excludeSubtreeOf)
    : undefined;

  function flatten(tree: readonly ChannelTreeNode[], depth: number): PickerEntry[] {
    const result: PickerEntry[] = [];
    for (const node of tree) {
      if (excluded?.has(node.nodeId)) continue;
      result.push({
        nodeId: node.nodeId,
        name: node.name,
        depth,
        kind: node.kind,
        disabled: depth >= options.maxDepth,
      });
      result.push(...flatten(node.children, depth + 1));
    }
    return result;
  }

  return flatten(buildChannelTree(nodes), 0);
}
