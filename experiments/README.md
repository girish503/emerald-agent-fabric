# Experiments Directory

Controlled experiments testing harness iterations, reflex heuristics, latency reductions, or evaluation methodologies are tracked here.

## Experiment Directory Structure
Each experiment lives in its own subdirectory (`EXP-001/`, `EXP-002/`, etc.) containing:
- `README.md`: Hypothesis, setup, variables (control, independent, dependent), dataset, procedure, metrics.
- `config.json`: Run configuration, model IDs, harness versions.
- `results.json`: Raw and summarized benchmark outputs.
- `analysis.md`: Conclusions, tradeoffs, threats to validity, and promotion decision.
