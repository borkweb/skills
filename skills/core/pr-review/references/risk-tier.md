# Risk tier and PRE-EXISTING findings

## Step 7: Risk tier

The wrapper host sets the tier; the host reviewer and the peer are told not to. Follow `bork:review`'s [risk-tier.md](../../../gstack/review/risk-tier.md): classify the PR's changed paths, then set the tier. Take the author's association from the PR (`authorAssociation`) for its trusted-author rule.

Under Step 7's table, print `Risk tier: LOW | MEDIUM | HIGH`, with `person required` when it applies, and then `bork:review`'s `Human approval` line for the PR's head SHA. This skill still never approves.

## Step 6: PRE-EXISTING findings

List each PRE-EXISTING finding under `PRE-EXISTING — <n> not from this PR (never posted)`, with `file:line`, the problem in a line and its merge-base line. Count them in the table's `NIT / PRE-EXISTING` row.
