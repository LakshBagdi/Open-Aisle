"use client";
/** Bryntum works with the browser's DOM, so the board loads only in the browser. */
import dynamic from "next/dynamic";

const FixBoard = dynamic(() => import("@/components/FixBoard"), {
  ssr: false,
  loading: () => <p role="status">Loading the fix board…</p>,
});

export function FixBoardLoader() {
  return <FixBoard />;
}
