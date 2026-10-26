import type { Metadata, Viewport } from "next";
import { getUser } from "@open-aisle/core/account";
import { NavLinks } from "./NavLinks";
import { currentUserId } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Open Aisle", template: "%s · Open Aisle" },
  description: "An AI shopping companion for people the web leaves out. Shopping, open to everyone.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The person's settings shape the whole page: language, text size.
  const user = await getUser(await currentUserId()).catch(() => undefined);
  const lang = user?.language ?? "en";
  return (
    <html lang={lang === "hi" ? "hi" : "en"} data-large-text={user?.modes.largeText ? "true" : "false"}>
      <body>
        <a className="skip-link" href="#main">
          {lang === "hi" ? "मुख्य हिस्से पर जाएँ" : "Skip to main content"}
        </a>
        <header className="site-header">
          <div className="site-header__inner">
            <a className="brand" href="/">
              <span className="brand__mark" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </span>
              Open Aisle
            </a>
            <nav className="site-nav" aria-label={lang === "hi" ? "मुख्य" : "Main"}>
              <NavLinks lang={lang} />
            </nav>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <footer className="site-footer">
          <p>Open Aisle pays only through PayPal, only after you confirm the exact order, and you can cancel during the undo window. Open source under the MIT licence.</p>
        </footer>
      </body>
    </html>
  );
}
