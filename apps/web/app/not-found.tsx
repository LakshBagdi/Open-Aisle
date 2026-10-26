import type { Metadata } from "next";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="page-intro">
      <h1>This page isn&apos;t here</h1>
      <p>The link may be old, or there may be a typo in the address.</p>
      <p className="btn-row">
        <a className="btn btn--primary" href="/">
          Go to the Shop
        </a>
        <a className="btn" href="/orders">
          My orders
        </a>
      </p>
    </div>
  );
}
