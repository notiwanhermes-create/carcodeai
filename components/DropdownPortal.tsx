 "use client";

import React from "react";
import { createPortal } from "react-dom";

type Props = {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  zIndex?: number;
};

export default function DropdownPortal({ anchorRef, open, onClose, children, className, style, zIndex = 9999 }: Props) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const portalRootRef = React.useRef<HTMLDivElement | null>(null);
  const [, forceR] = React.useState(0);

  // create portal root early using layout effect so it's available before paint
  React.useLayoutEffect(() => {
    const root = document.createElement("div");
    portalRootRef.current = root;
    document.body.appendChild(root);
    return () => {
      if (portalRootRef.current && portalRootRef.current.parentNode) {
        portalRootRef.current.parentNode.removeChild(portalRootRef.current);
      }
      portalRootRef.current = null;
    };
  }, []);

  // compute position
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number } | null>(null);

  const updatePos = React.useCallback(() => {
    const el = anchorRef?.current;
    if (!el) return setPos(null);
    const r = el.getBoundingClientRect();
    // position relative to document using scroll offsets (per requirements)
    setPos({
      top: r.bottom + window.scrollY,
      left: r.left + window.scrollX,
      width: r.width,
    });
  }, [anchorRef]);

  // Reposition on open, scroll, resize (use layout to avoid flicker)
  React.useLayoutEffect(() => {
    if (!open) return;
    updatePos();
    const onScroll = () => updatePos();
    const onResize = () => updatePos();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    // force re-render periodically to handle some mobile/browser quirks
    const tick = setInterval(() => forceR((n) => n + 1), 1000);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      clearInterval(tick);
    };
  }, [open, updatePos]);

  // Outside click & ESC to close
  React.useEffect(() => {
    if (!open) return;
    // Use Event for pointer/touch so the same handler can be added for both mouse and touch listeners
    function onDocPointer(e: Event) {
      const t = e.target as Node | null;
      if (!t) return;
      if (anchorRef?.current && anchorRef.current.contains(t)) return;
      if (containerRef.current && containerRef.current.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("touchstart", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("touchstart", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!portalRootRef.current) return null;
  if (!open) return null;

  const containerStyle: React.CSSProperties = {
    position: "absolute",
    top: pos ? pos.top : undefined,
    left: pos ? pos.left : undefined,
    width: pos ? pos.width : undefined,
    zIndex,
    pointerEvents: "auto",
    maxHeight: 240,
    overflowY: "auto",
    ...style,
  };

  return createPortal(
    <div
      ref={containerRef}
      className={className}
      style={containerStyle}
      // prevent accidental blur on click inside
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    portalRootRef.current
  );
}

