"use client";

import * as React from "react";
import AutocompleteDropdownPortal from "./AutocompleteDropdownPortal";

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
  const [inputText, setInputText] = React.useState("");
  const [isTyping, setIsTyping] = React.useState(false);
  const [highlightIdx, setHighlightIdx] = React.useState(0);
  const [dropWidth, setDropWidth] = React.useState<number | undefined>();
  const [dropPos, setDropPos] = React.useState<{ top: number; left: number } | null>(null);
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const display = displayValue ? displayValue(value) : value;

  const filtered = React.useMemo(() => {
    const q = isTyping ? inputText.toLowerCase().trim() : "";
    if (!q) return options;
    return options.filter((opt) => optionLabel(opt).toLowerCase().includes(q));
  }, [options, inputText, isTyping]);

  React.useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropWidth(rect.width);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open || !triggerRef.current) {
      setDropPos(null);
      return;
    }
    function updatePos() {
      const rect = triggerRef.current!.getBoundingClientRect();
      setDropPos({
        top: rect.bottom + window.scrollY + 8,
        left: rect.left + window.scrollX,
      });
      setDropWidth(rect.width);
    }
    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [open]);

  // AutocompleteDropdownPortal manages its own portal root

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
      setInputText("");
      setIsTyping(false);
    },
    [onValueChange, onSelectProp],
  );

  const handleInputChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      if (triggerType === "input") {
        onValueChange(val);
      } else {
        setInputText(val);
        setIsTyping(true);
      }
      if (!open) setOpen(true);
    },
    [onValueChange, open, triggerType],
  );

  const handleFocus = React.useCallback(() => {
    if (disabled) return;
    if (triggerType !== "input") {
      setInputText("");
      setIsTyping(false);
    }
    if (options.length > 0) setOpen(true);
  }, [disabled, options.length, triggerType]);

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
        setInputText("");
        setIsTyping(false);
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
        setInputText("");
        setIsTyping(false);
      }
    },
    [filtered, highlightIdx, doSelect],
  );

  const textClass = theme === "dark" ? "text-slate-200" : "text-slate-700";
  const hoverClass = "hover:bg-blue-500 hover:text-white";
  const emptyClass = theme === "dark" ? "text-slate-500" : "text-slate-400";
  const highlightClass = "bg-blue-500/80 text-white";

  const shownValue = triggerType === "input"
    ? value
    : (open && isTyping) ? inputText : (display || "");

  return (
    <div ref={triggerRef} className="relative" style={{ position: "relative" }}>
      <input
        ref={inputRef}
        type="text"
        name={triggerType === "input" ? name : undefined}
        value={shownValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onClick={() => { if (!disabled && options.length > 0) setOpen(true); }}
        onBlur={(e) => {
          const related = e.relatedTarget as Node | null;
          if (listRef.current && related && listRef.current.contains(related)) return;
          setTimeout(() => {
            setIsTyping(false);
            setInputText("");
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
        readOnly={triggerType === "button" && !open}
        aria-expanded={open}
        aria-haspopup="listbox"
        placeholder={placeholder}
        autoComplete="off"
        className={triggerClassName}
      />
      {name && triggerType === "button" && (
        <input type="hidden" name={name} value={value} />
      )}
      {open && filtered.length > 0 && (
        <AutocompleteDropdownPortal
          anchorRef={triggerRef}
          open={open}
          onClose={() => {
            setOpen(false);
            setInputText("");
            setIsTyping(false);
          }}
          className={contentClassName}
        >
          <div
            ref={listRef}
            style={{
              marginTop: 0,
              width: dropWidth ?? "100%",
              WebkitOverflowScrolling: "touch",
              willChange: "transform",
              transform: "translateZ(0)",
            }}
          >
            <div
              className="max-h-[240px] overflow-y-auto overflow-x-hidden rounded-lg p-1"
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
        </AutocompleteDropdownPortal>
      )}
    </div>
  );
}
