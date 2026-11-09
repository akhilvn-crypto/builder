# Environments

One JSON file per target environment, for example `staging.json`:

```json
{ "BASE_URL": "https://staging.example.com", "REGION": "eu" }
```

Every entry is passed to Maestro as `-e NAME=value`, so a flow reads `${BASE_URL}`. Names that look like secrets
(`PASSWORD`, `TOKEN`, `SECRET`, `API_KEY`, …) are refused here: put them in `../../.env`.
The environment a run targets is `environments.default` in `mobile.config.json` or `--env <name>`; it is recorded with every run.
Never invent URLs: use the ones the team gives you for an authorised test environment.
