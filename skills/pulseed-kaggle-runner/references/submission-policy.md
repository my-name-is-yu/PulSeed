# Submission Policy

Submissions are scarce external actions.

- Do not submit just to check every training change.
- Compare local experiments first.
- Run `kaggle_submission_prepare` to copy the selected CSV into `submissions/` and record the selected experiment id, message, and local CV evidence.
- Require explicit operator approval before submission.
- Submit only prepared CSVs through `kaggle_submit`; it is an approval-required external action and requires the `kaggle_submission_prepare` metadata sidecar.
- Record the selected experiment id and local CV evidence before submission.
- Preserve the submitted CSV under `submissions/`.
- Use `kaggle_list_submissions` to inspect your own submission status.
- Use `kaggle_leaderboard_snapshot` for bounded leaderboard evidence after submit; do not optimize every change against it.
- Avoid tuning directly against public leaderboard feedback.
- Stop submitting if leaderboard movement conflicts with unstable or suspicious local CV.
