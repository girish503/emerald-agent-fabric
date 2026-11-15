# Experiments Directory

This directory tracks controlled empirical research experiments testing harness iterations, reflex heuristics, latency reductions, model substitutions, and evaluation methodologies.

## Purpose & Scope
Per Section 23 of the Master Engineering Constitution (`GEMINI.md`), Emerald advances via systematic empirical cycles:
`TRACE → FAILURE → CLASSIFICATION → EVAL CASE → HARNESS CHANGE → BENCHMARK → COMPARISON → PROMOTE / REJECT`

Active and future candidate experiments are organized in isolated subdirectories here. Major finalized milestone reports and security audits are archived under [`docs/reports/`](../docs/reports/).

## Experiment Directory Structure
Each experiment lives in its own subdirectory (`EXP-001/`, `EXP-002/`, etc.) containing:
- `README.md`: Hypothesis, setup, variables (control, independent, dependent), dataset, procedure, metrics.
- `config.json`: Run configuration, model IDs, harness versions.
- `results.json`: Raw and summarized benchmark outputs.
- `analysis.md`: Conclusions, tradeoffs, threats to validity, and promotion decision.
