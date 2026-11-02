import type { BlockNode, InlineNode, Mark } from "@docleus/sdk";

// The same rules as the server's body save (core-server `reuse.ts` with
// core-markdown's `normalizeInline`), which plugins cannot import: a snapshot
// keeps untouched blocks in their stored form.

const CORE_MARKS = ["link", "strike", "bold", "italic", "code"];

/** JSON with object keys sorted and `undefined` dropped. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(
    entries.map(([key, inner]) => [key, sortKeys(inner)]),
  );
}

function compareMarks(a: Mark, b: Mark): number {
  const ia = CORE_MARKS.indexOf(a.type);
  const ib = CORE_MARKS.indexOf(b.type);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  const sa = stableStringify(a);
  const sb = stableStringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sameMarks(a: readonly Mark[] = [], b: readonly Mark[] = []): boolean {
  return (
    a.length === b.length &&
    a.every((mark, i) => stableStringify(mark) === stableStringify(b[i]))
  );
}

function normalizeInline(nodes: readonly InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    let current = node;
    if (current.marks) {
      const unique = new Map(
        current.marks.map((mark) => [stableStringify(mark), mark]),
      );
      const marks = [...unique.values()].toSorted(compareMarks);
      const { marks: _marks, ...rest } = current;
      current = marks.length > 0 ? { ...rest, marks } : rest;
    }
    if (current.content) {
      current = { ...current, content: normalizeInline(current.content) };
    }
    if (current.type === "text") {
      if (!current.text) continue;
      const previous = out.at(-1);
      if (
        previous?.type === "text" &&
        previous.attrs === undefined &&
        current.attrs === undefined &&
        sameMarks(previous.marks, current.marks)
      ) {
        out[out.length - 1] = {
          ...previous,
          text: `${previous.text ?? ""}${current.text}`,
        };
        continue;
      }
    }
    out.push(current);
  }
  return out;
}

/** What a block means regardless of how the editor spells it. */
function canonical(block: BlockNode): unknown {
  const inline = normalizeInline(block.inline ?? []);
  const content = (block.content ?? []).map(canonical);
  return {
    type: block.type,
    v: block.v,
    attrs: block.attrs,
    ...(inline.length > 0 && { inline }),
    ...(content.length > 0 && { content }),
  };
}

/** Whether two blocks hold the same content, ids aside. */
export function sameMeaning(a: BlockNode, b: BlockNode): boolean {
  return stableStringify(canonical(a)) === stableStringify(canonical(b));
}

function indexById(block: BlockNode, into: Map<string, BlockNode>): void {
  into.set(block.id, block);
  for (const child of block.content ?? []) indexById(child, into);
}

/**
 * Replaces every block of `next` that means the same as the block with its
 * id in `previous` by that previous block.
 */
export function reuseUnchanged(
  previous: BlockNode | undefined,
  next: BlockNode,
): BlockNode {
  if (!previous) return next;
  const old = new Map<string, BlockNode>();
  indexById(previous, old);
  const visit = (block: BlockNode): BlockNode => {
    const before = old.get(block.id);
    if (before && sameMeaning(before, block)) return before;
    return block.content
      ? { ...block, content: block.content.map(visit) }
      : block;
  };
  return visit(next);
}

/** Whether two trees are equal, ids included, once `reuseUnchanged` ran. */
export function sameTree(a: BlockNode, b: BlockNode): boolean {
  if (a === b) return true;
  if (a.id !== b.id || !sameMeaning(a, b)) return false;
  const left = a.content ?? [];
  const right = b.content ?? [];
  return (
    left.length === right.length &&
    left.every((child, i) => {
      const other = right[i];
      return other !== undefined && sameTree(child, other);
    })
  );
}
