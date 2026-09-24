# Diagnosis intake

Fill this in before we capture anything. It takes about fifteen minutes and it decides
what we can measure, so a thin answer here produces a thin report.

Send it back with nothing attached. Traces arrive separately, after we have agreed the
capture scope in section 4.

---

## 1. The agent

**What does it do, in one sentence a new hire would understand?**

**How long has it been in production, and roughly how many runs per day?**

**What harness or framework does it run on?**
(Claude Code, Codex, LangGraph, a custom loop, something else. If you are unsure, say
what the entry point is and we will work it out.)

**Which models, and do you route between them?**

## 2. The complaint

**What made you look for help? Be specific about the symptom, not the suspected cause.**
Good: "runs that used to finish in 90 seconds now take 6 minutes, starting about three
weeks ago." Less useful: "the prompts need tuning."

**How do you notice it today?** A dashboard, a customer complaint, a bill, a test suite.

**What have you already tried, and what happened?**
This matters more than it sounds. It tells us which explanations are already ruled out.

## 3. What "better" means

**Name the number that would have to move for this to have been worth $2,500.**
Cost per run, p95 latency, task success rate, human escalation rate, tool error rate.
One number. If you cannot name one, say so and we will propose one in the report, but
the engagement is weaker for it.

**What is that number today, and how do you measure it?**

**Do you have a test set, an eval, or a set of known-good runs we can measure against?**
If yes, that becomes the before-and-after. If no, we build a small one from your traces
and you keep it.

## 4. Data scope

Default is **metadata only**: timings, token counts, costs, tool names, model ids, error
statuses, and the shape of each run. No prompt or response content leaves your control.
Run the supplied metadata-only export step on your machine before sending any trace.
Keep the raw trace with you; send only the exported file.

**Does your agent handle regulated, privileged or personal data?**
(Client matters, health records, financial accounts, anything under GDPR, HIPAA or legal
privilege.) If yes, we stay on metadata and say so in the report.

**Do you want to opt into content capture?** ☐ No (default)  ☐ Yes

If yes, we need it in writing from someone who can authorise it, and you should know the
limit: our redaction catches structured secrets such as API keys, tokens and private keys.
It does not reliably catch names, addresses, account numbers or other personal data
written in prose. You are accepting that risk, so only opt in if the content is genuinely
safe to share.

**Third-party model processing.** Analysis runs a model over your spans. That model is
hosted by a third-party provider and reached through our router, so your spans leave our
infrastructure during analysis. Under the metadata-only default, what leaves is span
names, timings, token counts, costs, tool names, model ids and error statuses.
Check that your span and tool names do not contain client names or privileged details.
Free-form intake labels and questions stay local in metadata-only mode.
If you opt
into content capture, prose from your runs leaves too.

If that is unacceptable for your data, say so here and we will scope the engagement to
the deterministic passes only. Those run entirely locally and call no model. You lose the
model-written findings and keep the conformance table, capability matrix, execution facts,
cost and token accounting, loop and convergence analysis, and the agent-eval checks.

☐ Third-party model processing is acceptable
☐ Deterministic-only: no model may see our spans

**Who at your end can authorise data scope?** Name and role.

## 5. Access

**How will you export traces?**
We read OTLP JSONL. If you already emit OpenTelemetry, that is the whole job. If not,
tell us what you do emit and we will tell you whether it is enough before you build
anything.

**Is there a non-production environment with representative runs?**
Preferred, if it is genuinely representative. A staging system that never sees real load
tells us little.

**Retention.** We delete your traces at the end of the engagement unless you ask us in
writing to keep them. Tick if you want them kept: ☐

## 6. Logistics

**Who is the technical contact, and what timezone?**

**Is there a date this has to be done by, and what happens on that date?**
