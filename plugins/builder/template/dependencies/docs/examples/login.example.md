# Login

## TC-001: Valid user can sign in
Priority: High
Tags: smoke, auth

### Preconditions
- An active test account exists

### Test Data
- email: env:TEST_USER_EMAIL
- password: env:TEST_USER_PASSWORD

### Steps
1. Open the login page
2. Enter {email} in the Email field
3. Enter {password} in the Password field
4. Click the "Sign in" button
   - Expected: The dashboard is displayed

### Expected Results
- The heading "Dashboard" is visible
- The URL contains "/dashboard"

## TC-002: Wrong password shows an error
Tags: auth

### Test Data
- email: env:TEST_USER_EMAIL
- password: literal:not-the-right-password-123

### Steps
1. Open the login page
2. Enter {email} in the Email field
3. Enter {password} in the Password field
4. Click the "Sign in" button -> Expected: The error "Invalid email or password" is shown
