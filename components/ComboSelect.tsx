"use client";

import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";

export type ComboSelectOption = string | { value: string; label: string };

function optionValue(opt: ComboSelectOption): string {
  return typeof opt === "string" ? opt : opt.value;
}

function optionLabel(opt: ComboSelectOption): string {
  return typeof opt === "string" ? opt : opt.label ?? opt.value;
}

export type ComboSelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: ComboSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  /** Display transform for the trigger (e.g. engine shorthand) */
  displayValue?: (value: string) => string;
  /** Allow typing custom value (e.g. Make); use with triggerType="input" */
  allowCustomValue?: boolean;
  /** "button" = click to open list only; "input" = type + open list (for Make) */
  triggerType?: "button" | "input";
  filterable?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  /** Theme: "dark" | "light" for list styles */
  theme?: "dark" | "light";
  /** For triggerType="input": blur handler (e.g. confirm make) */
  onBlur?: () => void;
  /** For triggerType="input": keydown (e.g. Enter to confirm) */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Called when user picks an item from the dropdown (distinct from typing) */
  onSelect?: (value: string) => void;
};

export function ComboSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select...",
  disabled = false,
  name,
  displayValue,
  allowCustomValue = false,
  triggerType = "button",
  filterable = true,
  className,
  triggerClassName,
  contentClassName,
  theme = "dark",
  onBlur,
  onKeyDown,
  onSelect: onSelectProp,
}: ComboSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const triggerRef = React.useRef<HTMLButtonElement | HTMLInputElement>(null);

  const display = displayValue ? displayValue(value) : value;
  const showValue = display || (allowCustomValue ? value : "");

  const handleSelect = React.useCallback(
    (v: string) => {
      if (onSelectProp) {
        onSelectProp(v);
      } else {
        onValueChange(v);
      }
      setOpen(false);
      setSearch("");
    },
    [onValueChange, onSelectProp]
  );

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  }, []);

  const handleTriggerClick = React.useCallback(() => {
    if (!disabled) setOpen(true);
  }, [disabled]);

  const handleTriggerFocus = React.useCallback(() => {
    if (!disabled) setOpen(true);
  }, [disabled]);

  const textClass = theme === "dark" ? "text-slate-200" : "text-slate-700";
  const hoverClass = "hover:bg-blue-500 hover:text-white";
  const emptyClass = theme === "dark" ? "text-slate-500" : "text-slate-400";

  const baseTriggerClass = triggerClassName ?? className ?? "";

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Anchor asChild>
        {triggerType === "input" ? (
          <div className="relative w-full pointer-events-none">
            <input
              style={{ pointerEvents: "auto" }}
              ref={triggerRef as React.RefObject<HTMLInputElement>}
              type="text"
              name={name}
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              onFocus={handleTriggerFocus}
              onClick={handleTriggerClick}
              onBlur={onBlur}
              onKeyDown={onKeyDown}
              disabled={disabled}
              aria-disabled={disabled}
              aria-expanded={open}
              aria-haspopup="listbox"
              placeholder={placeholder}
              className={baseTriggerClass}
            />
          </div>
        ) : (
          <button
            ref={triggerRef as React.RefObject<HTMLButtonElement>}
            type="button"
            disabled={disabled}
            aria-disabled={disabled}
            aria-expanded={open}
            aria-haspopup="listbox"
            onClick={handleTriggerClick}
            onFocus={handleTriggerFocus}
            className={baseTriggerClass}
            style={{ pointerEvents: disabled ? undefined : "auto" }}
          >
            {showValue ? (
              <span className="block truncate text-left">{showValue}</span>
            ) : (
              <span className={emptyClass}>{placeholder}</span>
            )}
          </button>
        )}
      </Popover.Anchor>
      {name && triggerType === "button" && <input type="hidden" name={name} value={value} />}
      <Popover.Portal>
        <Popover.Content
          className={contentClassName}
          sideOffset={8}
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            triggerRef.current?.focus();
          }}
          style={{ zIndex: 9999 }}
        >
          <Command
            label="Options"
            shouldFilter={filterable}
            value={value}
            onValueChange={handleSelect}
            className="rounded-lg border-0 bg-transparent p-0"
            loop
          >
            {filterable && options.length > 0 && (
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search..."
                className="w-full rounded-t-lg border-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:opacity-60"
                autoFocus
              />
            )}
            <Command.List
              className="max-h-[300px] overflow-y-auto overflow-x-hidden rounded-b-lg p-1"
              style={{ minHeight: "40px" }}
            >
              <Command.Empty className="py-4 text-center text-sm opacity-60">
                No results.
              </Command.Empty>
              {options.map((opt, idx) => {
                const val = optionValue(opt);
                const label = optionLabel(opt);
                return (
                  <Command.Item
                    key={val + idx}
                    value={val}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelect(val);
                    }}
                    onSelect={() => handleSelect(val)}
                    className={`cursor-pointer rounded-md px-3 py-2 text-sm outline-none ${textClass} ${hoverClass} data-[selected=true]:bg-blue-500/80 data-[selected=true]:text-white`}
                  >
                    {label}
                  </Command.Item>
                );
              })}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
