import type { Metadata } from "next";
import { SettingsForm } from "@/components/SettingsForm";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const MESSAGES: Record<string, { text: string; error?: boolean }> = {
  connected: { text: "PayPal is connected. From now on I'll only pay after you confirm the exact order." },
  cancelled: { text: "PayPal wasn't connected. You can try again any time.", error: true },
  failed: { text: "PayPal couldn't be connected. Nothing was charged. Please try again.", error: true },
  missing: { text: "PayPal didn't send the approval back. Please try again.", error: true },
};

export default async function SettingsPage(props: { searchParams: Promise<{ paypal?: string }> }) {
  const { paypal } = await props.searchParams;
  const msg = paypal ? MESSAGES[paypal] : undefined;
  return (
    <>
      <div className="page-intro">
        <h1>Settings</h1>
        <p>Choose how Open Aisle talks with you, set your spending limits, and connect PayPal. A trusted helper can do this with you.</p>
      </div>
      {msg && (
        <p className={`notice${msg.error ? " notice--error" : ""}`} role={msg.error ? "alert" : "status"}>
          {msg.text}
        </p>
      )}
      <SettingsForm />
    </>
  );
}
