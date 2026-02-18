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
   const [portalEl, setPortalEl] = React.useState<HTMLDivElement | null>(null);
   const containerRef = React.useRef<HTMLDivElement | null>(null);
   const [pos, setPos] = React.useState<{ top: number; left: number; width: number } | null>(null);
 
   // create portal root synchronously before paint
   React.useLayoutEffect(() => {
     const root = document.createElement("div");
     document.body.appendChild(root);
     setPortalEl(root);
     return () => {
       setPortalEl(null);
       if (root.parentNode) {
         root.parentNode.removeChild(root);
       }
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
     document.addEventListener("pointerdown", onOutside, true);
     document.addEventListener("keydown", onKey);
     return () => {
       document.removeEventListener("pointerdown", onOutside, true);
       document.removeEventListener("keydown", onKey);
     };
   }, [open, onClose, anchorRef]);
 
   if (!portalEl || !open) return null;
 
   const style: React.CSSProperties = {
     position: "fixed",
     top: pos ? pos.top : undefined,
     left: pos ? pos.left : undefined,
     width: pos ? pos.width : undefined,
     zIndex,
    // Let the inner dropdown list handle scrolling/max-height.
    // Keeping the portal wrapper non-scrollable avoids “double scrollbars”.
    overflow: "visible",
    pointerEvents: "auto",
   };
 
   return createPortal(
    <div ref={containerRef} className={className} style={style} onMouseDown={(e) => e.preventDefault()}>
       {children}
     </div>,
     portalEl
   );
 }

