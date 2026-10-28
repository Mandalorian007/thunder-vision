"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type TooltipSide = "top" | "right" | "bottom" | "left";

export function IconButton({
  label,
  onClick,
  pressed,
  side = "bottom",
  className,
  children,
}: {
  label: string;
  onClick(): void;
  pressed?: boolean;
  side?: TooltipSide;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={cn(
            // Finger-sized on touch screens.
            "size-8 text-muted-foreground aria-pressed:text-primary pointer-coarse:size-10",
            className,
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
