"use client";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Shop" },
  { href: "/orders", label: "My orders" },
  { href: "/settings", label: "Settings" },
  { href: "/merchant", label: "For stores" },
];

/** aria-current tells screen readers which page you're on. */
export function NavLinks() {
  const path = usePathname();
  return (
    <ul>
      {LINKS.map((l) => {
        const current = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <li key={l.href}>
            <a href={l.href} aria-current={current ? "page" : undefined}>
              {l.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
