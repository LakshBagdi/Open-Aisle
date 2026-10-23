import type { Metadata } from "next";
import { FixBoardLoader } from "./FixBoardLoader";

export const metadata: Metadata = { title: "Fix board" };

export default function BoardPage() {
  return (
    <>
      <div className="page-intro">
        <h1>Fix board</h1>
        <p>
          Every barrier your shoppers hit, as a card. Plan the work: drag what you're working on to Being fixed. A card reaches Fixed only when you write the real
          information, and from that moment every Open Aisle shopper hears it.
        </p>
      </div>
      <FixBoardLoader />
    </>
  );
}
