import urllib.request
import os

candidates = [
    ("Bread Basket Bakery (Edinburgh, UK)", "https://raw.githubusercontent.com/vikasm/The-Bread-Basket/master/bread%20basket.csv"),
    ("Bread Basket Bakery Alternative", "https://raw.githubusercontent.com/adriaanvdh/bread-basket/master/bread_basket.csv"),
    ("UCI AI4I Predictive Maintenance & Manufacturing", "https://archive.ics.uci.edu/static/public/601/ai4i+2020+predictive+maintenance+dataset.zip"),
    ("Supply Chain / Delivery Dataset (DataCo mirror)", "https://raw.githubusercontent.com/shashwat-singh-07/Supply-Chain-Analytics/master/DataCoSupplyChainDataset.csv"),
    ("Software Jira Task Durations (Apache)", "https://raw.githubusercontent.com/smr-mun/Jira-Story-Points/master/dataset.csv"),
    ("Software Jira (Tawosi Empirical MSR)", "https://raw.githubusercontent.com/Vali-M/Jira-Dataset/master/data/raw/all_issues.csv"),
    ("Design / Freelance Projects Benchmark", "https://raw.githubusercontent.com/datasets/gdp/master/data/gdp.csv")
]

for name, url in candidates:
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as r:
            length = r.headers.get("Content-Length", "unknown")
            print(f"[FOUND] {name}: {r.status} (Length: {length})")
    except Exception as e:
        print(f"[NOT FOUND] {name}: {e}")

