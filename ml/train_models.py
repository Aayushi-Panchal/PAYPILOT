import os
import json
import joblib
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.dummy import DummyClassifier, DummyRegressor
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor, HistGradientBoostingClassifier, HistGradientBoostingRegressor
import lightgbm as lgb
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, f1_score, roc_auc_score, confusion_matrix,
    mean_absolute_error, mean_squared_error, r2_score
)

BASE_DIR = os.path.dirname(__file__)
DATA_PATH = os.path.join(BASE_DIR, "data", "processed", "paypilot_ml_dataset.csv")
MODELS_DIR = os.path.join(BASE_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)

df = pd.read_csv(DATA_PATH)
print(f"Loaded dataset with {len(df)} samples.")

feature_cols = [
    "category",
    "complexity_score",
    "total_milestones",
    "remaining_milestones",
    "progress_pct",
    "initial_estimated_days",
    "elapsed_days",
    "remaining_days_to_deadline",
    "active_projects_count",
    "capacity_limit",
    "workload_utilization_ratio",
    "staff_available_pct",
    "resource_shortage_count",
    "max_supplier_lead_time_days",
    "machine_overload_ratio",
    "has_blocked_milestone",
    "client_approval_pending",
    "historical_delay_rate"
]

cat_cols = ["category"]
num_cols = [c for c in feature_cols if c not in cat_cols]

X = df[feature_cols]
y_delay = df["is_delayed"]
y_duration = df["actual_remaining_days"]

# 70% Train, 15% Val, 15% Test (Stratified on delay for classifier)
X_train_val, X_test, y_del_train_val, y_del_test, y_dur_train_val, y_dur_test = train_test_split(
    X, y_delay, y_duration, test_size=0.15, random_state=42, stratify=y_delay
)

X_train, X_val, y_del_train, y_del_val, y_dur_train, y_dur_val = train_test_split(
    X_train_val, y_del_train_val, y_dur_train_val, test_size=0.17647, random_state=42, stratify=y_del_train_val
)

print(f"Dataset split: Train={len(X_train)} (70%), Val={len(X_val)} (15%), Test={len(X_test)} (15%)")

# Preprocessor
preprocessor = ColumnTransformer(
    transformers=[
        ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), cat_cols),
        ("num", "passthrough", num_cols)
    ]
)

preprocessor.fit(X_train)
cat_feature_names = list(preprocessor.named_transformers_["cat"].get_feature_names_out(cat_cols))
all_transformed_features = cat_feature_names + num_cols

X_train_t = preprocessor.transform(X_train)
X_val_t = preprocessor.transform(X_val)
X_test_t = preprocessor.transform(X_test)

metrics_report = {
    "dataset": {
        "total_samples": len(df),
        "train_samples": len(X_train),
        "val_samples": len(X_val),
        "test_samples": len(X_test),
        "features": feature_cols,
        "transformed_features": all_transformed_features
    },
    "model_a_classification": {},
    "model_b_regression": {}
}

# ==============================================================================
# Model A — Project Delay & Risk Prediction (Classifier)
# ==============================================================================
print("\n" + "="*60)
print("Training Model A: Project Delay Classifier Candidates")
print("="*60)

classifiers = {
    "Baseline_Dummy_Prior": DummyClassifier(strategy="prior"),
    "Baseline_LogisticRegression": LogisticRegression(max_iter=1000, random_state=42),
    "RandomForestClassifier": RandomForestClassifier(n_estimators=100, max_depth=8, random_state=42),
    "HistGradientBoostingClassifier": HistGradientBoostingClassifier(max_iter=100, random_state=42),
    "LightGBM_Classifier": lgb.LGBMClassifier(n_estimators=100, max_depth=6, learning_rate=0.08, verbose=-1, random_state=42)
}

best_clf_name = None
best_clf_score = -1
best_clf_model = None

for name, clf in classifiers.items():
    clf.fit(X_train_t, y_del_train)
    val_preds = clf.predict(X_val_t)
    val_probs = clf.predict_proba(X_val_t)[:, 1] if hasattr(clf, "predict_proba") else val_preds
    
    acc = accuracy_score(y_del_val, val_preds)
    prec = precision_score(y_del_val, val_preds, zero_division=0)
    rec = recall_score(y_del_val, val_preds, zero_division=0)
    f1 = f1_score(y_del_val, val_preds, zero_division=0)
    roc = roc_auc_score(y_del_val, val_probs) if len(np.unique(y_del_val)) > 1 else 0.5
    
    metrics_report["model_a_classification"][name] = {
        "val_accuracy": round(float(acc), 4),
        "val_precision": round(float(prec), 4),
        "val_recall": round(float(rec), 4),
        "val_f1": round(float(f1), 4),
        "val_roc_auc": round(float(roc), 4)
    }
    
    print(f"[{name}] Acc={acc:.4f} | Prec={prec:.4f} | Rec={rec:.4f} | F1={f1:.4f} | ROC-AUC={roc:.4f}")
    
    # Evaluate by F1 score on validation set
    if f1 > best_clf_score and not name.startswith("Baseline"):
        best_clf_score = f1
        best_clf_name = name
        best_clf_model = clf

# Evaluate best classifier on Test set
test_preds = best_clf_model.predict(X_test_t)
test_probs = best_clf_model.predict_proba(X_test_t)[:, 1]
cm = confusion_matrix(y_del_test, test_preds).tolist()

test_acc = accuracy_score(y_del_test, test_preds)
test_prec = precision_score(y_del_test, test_preds, zero_division=0)
test_rec = recall_score(y_del_test, test_preds, zero_division=0)
test_f1 = f1_score(y_del_test, test_preds, zero_division=0)
test_roc = roc_auc_score(y_del_test, test_probs)

metrics_report["model_a_classification"]["selected_best"] = best_clf_name
metrics_report["model_a_classification"]["test_performance"] = {
    "accuracy": round(float(test_acc), 4),
    "precision": round(float(test_prec), 4),
    "recall": round(float(test_rec), 4),
    "f1_score": round(float(test_f1), 4),
    "roc_auc": round(float(test_roc), 4),
    "confusion_matrix": {
        "TN": cm[0][0], "FP": cm[0][1],
        "FN": cm[1][0], "TP": cm[1][1]
    }
}

# Feature importances
if hasattr(best_clf_model, "feature_importances_"):
    importances = best_clf_model.feature_importances_
    sorted_idx = np.argsort(importances)[::-1]
    top_features = [{"feature": all_transformed_features[i], "importance": round(float(importances[i]), 4)} for i in sorted_idx[:8]]
    metrics_report["model_a_classification"]["top_features"] = top_features
    print("Top feature importances:", top_features)

print(f"\n=> Selected Classifier: {best_clf_name} (Test F1={test_f1:.4f}, ROC-AUC={test_roc:.4f})")

# ==============================================================================
# Model B — Remaining Completion Time (Regressor)
# ==============================================================================
print("\n" + "="*60)
print("Training Model B: Remaining Completion Time Regressor Candidates")
print("="*60)

regressors = {
    "Baseline_Dummy_Median": DummyRegressor(strategy="median"),
    "Baseline_RidgeRegression": Ridge(random_state=42),
    "RandomForestRegressor": RandomForestRegressor(n_estimators=100, max_depth=8, random_state=42),
    "HistGradientBoostingRegressor": HistGradientBoostingRegressor(max_iter=100, random_state=42),
    "LightGBM_Regressor": lgb.LGBMRegressor(n_estimators=100, max_depth=6, learning_rate=0.08, verbose=-1, random_state=42)
}

best_reg_name = None
best_reg_score = float("inf")
best_reg_model = None

for name, reg in regressors.items():
    reg.fit(X_train_t, y_dur_train)
    val_preds = reg.predict(X_val_t)
    
    mae = mean_absolute_error(y_dur_val, val_preds)
    rmse = np.sqrt(mean_squared_error(y_dur_val, val_preds))
    r2 = r2_score(y_dur_val, val_preds)
    
    metrics_report["model_b_regression"][name] = {
        "val_mae": round(float(mae), 4),
        "val_rmse": round(float(rmse), 4),
        "val_r2": round(float(r2), 4)
    }
    
    print(f"[{name}] MAE={mae:.4f} | RMSE={rmse:.4f} | R2={r2:.4f}")
    
    # Evaluate by MAE on validation set
    if mae < best_reg_score and not name.startswith("Baseline"):
        best_reg_score = mae
        best_reg_name = name
        best_reg_model = reg

# Evaluate best regressor on Test set
test_reg_preds = best_reg_model.predict(X_test_t)
test_mae = mean_absolute_error(y_dur_test, test_reg_preds)
test_rmse = np.sqrt(mean_squared_error(y_dur_test, test_reg_preds))
test_r2 = r2_score(y_dur_test, test_reg_preds)

# Estimate residual uncertainty standard deviation on validation set
residuals = y_dur_val - best_reg_model.predict(X_val_t)
residual_std = float(np.std(residuals))

metrics_report["model_b_regression"]["selected_best"] = best_reg_name
metrics_report["model_b_regression"]["residual_std"] = round(residual_std, 3)
metrics_report["model_b_regression"]["test_performance"] = {
    "mae": round(float(test_mae), 4),
    "rmse": round(float(test_rmse), 4),
    "r2": round(float(test_r2), 4)
}

print(f"\n=> Selected Regressor: {best_reg_name} (Test MAE={test_mae:.4f} days, R2={test_r2:.4f})")

# Save Models & Artifacts
joblib.dump(best_clf_model, os.path.join(MODELS_DIR, "delay_classifier.joblib"))
joblib.dump(best_reg_model, os.path.join(MODELS_DIR, "duration_regressor.joblib"))
joblib.dump(preprocessor, os.path.join(MODELS_DIR, "preprocessor.joblib"))

# Save metrics report
metrics_path = os.path.join(MODELS_DIR, "model_metrics.json")
with open(metrics_path, "w", encoding="utf-8") as f:
    json.dump(metrics_report, f, indent=2)

print(f"\nSuccessfully saved trained models and evaluation report to {MODELS_DIR}!")

