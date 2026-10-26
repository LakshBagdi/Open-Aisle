import { getAccountStatus, getUser } from "@open-aisle/core/account";
import { Companion } from "@/components/Companion";
import { currentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ShopPage({ searchParams }: { searchParams: Promise<{ paypal?: string }> }) {
  const userId = await currentUserId();
  const [user, status] = await Promise.all([getUser(userId), getAccountStatus(userId)]);
  if (!user) {
    return (
      <>
        <h1>Open Aisle isn't set up yet</h1>
        <p>
          Run <code>pnpm demo</code> (or <code>pnpm db:setup</code>), then reload this page.
        </p>
      </>
    );
  }
  const paypal = (await searchParams).paypal;
  const paypalNote = paypal === "connected" || paypal === "cancelled" || paypal === "failed" ? paypal : undefined;
  return <Companion name={user.displayName} lang={user.language} modes={user.modes} paypalConnected={status.paypalConnected} paypalNote={paypalNote} />;
}
