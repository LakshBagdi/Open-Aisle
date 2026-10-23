"use client";
/**
 * The "For stores" section has four pages. This is their local navigation:
 * plain links with aria-current, so screen readers say "current page".
 */
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/merchant", label: "Barrier report" },
  { href: "/merchant/board", label: "Fix board" },
  { href: "/merchant/insights", label: "Insights" },
  { href: "/merchant/developers", label: "Merchant API" },
];

export function MerchantNav() {
  const path = usePathname();
  return (
    <nav aria-label="For stores" className="subnav">
      <ul>
        {LINKS.map((l) => (
          <li key={l.href}>
            <a href={l.href} aria-current={path === l.href ? "page" : undefined}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
