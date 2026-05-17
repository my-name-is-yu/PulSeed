# Product Scenarios

> Status: Product design scenarios. These examples illustrate intended PulSeed
> behavior, not a current operating capability reference.
> Doc status: north_star_direction
> Grounding use: design_context

Primary map: [Product Framing](./product-framing-map.md).

These scenarios define the companion experiences PulSeed is designed around.

These examples are product design narratives, not turnkey workflows
available today. They are not medical, veterinary, financial, legal, or business
advice. In safety-sensitive domains, humans and qualified professionals remain
responsible for decisions and irreversible actions.

---

## Use Case 1: Owner of an Elderly Dog with a Chronic Illness

> Product scenario. This is a design scenario, not a packaged veterinary
> monitoring workflow, emergency-response workflow, or medical recommendation
> system in the current package.

There was a dog owner whose elderly dog suffered from a chronic respiratory condition. The owner had neither the technical skills to monitor the dog's condition nor the knowledge to provide appropriate care.

So the owner equipped the dog with a wearable collar that tracked breathing pace and movement, granted PulSeed access to that data, and said:

"My dog has a chronic respiratory condition. I want us to live happily together."

In this future scenario, PulSeed would treat the statement as a long-running
goal context and start a task discovery loop after the user grants the required
data and notification permissions.

**Goal decomposition**: PulSeed would break down "live happily together" into
design sub-goals such as continuous observation, escalation preparation, and
stage-appropriate care planning.

**Initial gap recognition**: PulSeed would identify that collar data alone is not
enough; a verified analysis path, delivery channel, threshold policy, and human
review boundary are needed before any operational monitoring claim is valid.

**Delegation — building the monitoring foundation**: If the user approved this
direction, PulSeed could delegate a bounded implementation task with a concrete
success criterion, such as building a script that reads a specific data export
and produces a daily summary. Emergency-like alerts would require explicit
thresholds, tested delivery, and human responsibility outside PulSeed.

**Delegation — setting up notifications**: Notification setup would be a separate
approved integration task, not an automatic medical emergency workflow.

**Recurring loop over time**: In the intended design, PulSeed could repeat a
bounded observation loop:
- analyze the configured data summary
- identify uncertainty or missing evidence
- propose follow-up work when allowed
- prepare a user-facing summary for an approved messaging channel

**Care adaptation**: As the disease progressed, PulSeed recognized changes from
the observation data in this scenario. Detecting a gap between current care
assumptions and new evidence, PulSeed could prepare research questions or
summaries for the owner to discuss with a veterinarian. It should not diagnose,
prescribe, or make irreversible medical decisions.

The design lesson is continuity: PulSeed does not need to be the sensor, the
notification provider, or the medical authority. Its role is to keep the goal,
evidence, delegation, verification, and human approval loop coherent over time.

---

## Use Case 2: A Struggling SaaS Company

> Product scenario. This is a design scenario, not a turnkey revenue-growth
> operating system or business-advice workflow in the current package.

There was a SaaS company whose revenue had stalled. The CEO granted PulSeed access to all data and systems, and said:

"I want to 10x revenue in six months."

PulSeed first evaluated feasibility and responded:

"10x will be difficult, but 2x is achievable."

The CEO agreed. From here, the scenario illustrates the task discovery loop
PulSeed is designed to support.

**Goal decomposition**: PulSeed would define candidate sub-goals for achieving
"2x revenue," such as reducing churn rate, improving new customer acquisition,
and increasing ARPU (average revenue per user).

**Loop 1 — understanding the current state**: Before choosing a strategy, PulSeed
would need evidence. A bounded delegation could ask a data-analysis agent to
analyze churn, churned-customer patterns, and funnel drop-off, then return a
report for review.

**Loop 2 — identifying the biggest gap**: After receiving analysis results,
PulSeed could propose that onboarding completion is the highest-leverage gap.
The exact numbers in this scenario are illustrative; business decisions remain
with the operator.

**Delegation — improving onboarding**: With approval, PulSeed could create a
bounded implementation task such as adding an interactive tutorial and define
success criteria before execution. Verification should be separate from the
implementation work.

**Delegation — setting up measurement**: Measuring the effect would be a separate
task, such as configuring an experiment or analytics path. PulSeed should keep
the measurement plan explicit rather than treating implementation completion as
business success.

**"Wait" as a strategy**: After launch, PulSeed could recommend a waiting period
before evaluating noisy metrics. During that time it may prepare other bounded
work, subject to permission and resource limits.

**Loop 3 and beyond — measurement and adjustment**: Later, PulSeed could ask for
analysis of the experiment results, summarize the evidence, and recommend
whether to continue, cut, or pivot. It should not present illustrative metric
movement as guaranteed business advice.

**The loop closes**: The important pattern is not the exact outcome number. It
is the loop: observe reality, recognize the highest-leverage gap, delegate
bounded work, verify the result, and move to the next gap.

PulSeed does not need to be the CRM, analytics warehouse, experiment platform,
or implementation agent. Its role is to decide what should happen next, preserve
evidence, and coordinate the right capability while human owners keep authority
over consequential decisions.
