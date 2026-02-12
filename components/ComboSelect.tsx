"use client";

import * as React from "react";

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
  displayValue?: (value: string) => string;
  allowCustomValue?: boolean;
  triggerType?: "button" | "input";
  filterable?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  theme?: "dark" | "light";
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
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
  triggerClassName,
  contentClassName,
  theme = "dark",
  onBlur,
  onKeyDown,
  onSelect: onSelectProp,
}: ComboSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [highlightIdx, setHighlightIdx] = React.useState(0);
  const [dropWidth, setDropWidth] = React.useState<number | undefined>();
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const display = displayValue ? displayValue(value) : value;
  const showValue = display || (allowCustomValue ? value : "");

  const filtered = React.useMemo(() => {
    if (!filterable || !search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter((opt) => optionLabel(opt).toLowerCase().includes(q));
  }, [options, search, filterable]);

  React.useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropWidth(rect.width);
    }
  }, [open]);

  React.useEffect(() => {
    setHighlightIdx(0);
  }, [filtered.length, open]);

  const doSelect = React.useCallback(
    (v: string) => {
      if (onSelectProp) {
        onSelectProp(v);
      } else {
        onValueChange(v);
      }
      setOpen(false);
      setSearch("");
    },
    [onValueChange, onSelectProp],
  );

  const handleInputChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onValueChange(e.target.value);
      if (!open && e.target.value.trim()) setOpen(true);
    },
    [onValueChange, open],
  );

  const handleTriggerClick = React.useCallback(() => {
    if (!disabled && options.length > 0) setOpen((p) => !p);
  }, [disabled, options.length]);

  const handleInputFocus = React.useCallback(() => {
    if (!disabled && options.length > 0) setOpen(true);
  }, [disabled, options.length]);

  React.useEffect(() => {
    if (triggerType === "input" && options.length > 0 && value.trim()) {
      setOpen(true);
    }
  }, [options, triggerType, value]);

  React.useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        listRef.current &&
        !listRef.current.contains(target)
      ) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const handleListKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        doSelect(optionValue(filtered[highlightIdx]));
      } else if (e.key === "Escape") {
        setOpen(false);
        setSearch("");
      }
    },
    [filtered, highlightIdx, doSelect],
  );

  const textClass = theme === "dark" ? "text-slate-200" : "text-slate-700";
  const hoverClass = "hover:bg-blue-500 hover:text-white";
  const emptyClass = theme === "dark" ? "text-slate-500" : "text-slate-400";
  const highlightClass = "bg-blue-500/80 text-white";

  return (
    <div ref={triggerRef} className="relative" style={{ position: "relative" }}>
      {triggerType === "input" ? (
        <input
          type="text"
          name={name}
          value={value}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onBlur={(e) => {
            const related = e.relatedTarget as Node | null;
            if (listRef.current && related && listRef.current.contains(related)) return;
            setTimeout(() => {
              onBlur?.();
            }, 150);
          }}
          onKeyDown={(e) => {
            if (open && (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.key === "Enter" && filtered.length > 0))) {
              handleListKeyDown(e);
              return;
            }
            onKeyDown?.(e);
          }}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
          placeholder={placeholder}
          autoComplete="off"
          className={triggerClassName}
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={handleTriggerClick}
          className={triggerClassName}
        >
          {showValue ? (
            <span className="block truncate text-left">{showValue}</span>
          ) : (
            <span className={emptyClass}>{placeholder}</span>
          )}
        </button>
      )}
      {name && triggerType === "button" && (
        <input type="hidden" name={name} value={value} />
      )}
      {open && filtered.length > 0 && (
        <div
          ref={listRef}
          className={contentClassName}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 8,
            width: dropWidth ?? "100%",
            zIndex: 9999,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {filterable && options.length > 6 && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full rounded-t-lg border-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:opacity-60"
              autoFocus
              onKeyDown={handleListKeyDown}
            />
          )}
          <div
            className="max-h-[300px] overflow-y-auto overflow-x-hidden rounded-b-lg p-1"
            role="listbox"
          >
            {filtered.map((opt, idx) => {
              const val = optionValue(opt);
              const label = optionLabel(opt);
              return (
                <div
                  key={val + idx}
                  role="option"
                  aria-selected={idx === highlightIdx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    doSelect(val);
                  }}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  className={`cursor-pointer rounded-md px-3 py-2 text-sm outline-none ${textClass} ${hoverClass} ${idx === highlightIdx ? highlightClass : ""}`}
                >
                  {label}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
