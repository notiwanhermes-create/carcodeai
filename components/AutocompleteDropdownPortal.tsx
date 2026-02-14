"use client";

import React from "react";
import { createPortal } from "react-dom";

type Props = {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  zIndex?: number;
};

export default function AutocompleteDropdownPortal({
  anchorRef,
  open,
  onClose,
  children,
  className,
  zIndex = 99999,
}: Props) {
  const portalRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number } | null>(null);

  React.useLayoutEffect(() => {
    const root = document.createElement("div");
    portalRef.current = root;
    document.body.appendChild(root);
    return () => {
      if (portalRef.current && portalRef.current.parentNode) {
        portalRef.current.parentNode.removeChild(portalRef.current);
      }
      portalRef.current = null;
    };
  }, []);

  const updatePos = React.useCallback(() => {
    const el = anchorRef?.current;
    if (!el) {
      setPos(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setPos({
      top: rect.bottom, // viewport coordinate for fixed positioning
      left: rect.left,
      width: rect.width,
    });
  }, [anchorRef]);

  React.useLayoutEffect(() => {
    if (!open) return;
    updatePos();
    const onScroll = () => updatePos();
    const onResize = () => updatePos();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, updatePos]);

  React.useEffect(() => {
    if (!open) return;
    function onOutside(e: Event) {
      const t = e.target as Node | null;
      if (!t) return;
      if (anchorRef?.current && anchorRef.current.contains(t)) return;
      if (containerRef.current && containerRef.current.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // use capture to close before other handlers
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!portalRef.current || !open) return null;

  const style: React.CSSProperties = {
    position: "fixed",
    top: pos ? pos.top : undefined,
    left: pos ? pos.left : undefined,
    width: pos ? pos.width : undefined,
    zIndex,
    maxHeight: 240,
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
    pointerEvents: "auto",
  };

  return createPortal(
    <div ref={containerRef} className={className} style={style} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    portalRef.current
  );
}

"use client";

import React from "react";
import { createPortal } from "react-dom";

type Props = {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  zIndex?: number;
};

export default function AutocompleteDropdownPortal({
  anchorRef,
  open,
  onClose,
  children,
  className,
  zIndex = 99999,
}: Props) {
  const portalRootRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number } | null>(null);

  // create portal root synchronously before paint
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

  const updatePos = React.useCallback(() => {
    const el = anchorRef?.current;
    if (!el) {
      setPos(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setPos({
      top: rect.bottom + 8,
      left: rect.left,
      width: rect.width,
    });
  }, [anchorRef]);

  React.useLayoutEffect(() => {
    if (!open) return;
    updatePos();
    const onScroll = () => updatePos();
    const onResize = () => updatePos();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, updatePos]);

  React.useEffect(() => {
    if (!open) return;
    // capture phase outside click closing
    function onOutside(e: Event) {
      const t = e.target as Node | null;
      if (!t) return;
      if (anchorRef?.current && anchorRef.current.contains(t)) return;
      if (containerRef.current && containerRef.current.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("touchstart", onOutside, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("touchstart", onOutside, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!portalRootRef.current || !open) return null;

  const style: React.CSSProperties = {
    position: "fixed",
    top: pos ? pos.top : undefined,
    left: pos ? pos.left : undefined,
    width: pos ? pos.width : undefined,
    zIndex,
    maxHeight: 240,
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
    // ensure background is transparent by default; styling via className preferred
    background: "transparent",
  };

  return createPortal(
    <div ref={containerRef} className={className} style={style} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    portalRootRef.current
  );
}

