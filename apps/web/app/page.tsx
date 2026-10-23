import { getAccountStatus, getUser } from "@open-aisle/core/account";
import { Companion } from "@/components/Companion";
import { currentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ShopPage() {
  const userId = await currentUserId();
  const [user, status] = await Promise.all([getUser(userId), getAccountStatus(userId)]);
  if (!user) {
    return (
      <>
        <h1>Open Aisle isn't set up yet</h1>
        <p>Run <code>pnpm db:migrate</code> and <code>pnpm db:seed</code>, then reload this page.</p>
      </>
    );
  }
  return <Companion name={user.displayName} lang={user.language} modes={user.modes} paypalConnected={status.paypalConnected} />;
}
