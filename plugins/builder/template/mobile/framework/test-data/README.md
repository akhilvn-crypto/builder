# test-data

Non-secret fixtures a flow may need (sample text, images for `addMedia`, JSON used by `runScript`). Keep it small.

- Secrets and real accounts do **not** belong here: use `.env` (`TEST_USER_PASSWORD=...`) and `${MAESTRO_TEST_USER_PASSWORD}` in the flow.
- Values that differ per environment go in `config/environments/<name>.json`.
- Create the data a test needs through a supported API or fixture; do not share one mutable account between tests.
