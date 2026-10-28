"use client";

import {
  AArrowDown,
  AArrowUp,
  Keyboard,
  Moon,
  Settings2,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { TooltipSide } from "@/components/icon-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const item = "pointer-coarse:py-2.5";

/** Display settings: text size, key bar, theme. */
export function SettingsMenu({
  side,
  fontSize,
  onFontSize,
  showKeys,
  onShowKeys,
}: {
  side: TooltipSide;
  fontSize: number;
  onFontSize(delta: number): void;
  showKeys: boolean;
  onShowKeys(show: boolean): void;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Settings"
              className="size-8 text-muted-foreground pointer-coarse:size-10"
            >
              <Settings2 />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={side}>Settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side={side === "right" ? "right" : "bottom"}
        align="start"
        className="w-52"
        // Hand focus back to the terminal, not this button.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel>Text size</DropdownMenuLabel>
        {/* Stay open so the size can be stepped a few times. */}
        <DropdownMenuItem
          className={item}
          onSelect={(e) => {
            e.preventDefault();
            onFontSize(-1);
          }}
        >
          <AArrowDown /> Smaller
          <DropdownMenuShortcut>{fontSize}px</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={item}
          onSelect={(e) => {
            e.preventDefault();
            onFontSize(1);
          }}
        >
          <AArrowUp /> Larger
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          className={item}
          checked={showKeys}
          onCheckedChange={(checked) => onShowKeys(checked === true)}
        >
          <Keyboard /> Key bar
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem
          className={item}
          onSelect={() => setTheme(dark ? "light" : "dark")}
        >
          {dark ? <Sun /> : <Moon />} {dark ? "Light theme" : "Dark theme"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
