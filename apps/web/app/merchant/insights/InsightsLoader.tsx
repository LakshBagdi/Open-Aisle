"use client";
/** AG Studio runs its data engine in the browser, so the dashboard loads only there. */
import dynamic from "next/dynamic";

const InsightsStudio = dynamic(() => import("@/components/insights/InsightsStudio"), {
  ssr: false,
  loading: () => <p role="status">Loading the dashboard…</p>,
});

export function InsightsLoader() {
  return <InsightsStudio />;
}
