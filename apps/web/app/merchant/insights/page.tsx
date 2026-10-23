import type { Metadata } from "next";
import { InsightsLoader } from "./InsightsLoader";

export const metadata: Metadata = { title: "Insights" };

export default function InsightsPage() {
  return (
    <>
      <div className="page-intro">
        <h1>Insights</h1>
        <p>
          What accessibility is worth to your store: sales paid through PayPal, orders shoppers cancelled before they were charged (mistakes that never became a
          refund or a dispute), and which missing information costs you the most. Ask the assistant a question and it builds the chart.
        </p>
      </div>
      <InsightsLoader />
    </>
  );
}
