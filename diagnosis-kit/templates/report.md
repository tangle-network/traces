<!--
One page. If it runs to two, cut findings, not the coverage section.
Replace every <angle bracket>. Delete this comment before sending.
Gate before sending: ~/company/gtm/personas/customer-facing-commercial-reviewer.md
-->

# <Customer> agent diagnosis

<Date> · <N> runs · <ISO window> · metadata only / content included

## What you asked

<Their words from intake section 2, quoted or closely paraphrased. One or two lines.>

## The answer

<Two to four lines. The direct answer, with the number. Not methodology, not caveats,
not a list of everything you found. If the answer is "we could not tell from this
trace", say that here, in this position, and explain why in the next section.>

## What we could not see

<This section is on page one deliberately. It is what makes the rest trustworthy.>

Your traces support <k> of 7 analysis capabilities. Unavailable:

| Capability | Why your trace cannot support it |
|---|---|
| <capability> | <the trace's own reason> |

<If analysis ran on metadata only:> We did not read prompt or response content, so
nothing here speaks to reasoning or output quality. Findings cover cost, latency, run
shape, tool behaviour and convergence.

<If any analysis was skipped:> We skipped <analysis> because <reason>.

## What we found

<Three to five findings, worst first. One paragraph each. Drop the rest; a long list
reads as padding and the customer stops at the third item anyway.>

**<Claim in one sentence.>** <What it costs you, in your terms: dollars, seconds,
failed runs, escalations. The number with its denominator.> Observed / Inferred.
Evidence: spans <id>, <id>. Reproduce: `<exact command>`

## What we would change first

<One recommendation. The one with the best ratio of effect to effort, not a ranked
list of five. Say what you expect it to move and by roughly how much, and say plainly
if that estimate is a guess.>

## How to check us

Every number above came from these, which are yours to keep and re-run:

```bash
<the commands>
```

<Name the check set and where it is. Say what a passing run looks like, so they can
tell whether a future change helped or hurt without asking us.>

## Your decision

<One paragraph. The choice in front of them, with what each option costs and what it
gets. Not a summary. Not "let us know if you have questions".>

---

Assumptions this rests on: <list them, each in one line>

Traces received <date>, deleted <date> / retained at your written request of <date>.
