# Competition Checklist

- Confirm competition id, target column, metric name, and metric direction.
- Record train/validation split policy before training.
- Fix random seed for baseline and smoke experiments.
- Keep raw data separate from generated features and models.
- Run one small smoke experiment before long training.
- Check `train.log` for data leakage warnings, missing columns, and failed folds.
- Validate `metrics.json` before comparing experiments.
- Prefer stable CV improvement over public leaderboard movement.

