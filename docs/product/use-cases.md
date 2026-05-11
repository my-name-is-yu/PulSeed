# Product Scenarios

> Status: Product design scenarios. These examples illustrate intended PulSeed
> behavior, not a current operating capability reference.

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

PulSeed accepted the goal and started the task discovery loop.

**Goal decomposition**: PulSeed broke down "live happily together" into three sub-goals: continuous health monitoring, emergency response, and stage-appropriate care.

**Initial gap recognition**: PulSeed determined that the biggest gap was that while data from the collar was available, there was no mechanism to regularly analyze it and deliver the results to the owner.

**Delegation — building the monitoring foundation**: PulSeed instructed an agent with a concrete success criterion: "Please implement a monitoring script that reads the collar sensor data and detects abnormalities in breathing pace. It should send a daily summary to the owner's phone at 6 AM, and fire an immediate alert if an emergency threshold is exceeded." The agent implemented the code, and PulSeed verified that it worked correctly.

**Delegation — setting up emergency notifications**: Based on the implemented script, PulSeed delegated the configuration of emergency alerts to the notification system.

**Recurring loop (for the following 3 years)**: Every morning, PulSeed ran the observation loop:
- Had an agent analyze the sensor data summary
- Recognized gaps (early warning signs of abnormalities, care deficiencies)
- If necessary, delegated response tasks to an agent
- Delegated the owner's report to the messaging system for delivery

**Care adaptation**: As the disease progressed, PulSeed recognized changes from
the observation data. Detecting a gap between current care assumptions and the
new evidence, PulSeed delegated research on the latest respiratory disease care
protocols to an agent with medical knowledge, and proposed the results to the
owner. In cases where a vet consultation was deemed necessary, PulSeed asked the
owner for confirmation because irreversible medical decisions remain human
decisions.

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

The CEO agreed. From here, PulSeed's task discovery loop began.

**Goal decomposition**: PulSeed defined sub-goals for achieving "2x revenue": reducing churn rate, improving new customer acquisition, and increasing ARPU (average revenue per user).

**Loop 1 — understanding the current state**: Before recognizing the first gap, it was necessary to accurately understand reality. PulSeed delegated to a data analysis agent: "Please analyze the churn rate for the past 6 months, the common patterns among churned customers, and the dropout rate at each step of the conversion funnel, and compile a report."

**Loop 2 — identifying the biggest gap**: Receiving the analysis results, PulSeed determined that the biggest gap was in onboarding completion rate (the company was at 30% versus an industry average of 60%). It reasoned that improving onboarding would have a ripple effect on both churn rate and ARPU.

**Delegation — improving onboarding**: PulSeed instructed an agent: "Please add an interactive tutorial to the existing onboarding flow. The success criterion is that the completion rate improves by more than 10% from the baseline." After implementation was complete, PulSeed delegated verification of the functionality to a separate agent.

**Delegation — setting up A/B testing**: To measure the effectiveness of the tutorial, PulSeed delegated the setup of the A/B testing infrastructure to an agent.

**"Wait" as a strategy**: After launching the initiative, PulSeed established a two-week waiting period. During this time, it worked in parallel on other gaps (improving ARPU).

**Loop 3 and beyond — measurement and adjustment**: Two weeks later, PulSeed delegated analysis of the A/B test results to a data analysis agent. Confirming that tutorial completion rate had improved to 42% (+12%), it decided to continue the onboarding improvement strategy. At the same time, it cut initiatives that had shown little effect and moved to the next biggest gap (promoting upgrades).

**The loop closes**: The important pattern is not the exact outcome number. It
is the loop: observe reality, recognize the highest-leverage gap, delegate
bounded work, verify the result, and move to the next gap.

PulSeed does not need to be the CRM, analytics warehouse, experiment platform,
or implementation agent. Its role is to decide what should happen next, preserve
evidence, and coordinate the right capability while human owners keep authority
over consequential decisions.
