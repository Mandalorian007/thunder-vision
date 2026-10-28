"use client";

import {
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  restrictToFirstScrollableAncestor,
  restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import {
  createContext,
  type CSSProperties,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
  type TouchEventHandler,
  useCallback,
  useContext,
  useId,
  useRef,
} from "react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// Drag to reorder, the same way in every sidebar list:
// - mouse: the whole row, once it has moved a few px, so a click still
//   selects and right-click still opens the menu;
// - touch: only the grip, so a swipe still scrolls and a long-press still
//   opens the menu;
// - keyboard / screen reader: Move up / Move down in the row's menu.

/** Radix's menu and tooltip triggers hand their child a callback ref. */
export type RefCallback = (node: HTMLElement | null) => void;

/** Swallows the click that ends a mouse drag, so dropping doesn't select. */
const DragEnded = createContext<React.RefObject<number>>({ current: 0 });

const MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

const instructions = {
  draggable:
    "To reorder, drag with a mouse or by the grip, or use Move up and Move down in its menu.",
};

export function SortableList({
  ids,
  onReorder,
  children,
}: {
  ids: string[];
  /** The whole list in its new order. */
  onReorder(ids: string[]): void;
  children: ReactNode;
}) {
  // Stable aria ids between the server render and hydration.
  const id = useId();
  const endedAt = useRef(0);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 4 } }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    endedAt.current = Date.now();
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };
  return (
    <DndContext
      id={id}
      sensors={sensors}
      modifiers={MODIFIERS}
      onDragEnd={onDragEnd}
      accessibility={{ screenReaderInstructions: instructions }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <DragEnded value={endedAt}>{children}</DragEnded>
      </SortableContext>
    </DndContext>
  );
}

/** `ids` with `id` moved one place up (-1) or down (1); null at an end. */
export function moved(ids: string[], id: string, by: -1 | 1) {
  const from = ids.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  return arrayMove(ids, from, to);
}

/**
 * Spread `row` on the draggable element and `grip` on its <Grip>. The row
 * keeps its own role and focus; sortable's button attributes would hide it.
 */
export function useSortableRow(id: string, extraRef?: RefCallback) {
  const endedAt = useContext(DragEnded);
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  // Radix's menu and tooltip triggers need the node too.
  const ref = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      extraRef?.(node);
    },
    [setNodeRef, extraRef],
  );
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  return {
    isDragging,
    row: {
      ref,
      style,
      "data-dragging": isDragging || undefined,
      onMouseDown: listeners?.onMouseDown as MouseEventHandler | undefined,
      onClickCapture: (e: MouseEvent) => {
        if (Date.now() - endedAt.current < 250) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    },
    grip: {
      ref: setActivatorNodeRef,
      onTouchStart: listeners?.onTouchStart as TouchEventHandler | undefined,
    },
  };
}

/** The menu's way to reorder: for the keyboard, and the collapsed rail. */
export function MoveItems({
  Item,
  index,
  count,
  onMove,
}: {
  Item: typeof ContextMenuItem | typeof DropdownMenuItem;
  index: number;
  count: number;
  onMove(by: -1 | 1): void;
}) {
  if (count < 2) return null;
  return (
    <>
      <Item
        disabled={index === 0}
        onSelect={() => onMove(-1)}
        className="pointer-coarse:py-2.5"
      >
        <ArrowUp /> Move up
      </Item>
      <Item
        disabled={index === count - 1}
        onSelect={() => onMove(1)}
        className="pointer-coarse:py-2.5"
      >
        <ArrowDown /> Move down
      </Item>
    </>
  );
}

/**
 * Touch-only drag handle. Keeps a long-press here from opening the menu. A
 * button, not a span: Chrome moves a touch on something it doesn't think is
 * tappable to the nearest thing that is, which here is the row.
 */
export function Grip({
  className,
  ...props
}: ReturnType<typeof useSortableRow>["grip"] & { className?: string }) {
  return (
    <button
      {...props}
      type="button"
      tabIndex={-1}
      aria-hidden
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        "hidden w-6 shrink-0 cursor-grab touch-none items-center justify-center self-stretch text-muted-foreground/60 pointer-coarse:flex [&_svg]:size-4",
        className,
      )}
    >
      <GripVertical />
    </button>
  );
}
