# Test data and secrets

1. Every `{variable}` used in a step, inline expectation or expected result is declared under `### Test Data` as `- name: value`. Names are letters, digits and underscores.
2. **Secrets and environment-specific values** (passwords, tokens, API keys, real account usernames, base URLs, real mailbox addresses) use `env:VARIABLE_NAME`. `VARIABLE_NAME` is UPPER_SNAKE_CASE. Its value lives in `automation/.env`, which this plugin never reads or writes.
3. **Deliberately fake or fixed values** that must stay verbatim (for example a known-wrong password in a negative test) use `literal:value`.
4. **Ordinary non-secret values** (a plan name, a count, a sample title) are plain literals.
5. A variable whose name suggests a credential (password, secret, token, api key, otp, pin...) and holds a plain value is an error: choose `env:` or an explicit `literal:`.
6. **Never copy a secret value** into test cases, traceability, workflow state, audit entries, logs, validation findings, or your own messages. If the user pastes a real credential in chat, or a story contains one, do not repeat it: use an `env:` reference, tell the user which variable name you chose and that they must add the value to `automation/.env` themselves.
7. Reuse one variable name for the same secret across cases (`TEST_USER_EMAIL`, `TEST_USER_PASSWORD`); do not mint a new name per case.
8. When a story creates records, do not hard-code a value that will collide on a second run; state the uniqueness need in Preconditions and let the Builder generate the value.
