"use client";

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { usePref } from "@/lib/prefs";
import { cn } from "@/lib/utils";

/**
 * A sidebar group with a header that folds it away. The header sticks while
 * its rows scroll under it; folded, it shows how many rows are hidden.
 */
export function SidebarSection({
  id,
  title,
  count,
  action,
  children,
}: {
  /** Remembers the fold per device. */
  id: string;
  title: string;
  count: number;
  /** Beside the title: the section's + button. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const [folded, setFolded] = usePref(`tv:fold:${id}`, false, () => false);
  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center bg-sidebar pr-2 pl-2">
        <button
          aria-expanded={!folded}
          onClick={() => setFolded(!folded)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md pl-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              !folded && "rotate-90",
            )}
          />
          {title}
          {folded && count > 0 && (
            <span className="rounded-full bg-sidebar-accent px-1.5 text-[10px] tracking-normal tabular-nums">
              {count}
            </span>
          )}
        </button>
        {action}
      </div>
      {!folded && children}
    </section>
  );
}
