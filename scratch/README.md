# Scratch Directory

This directory contains regression trial records, evaluation outputs, and deterministic test fixtures required by the offline integration test suite (`tests/integration/`).

## Policy
- Ephemeral execution scripts (`*.cjs`, `*.mjs`, `*.ts`, `test_*`) are ignored by `.gitignore`.
- Deterministic evaluation fixtures (`phase*-*.json`, `humaneval-pilot/`) are preserved for reproducible verification.
