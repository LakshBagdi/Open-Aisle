import type { Metadata } from "next";
import { BarrierReport } from "@/components/BarrierReport";

export const metadata: Metadata = { title: "For stores" };

export default function MerchantPage() {
  return (
    <>
      <div className="page-intro">
        <h1>Barrier report</h1>
        <p>
          Every time a shopper using Open Aisle needs information your store didn't give, it's counted here. The most-hit barriers are at the top. Fix one and every shopper hears the fix from then on.
        </p>
      </div>
      <BarrierReport />
    </>
  );
}
