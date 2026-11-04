# Demo shop

## DEMO-1: Home page shows the shop name
Tags: smoke

### Steps
1. Open the home page -> Expected: The heading "Demo Shop" is visible

## DEMO-2: User can sign in
Tags: smoke, auth

### Test Data
- email: literal:demo.user@example.com
- password: literal:demo-password-not-secret

### Steps
1. Open the login page
2. Enter {email} in the Email field
3. Enter {password} in the Password field
4. Click the "Sign in" button

### Expected Results
- The heading "Dashboard" is visible

## DEMO-3: Cart total is the sum of the items
Tags: cart

### Preconditions
- The cart contains Socks ($10.00) and Hat ($20.00)

### Steps
1. Open the cart page -> Expected: The cart total shows "$30.00"
