import os
import sys
import warnings
warnings.filterwarnings("ignore")
os.environ["LOKY_MAX_CPU_COUNT"] = "4"
os.environ["PYTHONWARNINGS"] = "ignore"

import json
from datetime import datetime, timedelta
import numpy as np
import pandas as pd
import joblib

BASE_DIR = os.path.dirname(__file__)
MODELS_DIR = os.path.join(BASE_DIR, "models")

CLF_PATH = os.path.join(MODELS_DIR, "delay_classifier.joblib")
REG_PATH = os.path.join(MODELS_DIR, "duration_regressor.joblib")
PREP_PATH = os.path.join(MODELS_DIR, "preprocessor.joblib")
METRICS_PATH = os.path.join(MODELS_DIR, "model_metrics.json")

# Global cache for fast inference
_clf = None
_reg = None
_prep = None
_metrics = None

def load_models():
    global _clf, _reg, _prep, _metrics
    if _clf is None and os.path.exists(CLF_PATH):
        try:
            _clf = joblib.load(CLF_PATH)
            _reg = joblib.load(REG_PATH)
            _prep = joblib.load(PREP_PATH)
            if os.path.exists(METRICS_PATH):
                with open(METRICS_PATH, "r") as f:
                    _metrics = json.load(f)
        except Exception as e:
            sys.stderr.write(f"Error loading models: {e}\n")
    return _clf, _reg, _prep, _metrics

def build_contributing_factors(data):
    factors = []
    
    # 1. Blocked milestone
    if data.get("has_blocked_milestone"):
        factors.append("A project milestone is currently blocked by an unresolved dependency.")
    
    # 2. Resource shortage & supplier lead time
    shortage = data.get("resource_shortage_count", 0)
    lead_time = data.get("max_supplier_lead_time_days", 0)
    rem_deadline = data.get("remaining_days_to_deadline", 7)
    if shortage > 0 and lead_time > 0:
        if lead_time > rem_deadline:
            factors.append(f"Supplier replenishment takes ~{lead_time} days, which exceeds the {rem_deadline} days remaining until deadline.")
        else:
            factors.append(f"Material inventory shortage detected requiring a {lead_time}-day supplier reorder window.")
    
    # 3. Workload capacity
    util = data.get("workload_utilization_ratio", 1.0)
    act = data.get("active_projects_count", 1)
    cap = data.get("capacity_limit", 5)
    if util > 1.2:
        factors.append(f"Workspace is operating above limit ({act}/{cap} active projects, {int(util*100)}% utilization).")
    elif util > 0.9:
        factors.append(f"Workspace is near full capacity ({act}/{cap} active projects).")
        
    # 4. Equipment overload
    equip = data.get("machine_overload_ratio", 1.0)
    if equip > 1.2:
        factors.append("Equipment is overbooked across simultaneous active jobs.")
        
    # 5. Client approval
    if data.get("client_approval_pending"):
        factors.append("Waiting for client feedback and asset approval.")
        
    # 6. Staff availability
    staff = data.get("staff_available_pct", 1.0)
    if staff < 0.8:
        factors.append(f"Staff availability is reduced to {int(staff*100)}% of standard team hours.")
        
    # 7. Progress vs deadline
    progress = data.get("progress_pct", 0)
    if rem_deadline <= 2 and progress < 70:
        factors.append(f"Deadline is in {max(0, rem_deadline)} days, but only {progress}% of milestones are complete.")
        
    if not factors:
        factors.append("Operations and milestone progress are progressing within planned capacity.")
        
    return factors

def fallback_prediction(data):
    # Safe rule-based estimate if ML model is unavailable
    rem_ms = data.get("remaining_milestones", 2)
    tot_ms = max(1, data.get("total_milestones", 4))
    init_days = data.get("initial_estimated_days", 7)
    rem_deadline = data.get("remaining_days_to_deadline", 5)
    lead = data.get("max_supplier_lead_time_days", 0)
    has_blocked = bool(data.get("has_blocked_milestone"))
    
    base_rem = max(1.0, (rem_ms / tot_ms) * init_days)
    if has_blocked:
        base_rem += 3.0
    if lead > 0:
        base_rem += lead * 0.7
        
    prob = 0.20
    if has_blocked: prob += 0.40
    if lead > rem_deadline: prob += 0.30
    if data.get("workload_utilization_ratio", 1.0) > 1.2: prob += 0.25
    prob = min(0.99, max(0.05, prob))
    
    level = "Critical" if prob >= 0.80 else "High" if prob >= 0.60 else "Medium" if prob >= 0.30 else "Low"
    expected_delay = max(0.0, round(base_rem - max(0, rem_deadline), 1))
    
    now = datetime.now()
    comp_date = (now + timedelta(days=float(base_rem))).strftime("%Y-%m-%d")
    
    return {
        "is_fallback": True,
        "delay_probability": round(prob, 3),
        "delay_percentage": int(round(prob * 100)),
        "risk_level": level,
        "likelihood_text": f"{level} risk of delay ({int(round(prob * 100))}% likelihood)",
        "estimated_remaining_days": round(base_rem, 1),
        "expected_completion_date": comp_date,
        "expected_delay_days": expected_delay,
        "confidence_range_days": [round(max(0.5, base_rem - 2.0), 1), round(base_rem + 2.5, 1)],
        "contributing_factors": build_contributing_factors(data),
        "model_used": "PayPilot-RuleBased-Fallback"
    }

def predict_single(data):
    clf, reg, prep, metrics = load_models()
    if clf is None or reg is None or prep is None:
        return fallback_prediction(data)
        
    try:
        feature_cols = [
            "category", "complexity_score", "total_milestones", "remaining_milestones",
            "progress_pct", "initial_estimated_days", "elapsed_days", "remaining_days_to_deadline",
            "active_projects_count", "capacity_limit", "workload_utilization_ratio",
            "staff_available_pct", "resource_shortage_count", "max_supplier_lead_time_days",
            "machine_overload_ratio", "has_blocked_milestone", "client_approval_pending",
            "historical_delay_rate"
        ]
        
        row = {}
        for col in feature_cols:
            val = data.get(col)
            if col == "category":
                row[col] = str(val or "Printing & Custom Merchandise")
            elif col in ["complexity_score", "total_milestones", "remaining_milestones", 
                         "progress_pct", "initial_estimated_days", "elapsed_days", 
                         "remaining_days_to_deadline", "active_projects_count", 
                         "capacity_limit", "resource_shortage_count", 
                         "max_supplier_lead_time_days", "has_blocked_milestone", 
                         "client_approval_pending"]:
                row[col] = int(val or 0)
            else:
                row[col] = float(val or 0.0)
                
        df_in = pd.DataFrame([row])
        X_t = prep.transform(df_in)
        
        # Classifier prediction
        prob = float(clf.predict_proba(X_t)[0, 1]) if hasattr(clf, "predict_proba") else float(clf.predict(X_t)[0])
        prob = min(0.99, max(0.01, prob))
        
        level = "Critical" if prob >= 0.80 else "High" if prob >= 0.60 else "Medium" if prob >= 0.30 else "Low"
        
        # Regressor prediction
        rem_days = float(reg.predict(X_t)[0])
        rem_days = max(0.5, round(rem_days, 1))
        
        # Uncertainty interval
        res_std = 2.0
        if metrics and "model_b_regression" in metrics and "residual_std" in metrics["model_b_regression"]:
            res_std = float(metrics["model_b_regression"]["residual_std"])
        ci_half = round(1.645 * res_std, 1) # 90% confidence interval
        low_bound = max(0.5, round(rem_days - ci_half, 1))
        high_bound = round(rem_days + ci_half, 1)
        
        rem_deadline = float(data.get("remaining_days_to_deadline", 7))
        exp_delay = round(max(0.0, rem_days - max(0.0, rem_deadline)), 1)
        
        now = datetime.now()
        comp_date = (now + timedelta(days=rem_days)).strftime("%Y-%m-%d")
        
        clf_name = metrics["model_a_classification"].get("selected_best", "Classifier") if metrics else "Classifier"
        reg_name = metrics["model_b_regression"].get("selected_best", "Regressor") if metrics else "Regressor"
        
        return {
            "is_fallback": False,
            "delay_probability": round(prob, 3),
            "delay_percentage": int(round(prob * 100)),
            "risk_level": level,
            "likelihood_text": f"{level} risk of delay ({int(round(prob * 100))}% probability)",
            "estimated_remaining_days": rem_days,
            "expected_completion_date": comp_date,
            "expected_delay_days": exp_delay,
            "confidence_range_days": [low_bound, high_bound],
            "contributing_factors": build_contributing_factors(data),
            "model_used": f"{clf_name} + {reg_name}",
            "version": "PayPilot-ML-3.0"
        }
    except Exception as e:
        sys.stderr.write(f"Inference error: {e}\n")
        return fallback_prediction(data)

def main():
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg == "--info":
            _, _, _, metrics = load_models()
            print(json.dumps(metrics or {}, indent=2))
            return
        try:
            data = json.loads(arg)
            res = predict_single(data)
            print(json.dumps(res))
            return
        except Exception as e:
            sys.stderr.write(f"Arg parse error: {e}\n")
            
    # Read from stdin
    input_str = sys.stdin.read().strip()
    if input_str:
        try:
            data = json.loads(input_str)
            if isinstance(data, list):
                res = [predict_single(item) for item in data]
            else:
                res = predict_single(data)
            print(json.dumps(res))
        except Exception as e:
            sys.stderr.write(f"Stdin JSON error: {e}\n")
            print(json.dumps(fallback_prediction({})))
    else:
        print(json.dumps({"error": "No input provided"}))

if __name__ == "__main__":
    main()
