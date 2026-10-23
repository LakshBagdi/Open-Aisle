/**
 * Demo catalog for two PayPal sandbox stores.
 *
 * Products are original demo items with drawn placeholder images (served by
 * the web app at /img/product/<sku>.svg). Some products deliberately miss
 * information (no photo description, no size chart, no material) so the
 * barrier report has real barriers to show.
 *
 * With CHANNEL3_API_KEY set, `pnpm --filter @open-aisle/core tsx scripts/import-channel3.ts`
 * replaces these with real products from Channel3.
 */

export type SeedProduct = {
  sku: string;
  category: "shoes" | "clothing" | "kitchen" | "home";
  title: string;
  brand: string;
  description: string;
  priceCents: number;
  attributes: Record<string, string>;
  options?: Record<string, string[]>;
  alt: string; // "" = missing photo description (a barrier)
  sizeChart?: string;
  returnPolicy?: string;
};

export type SeedStore = {
  slug: string;
  name: string;
  description: string;
  returnPolicy: string | null;
  taxRateBasisPoints: number;
  deliveryCents: number;
  freeDeliveryOverCents: number | null;
  deliveryDays: number;
  products: SeedProduct[];
};

const SHOE_SIZES = ["6", "7", "8", "9", "10", "11", "12"];
const SHOE_CHART = "US sizes by foot length: 7 = 24.5 cm, 8 = 25.5 cm, 9 = 26.5 cm, 10 = 27.5 cm, 11 = 28.5 cm, 12 = 29.5 cm.";
const TOP_SIZES = ["XS", "S", "M", "L", "XL"];
const TOP_CHART = "Chest: XS 84 cm, S 90 cm, M 98 cm, L 106 cm, XL 114 cm.";

export const SEED_STORES: SeedStore[] = [
  {
    slug: "northwind",
    name: "Northwind Outfitters",
    description: "Running, walking and everyday clothing.",
    returnPolicy: "Free returns within 30 days, unworn, with a prepaid label.",
    taxRateBasisPoints: 825,
    deliveryCents: 599,
    freeDeliveryOverCents: 5000,
    deliveryDays: 3,
    products: [
      {
        sku: "NW-TRAIL-RUNNER-2",
        category: "shoes",
        title: "Trail Runner 2",
        brand: "Northwind",
        description: "A cushioned running shoe for road and light trail.",
        priceCents: 5499,
        attributes: { material: "Recycled mesh upper, rubber sole", color: "Black with white sole", fit: "True to size, regular width", weight: "260 g per shoe", closure: "Laces" },
        options: { size: SHOE_SIZES },
        alt: "A black running shoe with a white sole and a small reflective strip on the heel, seen from the side.",
        sizeChart: SHOE_CHART,
      },
      {
        sku: "NW-CLOUD-WALK",
        category: "shoes",
        title: "Cloud Walk Slip-On",
        brand: "Northwind",
        description: "A slip-on walking shoe with no laces.",
        priceCents: 4299,
        attributes: { material: "Knit upper, foam sole", color: "Navy blue", fit: "Runs half a size small", closure: "Slip-on, elastic collar" },
        options: { size: SHOE_SIZES },
        alt: "A navy knit slip-on shoe with a thick white foam sole and a pull tab at the back.",
        sizeChart: SHOE_CHART,
      },
      {
        sku: "NW-ROAD-LITE",
        category: "shoes",
        title: "Road Lite Running Shoe",
        brand: "Northwind",
        description: "Lightweight shoe for faster runs.",
        priceCents: 6999,
        attributes: { color: "Grey", fit: "Narrow", weight: "220 g per shoe", closure: "Laces" },
        options: { size: SHOE_SIZES },
        alt: "",
      },
      {
        sku: "NW-GRIP-HIKER",
        category: "shoes",
        title: "Grip Hiker Waterproof Boot",
        brand: "Northwind",
        description: "Ankle-height hiking boot with a waterproof lining.",
        priceCents: 8999,
        attributes: { material: "Leather and nylon upper, waterproof membrane, rubber lug sole", color: "Brown", fit: "True to size, roomy toe", closure: "Laces with metal hooks" },
        options: { size: SHOE_SIZES },
        alt: "A brown ankle-high hiking boot with thick grippy treads and orange laces.",
      },
      {
        sku: "NW-ESSENTIAL-TEE",
        category: "clothing",
        title: "Essential Cotton T-Shirt",
        brand: "Northwind",
        description: "A plain crew-neck T-shirt.",
        priceCents: 1800,
        attributes: { material: "100% organic cotton", fit: "Regular fit", neckline: "Crew neck", care: "Machine wash cold" },
        options: { size: TOP_SIZES, color: ["White", "Black", "Heather grey"] },
        alt: "A plain short-sleeved crew-neck T-shirt laid flat.",
        sizeChart: TOP_CHART,
      },
      {
        sku: "NW-RAIN-SHELL",
        category: "clothing",
        title: "Packable Rain Jacket",
        brand: "Northwind",
        description: "A light rain jacket that folds into its own pocket.",
        priceCents: 4999,
        attributes: { material: "Recycled nylon with water-repellent coating", color: "Yellow", fit: "Relaxed", hood: "Adjustable hood", pockets: "Two zip hand pockets" },
        options: { size: TOP_SIZES },
        alt: "A bright yellow hooded rain jacket with a front zip and two zip pockets.",
        sizeChart: TOP_CHART,
      },
      {
        sku: "NW-WARM-FLEECE",
        category: "clothing",
        title: "Half-Zip Fleece",
        brand: "Northwind",
        description: "A soft fleece pullover with a short zip.",
        priceCents: 3999,
        attributes: { color: "Forest green", fit: "Regular fit" },
        options: { size: TOP_SIZES },
        alt: "",
      },
      {
        sku: "NW-RUN-SOCKS-3",
        category: "clothing",
        title: "Running Socks, 3 Pairs",
        brand: "Northwind",
        description: "Cushioned ankle socks.",
        priceCents: 1499,
        attributes: { material: "Cotton, polyester and elastane blend", color: "White", "pack size": "3 pairs" },
        options: { size: ["S (US 5-7)", "M (US 8-10)", "L (US 11-13)"] },
        alt: "Three pairs of white ankle socks with grey heels and toes.",
        sizeChart: "S fits US shoe 5-7, M fits 8-10, L fits 11-13.",
      },
    ],
  },
  {
    slug: "maple-home",
    name: "Maple & Home",
    description: "Kitchen and home basics.",
    returnPolicy: null,
    taxRateBasisPoints: 700,
    deliveryCents: 499,
    freeDeliveryOverCents: 3500,
    deliveryDays: 4,
    products: [
      {
        sku: "MH-STONE-MUG",
        category: "kitchen",
        title: "Stoneware Mug",
        brand: "Maple & Home",
        description: "A large mug with a wide handle that's easy to grip.",
        priceCents: 1499,
        attributes: { material: "Stoneware", capacity: "350 ml", color: "Speckled cream", "dishwasher safe": "Yes", "microwave safe": "Yes" },
        alt: "A cream mug with brown speckles and a large round handle.",
        returnPolicy: "Returns within 14 days if unused.",
      },
      {
        sku: "MH-TALKING-SCALE",
        category: "kitchen",
        title: "Talking Kitchen Scale",
        brand: "Maple & Home",
        description: "A kitchen scale that speaks the weight aloud.",
        priceCents: 3499,
        attributes: { capacity: "Up to 5 kg", voice: "Speaks weight in grams or ounces", buttons: "Two large tactile buttons with raised dots", power: "2 AAA batteries, included" },
        alt: "A flat white kitchen scale with a speaker grille and two large buttons with raised dots.",
        returnPolicy: "Returns within 30 days.",
      },
      {
        sku: "MH-LEVEL-ALERT",
        category: "kitchen",
        title: "Liquid Level Indicator",
        brand: "Maple & Home",
        description: "Clips on a cup and beeps when the liquid is near the top.",
        priceCents: 999,
        attributes: { material: "Plastic with metal prongs", alert: "Beeps and vibrates", power: "Coin battery, included" },
        alt: "A small plastic clip with two metal prongs that hooks over the rim of a cup.",
        returnPolicy: "Returns within 30 days.",
      },
      {
        sku: "MH-CHEF-KNIFE",
        category: "kitchen",
        title: "Chef's Knife with Finger Guard",
        brand: "Maple & Home",
        description: "An 8-inch chef's knife sold with a clip-on finger guard.",
        priceCents: 2999,
        attributes: { material: "Stainless steel blade, rubber handle", "blade length": "20 cm", extras: "Finger guard and blade cover included" },
        alt: "",
      },
      {
        sku: "MH-NONSTICK-PAN",
        category: "kitchen",
        title: "Non-Stick Frying Pan",
        brand: "Maple & Home",
        description: "A 28 cm frying pan with a cool-touch handle.",
        priceCents: 3299,
        attributes: { material: "Aluminium with ceramic non-stick coating", size: "28 cm", "induction ready": "Yes", "oven safe": "Up to 200 °C" },
        alt: "A round grey frying pan with a long black handle.",
      },
      {
        sku: "MH-WEIGHTED-BLANKET",
        category: "home",
        title: "Weighted Blanket",
        brand: "Maple & Home",
        description: "A calming weighted blanket.",
        priceCents: 6999,
        attributes: { material: "Cotton cover, glass bead filling", weight: "7 kg", size: "150 x 200 cm", care: "Cover is machine washable" },
        alt: "A folded grey quilted blanket with small square stitching.",
      },
      {
        sku: "MH-BIG-BUTTON-CLOCK",
        category: "home",
        title: "Talking Alarm Clock",
        brand: "Maple & Home",
        description: "Speaks the time when you press the top button.",
        priceCents: 2499,
        attributes: { voice: "Speaks time and alarm in English or Hindi", display: "Large high-contrast digits", power: "Mains with battery backup" },
        alt: "A square black clock with large white digits and one big button on top.",
      },
    ],
  },
];
