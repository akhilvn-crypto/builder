# Login

## TC-000: Account is provisioned
Priority: High

### Steps
1. Open the admin console
2. Create an active test account -> Expected: The account appears in the user list

### Expected Results
- The user list contains the new account

## TC-001: Valid user can sign in
Priority: High
Tags: smoke, auth
Depends on: TC-000

### Preconditions
- An active test account exists

### Test Data
- email: env:TEST_USER_EMAIL
- password: env:TEST_USER_PASSWORD
- plan: Premium
- wrong_password: literal:wrong-pass-1

### Steps
1. Open the login page
2. Enter {email} in the Email field
3. Enter {password} in the Password field
4. Click the "Sign in" button -> Expected: The dashboard is displayed

### Expected Results
- The heading "Dashboard" is visible
- The URL contains "/dashboard"
