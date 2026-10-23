/**
 * Money helpers. Inside Open Aisle money is integer cents.
 * PayPal's API wants strings like "54.99". These two functions are the only
 * place we convert, so a rounding bug can only live in one spot.
 */

export function centsToPayPal(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Bad cents value: ${cents}`);
  return (cents / 100).toFixed(2);
}

export function payPalToCents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`Bad PayPal amount: ${value}`);
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** "$54.99" — the way it is spoken and shown to the person. */
export function formatMoney(cents: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}
