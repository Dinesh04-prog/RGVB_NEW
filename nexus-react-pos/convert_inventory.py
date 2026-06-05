import openpyxl, json, sys

INPUT  = "Book1.xlsx"
OUTPUT = "public/inventory.json"

def clean(s):
    return str(s).strip() if s is not None else ""

def make_search_key(marathi, english):
    parts = []
    for s in [english, marathi]:
        if s:
            parts.append(s.strip().lower()[:4])
    return " ".join(parts)

wb = openpyxl.load_workbook(INPUT, read_only=True, data_only=True)
ws = wb.active
rows = list(ws.iter_rows(min_row=2, values_only=True))

# Column layout: SKU_ID | Item_Name | Marathi_Name | English_Name | Weight_Volume | Selling_Price_INR | Purchase_Price_INR | Stock_Quantity
items = []
for idx, row in enumerate(rows):
    marathi  = clean(row[2])
    english  = clean(row[3])
    unit     = clean(row[4]) or "kg"
    price    = float(row[5]) if row[5] is not None else 0
    purchase = float(row[6]) if row[6] is not None else 0
    stock    = int(row[7])   if row[7] is not None else 0
    sku      = clean(row[0]) or f"GVB-{str(idx+1).zfill(3)}"

    if not marathi and not english:
        continue

    items.append({
        "id":             sku,
        "name":           marathi or english,
        "name_marathi":   marathi,
        "name_eng":       english,
        "brand":          "",
        "search_key":     make_search_key(marathi, english),
        "unit":           unit,
        "price":          price,
        "purchase_price": purchase,
        "stock_quantity": stock,
        "stock_qty":      stock,
        "barcode":        "",
    })

with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(items, f, ensure_ascii=False, separators=(",", ":"))

print(f"Done: {len(items)} items → {OUTPUT}", file=sys.stderr)
