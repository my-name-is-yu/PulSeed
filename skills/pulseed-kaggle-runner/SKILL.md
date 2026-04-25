---
name: pulseed-kaggle-runner
description: Run Kaggle training-first experiment loops with local CV, durable artifacts, and approval-gated submissions.
---
# PulSeed Kaggle Runner

Use this skill when a task involves Kaggle-style model training, validation, experiment comparison, or submission planning.

## Operating Rules

- Optimize local CV first. Do not submit every change to the leaderboard.
- Start each run as a named experiment with `kaggle_experiment_start`.
- Require `metrics.json` for every experiment before comparing or changing strategy.
- Preserve config, command, log, metrics, model, and submission artifacts.
- Compare experiments with `kaggle_compare_experiments` before choosing the next modeling change.
- Prepare submissions with `kaggle_submission_prepare` before asking for approval.
- Treat submit as scarce and approval-gated. Do not call `kaggle_submit` unless the operator explicitly approves.
- Use `kaggle_list_submissions` and `kaggle_leaderboard_snapshot` only after a submit or when the operator asks for external status.
- Avoid leakage and public leaderboard overfitting.
- Use deterministic seeds unless intentionally measuring ensemble variance.
- Prefer a small smoke run before long training.

## Artifact Contract

Read `references/experiment-contract.md` before starting a new workspace. Keep workspace paths under `~/.pulseed/kaggle-runs/<competition>` so wait and observe phases can resolve artifact paths after restart.

## Workflow

1. Prepare the workspace with `kaggle_workspace_prepare`.
2. Start a small smoke experiment with `kaggle_experiment_start`.
3. Observe completion through process metadata, `train.log`, and `metrics.json`.
4. Validate metrics with `kaggle_metric_report`.
5. Run and compare follow-up experiments with `kaggle_compare_experiments`.
6. Prepare a candidate CSV with `kaggle_submission_prepare` only after local CV evidence supports it.
7. Request explicit operator approval before `kaggle_submit`.
8. After submit, inspect external status with `kaggle_list_submissions` and capture a bounded `kaggle_leaderboard_snapshot`.
