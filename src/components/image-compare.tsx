"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface ImageCompareProps {
  originalSrc: string;
  editedSrc: string;
  /** Optional low-res thumbnail for instant preview while full image loads */
  editedThumbSrc?: string;
  className?: string;
}

/**
 * Before/After image comparison slider.
 * Shows original on the left, edited on the right with a draggable divider.
 * Dimensions badges in bottom-right of each side.
 */
export function ImageCompare({
  originalSrc,
  editedSrc,
  editedThumbSrc,
  className = "",
}: ImageCompareProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50); // slider at 50%
  const [isDragging, setIsDragging] = useState(false);
  const [originalDims, setOriginalDims] = useState<{
    w: number;
    h: number;
  } | null>(null);
  const [editedDims, setEditedDims] = useState<{
    w: number;
    h: number;
  } | null>(null);
  const [editedLoaded, setEditedLoaded] = useState(false);
  const [originalLoaded, setOriginalLoaded] = useState(false);

  // Load dimensions
  useEffect(() => {
    if (!originalSrc) return;
    const img = new window.Image();
    img.onload = () => {
      setOriginalDims({ w: img.naturalWidth, h: img.naturalHeight });
      setOriginalLoaded(true);
    };
    img.src = originalSrc;
  }, [originalSrc]);

  useEffect(() => {
    if (!editedSrc) return;
    const img = new window.Image();
    img.onload = () => {
      setEditedDims({ w: img.naturalWidth, h: img.naturalHeight });
      setEditedLoaded(true);
    };
    img.src = editedSrc;
  }, [editedSrc]);

  const updatePosition = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setPosition(pct);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      setIsDragging(true);
      updatePosition(e.clientX);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [updatePosition],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      updatePosition(e.clientX);
    },
    [isDragging, updatePosition],
  );

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  function resLabel(dims: { w: number; h: number } | null) {
    if (!dims) return null;
    const max = Math.max(dims.w, dims.h);
    let label: string;
    let color: string;
    if (max >= 3840) {
      label = "4K";
      color = "bg-green-600";
    } else if (max >= 2560) {
      label = "2K";
      color = "bg-green-600";
    } else if (max >= 1920) {
      label = "FHD";
      color = "bg-blue-600";
    } else if (max >= 1280) {
      label = "HD";
      color = "bg-yellow-600";
    } else {
      label = "SD";
      color = "bg-red-600";
    }
    return { label, color, text: `${dims.w}×${dims.h} ${label}` };
  }

  const origBadge = resLabel(originalDims);
  const editBadge = resLabel(editedDims);

  // Use thumbnail while full image loads
  const displayEditedSrc =
    !editedLoaded && editedThumbSrc ? editedThumbSrc : editedSrc;

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden rounded-lg border select-none touch-none ${className}`}
      style={{
        aspectRatio: originalDims
          ? `${originalDims.w} / ${originalDims.h}`
          : "16 / 9",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Edited image (full width, behind) */}
      <div className="absolute inset-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={displayEditedSrc}
          alt="Edited"
          className="w-full h-full object-contain"
          draggable={false}
        />
        {/* Edited dimensions badge — bottom right */}
        {editBadge && (
          <div
            className={`absolute bottom-1.5 right-1.5 ${editBadge.color} text-white text-[9px] font-bold px-1.5 py-0.5 rounded leading-none z-20`}
          >
            {editBadge.text}
          </div>
        )}
        {/* "Edited" label — top right */}
        <div className="absolute top-2 right-2 bg-green-600/80 text-white text-[10px] font-semibold px-2 py-0.5 rounded z-20">
          AI Edited
        </div>
        {!editedLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white" />
          </div>
        )}
      </div>

      {/* Original image (clipped by slider position) */}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${position}%` }}
      >
        <div
          className="h-full"
          style={{
            width: containerRef.current
              ? `${containerRef.current.offsetWidth}px`
              : "100vw",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={originalSrc}
            alt="Original"
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>
        {/* Original dimensions badge — bottom right of the original clip area */}
        {origBadge && (
          <div
            className={`absolute bottom-1.5 right-1.5 ${origBadge.color} text-white text-[9px] font-bold px-1.5 py-0.5 rounded leading-none z-20`}
          >
            {origBadge.text}
          </div>
        )}
        {/* "Original" label — top left */}
        <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] font-semibold px-2 py-0.5 rounded z-20">
          Original
        </div>
        {!originalLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white" />
          </div>
        )}
      </div>

      {/* Slider divider line */}
      <div
        className="absolute top-0 bottom-0 z-30 pointer-events-none"
        style={{ left: `${position}%`, transform: "translateX(-50%)" }}
      >
        <div className="w-0.5 h-full bg-white shadow-lg" />
        {/* Slider handle */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white shadow-lg border-2 border-gray-300 flex items-center justify-center pointer-events-auto cursor-ew-resize">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className="text-gray-500"
          >
            <path
              d="M3 1L1 6L3 11M9 1L11 6L9 11"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
