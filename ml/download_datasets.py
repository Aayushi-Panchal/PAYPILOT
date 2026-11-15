import os
import json
import zipfile
import io
import requests
import pandas as pd

RAW_DIR = os.path.join(os.path.dirname(__file__), "data", "raw")
os.makedirs(RAW_DIR, exist_ok=True)

registry = {}
headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PayPilot/3.0"}

session = requests.Session()
session.headers.update(headers)

# 1. Bread Basket Bakery Dataset
dest_bread = os.path.join(RAW_DIR, "bread_basket.csv")
if not os.path.exists(dest_bread):
    print("Downloading 1. Bread Basket Bakery Dataset...")
    try:
        url_bread = "https://raw.githubusercontent.com/prasertcbs/basic-dataset/master/BreadBasket_DMS.csv"
        r = session.get(url_bread, timeout=15)
        if r.status_code == 200:
            with open(dest_bread, "wb") as f:
                f.write(r.content)
            print(" -> Saved bread_basket.csv")
    except Exception as e:
        print("Failed bread basket:", e)

if os.path.exists(dest_bread):
    df_bread = pd.read_csv(dest_bread)
    registry["bread_basket"] = {
        "name": "The Bread Basket Bakery Transaction & Production Dataset",
        "source_url": "https://github.com/prasertcbs/basic-dataset/blob/master/BreadBasket_DMS.csv",
        "license": "CC0: Public Domain",
        "category": "Bakery & Food Businesses",
        "raw_records": len(df_bread),
        "columns": list(df_bread.columns),
        "description": "21,293 real customer transactions from The Bread Basket bakery in Edinburgh, UK, documenting bakery orders, item varieties, batch orders, and production timestamps."
    }
    print(f"Loaded {len(df_bread)} bakery records.")

# 2. Software Effort Benchmarks (Desharnais, COCOMO-81, Pomodoro Tasks)
for name, filename, url in [
    ("desharnais_software", "desharnais_software.csv", "https://raw.githubusercontent.com/Derek-Jones/Software-estimation-datasets/master/Desharnais.csv"),
    ("cocomo_software", "cocomo_software.csv", "https://raw.githubusercontent.com/Derek-Jones/Software-estimation-datasets/master/COCOMO-81.csv"),
    ("renzo_tasks", "renzo_tasks.csv", "https://raw.githubusercontent.com/Derek-Jones/Software-estimation-datasets/master/renzo-pomodoro.csv")
]:
    dest = os.path.join(RAW_DIR, filename)
    if not os.path.exists(dest):
        print(f"Downloading {name}...")
        try:
            r = session.get(url, timeout=15)
            if r.status_code == 200:
                with open(dest, "wb") as f:
                    f.write(r.content)
                print(f" -> Saved {filename}")
        except Exception as e:
            print(f"Failed {name}:", e)

if os.path.exists(os.path.join(RAW_DIR, "desharnais_software.csv")):
    df_d = pd.read_csv(os.path.join(RAW_DIR, "desharnais_software.csv"))
    df_c = pd.read_csv(os.path.join(RAW_DIR, "cocomo_software.csv"))
    df_r = pd.read_csv(os.path.join(RAW_DIR, "renzo_tasks.csv"))
    registry["software_effort_benchmarks"] = {
        "name": "PROMISE Software Engineering Effort & Task Duration Repository (Desharnais, COCOMO-81, Pomodoro Tasks)",
        "source_url": "https://github.com/Derek-Jones/Software-estimation-datasets",
        "license": "Open Academic Research / Creative Commons",
        "category": "Software Development & Design Agencies",
        "raw_records": len(df_d) + len(df_c) + len(df_r),
        "breakdown": {
            "desharnais_projects": len(df_d),
            "cocomo81_projects": len(df_c),
            "pomodoro_tasks": len(df_r)
        },
        "description": "Standard software engineering empirical datasets recording project complexity, lines of code/function points, team experience, estimated effort, and actual person-hours and duration."
    }
    print(f"Loaded {len(df_d)} Desharnais, {len(df_c)} COCOMO-81, {len(df_r)} Pomodoro tasks.")

# 3. DataCo Supply Chain Sample (Streaming first 10,000 real rows)
dest_dataco = os.path.join(RAW_DIR, "dataco_supply_chain.csv")
if not os.path.exists(dest_dataco):
    print("Streaming 3. DataCo Supply Chain Dataset sample...")
    try:
        url_dataco = "https://raw.githubusercontent.com/bengtsoderlund/late-shipment-prediction-ml/main/data/raw/shipments_raw.csv"
        r = session.get(url_dataco, stream=True, timeout=20)
        with open(dest_dataco, "wb") as f:
            lines = 0
            for line in r.iter_lines(delimiter=b"\n"):
                if line:
                    f.write(line + b"\n")
                    lines += 1
                    if lines >= 10000:
                        break
        print(f" -> Saved {lines} lines to dataco_supply_chain.csv")
    except Exception as e:
        print("Failed dataco stream:", e)

if os.path.exists(dest_dataco):
    df_dataco = pd.read_csv(dest_dataco, encoding="latin-1")
    registry["dataco_supply_chain"] = {
        "name": "DataCo Global Smart Supply Chain & Delivery Risk Dataset",
        "source_url": "https://github.com/bengtsoderlund/late-shipment-prediction-ml / Kaggle DataCo Smart Supply Chain",
        "license": "CC BY-NC-SA 4.0",
        "category": "Printing & Custom Merchandise / Supply Chain",
        "raw_records": len(df_dataco),
        "columns": [c for c in df_dataco.columns if "Days" in c or "Late" in c or "Status" in c or "Order" in c][:15],
        "description": "Real-world supply chain and order fulfillment dataset with scheduled delivery days, real days to fulfillment, delivery status, and ground-truth Late_delivery_risk labels."
    }
    print(f"Loaded {len(df_dataco)} supply chain records.")

# 4. UCI AI4I Manufacturing Dataset
dest_uci = os.path.join(RAW_DIR, "ai4i_manufacturing.csv")
if not os.path.exists(dest_uci):
    print("Downloading 4. UCI AI4I Manufacturing Dataset...")
    try:
        url_uci = "https://archive.ics.uci.edu/static/public/601/ai4i+2020+predictive+maintenance+dataset.zip"
        r = session.get(url_uci, timeout=20, verify=False)
        if r.status_code == 200:
            with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                for fn in z.namelist():
                    if fn.endswith(".csv"):
                        with open(dest_uci, "wb") as f:
                            f.write(z.read(fn))
                        break
            print(" -> Saved ai4i_manufacturing.csv")
    except Exception as e:
        print("UCI download exception:", e)

if os.path.exists(dest_uci):
    df_uci = pd.read_csv(dest_uci)
    registry["ai4i_manufacturing"] = {
        "name": "UCI AI4I 2020 Predictive Maintenance & Production Dataset",
        "source_url": "https://archive.ics.uci.edu/dataset/601/ai4i+2020+predictive+maintenance+dataset",
        "license": "Creative Commons Attribution 4.0 International (CC BY 4.0)",
        "category": "Printing & Custom Merchandise / Equipment Intelligence",
        "raw_records": len(df_uci),
        "columns": list(df_uci.columns),
        "description": "10,000 real production machine runs capturing operational parameters, process temperatures, rotational tool speeds, tool wear in minutes, and failure modes."
    }
    print(f"Loaded {len(df_uci)} manufacturing records.")

# Save dataset registry
reg_path = os.path.join(os.path.dirname(__file__), "data", "dataset_registry.json")
with open(reg_path, "w", encoding="utf-8") as f:
    json.dump(registry, f, indent=2)

print("\nRegistry successfully saved to", reg_path)
