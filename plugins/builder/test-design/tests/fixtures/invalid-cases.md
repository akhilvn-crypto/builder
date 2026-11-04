Stray text before any heading

# Checkout

## First case without id
Priority: High
Colour: red

### Steps
1. Click #submit-btn
3. Call page.locator('.x').click()

## TC-010: Uses undeclared data
### Test Data
- password: hunter2secret
- token: env:not-an-env-name
- user: bob

### Steps
1. Enter {email} in the Email field

### Expected Results
- It works

## TC-010: Duplicate id and cycle
Depends on: TC-011, TC-404

### Steps
1. Open the page

### Expected Results
- The page shows "Welcome"

## TC-011: Cycle partner
Depends on: TC-010

### Steps
1. Open the page

### Expected Results
- The page shows "Welcome"
