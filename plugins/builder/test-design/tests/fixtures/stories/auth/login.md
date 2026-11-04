# Authentication stories

## US-001 — Registered user login

**Description:** As a registered user, I want to log in with my email and password, so that I can reach my dashboard.

**Functional Behaviour:** The user enters email and password and is taken to the dashboard.

**Business Rules:** The account is locked for 15 minutes after 5 consecutive failed attempts.

**Acceptance Criteria:**
- A user with valid credentials reaches the dashboard.
- A user with a wrong password sees the message "Invalid email or password".
- The fifth consecutive failed attempt locks the account for 15 minutes.

## US-002 — Password reset request

**Description:** As a registered user, I want to request a password reset, so that I can regain access.

**Acceptance Criteria:**
- Submitting a registered email shows the confirmation "Check your inbox".
- Submitting an unregistered email shows the same confirmation.

**Dependencies:** US-001 (Registered user login): the login page hosts the reset link.
