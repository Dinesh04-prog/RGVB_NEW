// Cart unit conversion shared by the cashier bill (App.tsx) and the owner's bill review (OwnerApp.tsx).
// A cart line's total is qty × rate × multiplier, where rate is per the item's base unit.

export const getUnitMultiplier = (targetUnit: string, baseUnit: string) => {
  const t = targetUnit.trim().toLowerCase();
  const b = baseUnit.trim().toLowerCase();
  if (t === b) return 1;

  const isKg = (u: string) => /^(kg|kilo|kilograms?|kilos?)$/.test(u);
  const isG = (u: string) => /^(g|gm|grams?)$/.test(u);
  const isL = (u: string) => /^(l|lit|liters?|litres?)$/.test(u);
  const isMl = (u: string) => /^(ml|mili|mililiters?|milliliters?|mal)$/.test(u);
  const isPcs = (u: string) => /^(pc|pcs|pieces?|units?|nos?|numbers?|pack|packet|box)$/.test(u);
  const isDozen = (u: string) => /^(dz|dozens?|dzn)$/.test(u);

  if (isG(t) && isKg(b)) return 1 / 1000;
  if (isKg(t) && isG(b)) return 1000;
  if (isMl(t) && isL(b)) return 1 / 1000;
  if (isL(t) && isMl(b)) return 1000;
  if (isDozen(t) && isPcs(b)) return 12;
  if (isPcs(t) && isDozen(b)) return 1 / 12;

  return 1;
};

/** Units offered in the bill popups after the item's own unit and its custom unit rates. */
export const STANDARD_UNITS = ['g', 'kg', 'l', 'box', 'mal', 'ml', 'dozen', 'pcs', 'bag', 'packet'];
