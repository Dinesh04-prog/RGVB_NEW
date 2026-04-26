import openpyxl, json, re, sys

INPUT  = "inventory_data.xlsx"
OUTPUT = "public/inventory.json"

def extract_unit(english_name):
    if not english_name:
        return "unit"
    m = re.search(r'\(([\d\.]+\s*(?:kg|g|gm|l|L|ml|ML|pcs?|pc|pack|box|nos?|litre|liter|dz|dozen))\)', str(english_name), re.IGNORECASE)
    if m:
        raw = m.group(1).strip()
        num_part = re.match(r'[\d\.]+', raw)
        unit_part = re.sub(r'[\d\.\s]+', '', raw).strip().lower()
        if num_part and float(num_part.group()) != 1:
            return raw
        return unit_part
    return "unit"

def make_search_key(marathi, english, brand):
    parts = []
    for s in [marathi, english, brand]:
        if s:
            parts.append(str(s).strip().lower()[:3])
    return "".join(parts)

wb = openpyxl.load_workbook(INPUT, read_only=True)
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
print(f"Headers: {rows[0]}", file=sys.stderr)

items = []
for row in rows[1:]:
    sku          = str(row[0]).strip() if row[0] else ""
    english_name = str(row[1]).strip() if row[1] else ""
    marathi_name = str(row[2]).strip() if row[2] else ""
    brand        = str(row[3]).strip() if row[3] else ""
    mrp          = float(row[4]) if row[4] is not None else 0
    selling      = float(row[5]) if row[5] is not None else 0
    stock        = int(row[6])   if row[6] is not None else 0

    if not sku:
        continue

    items.append({
        "id":             sku,
        "name":           marathi_name or english_name,
        "name_marathi":   marathi_name,
        "name_eng":       english_name,
        "brand":          brand,
        "search_key":     make_search_key(marathi_name, english_name, brand),
        "unit":           extract_unit(english_name),
        "price":          selling,
        "purchase_price": mrp,
        "stock_quantity": stock,
        "stock_qty":      stock,
    })

with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(items, f, ensure_ascii=False, separators=(",", ":"))

print(f"Done: {len(items)} items → {OUTPUT}", file=sys.stderr)
