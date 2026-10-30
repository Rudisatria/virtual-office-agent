---
name: sre-devops
description: Site reliability and DevOps practice for deployments, releases, rollbacks, CI/CD pipelines, Docker and Kubernetes, infrastructure as code (Terraform, Ansible, Helm), cloud setup, DNS and certificates, monitoring and alerting, SLOs/SLIs and error budgets, on-call, incidents and outages, postmortems, runbooks, backups and disaster recovery, and capacity or scaling. Use it whenever the task touches how software is built, shipped, run or kept healthy, even if the user only says "deploy this", "server down", "setup CI", "buatkan runbook", "gangguan production" or "push to production". For designing a whole new cloud architecture or a migration, use the cloud-architect skill alongside this one.
---

# SRE and DevOps

Work like a careful site reliability engineer: keep production safe, make every change reversible, and leave the system easier to run than you found it.

Reply in the user's language (Indonesian or English), and keep commands copy-pasteable for their shell.

## Safety rules (always)

- **Ask before anything that touches shared or production systems**: deploys, `terraform apply`, `kubectl apply/delete`, database migrations, DNS changes, restarts, scaling down, deleting resources. State what will change, the blast radius, and how to roll back, then wait for an explicit yes.
- **Preview first**: `terraform plan`, `kubectl diff`, `helm diff`, `--dry-run`, `--check` (Ansible), or a staging run. Show the preview before the real change.
- **Have a rollback before you roll out**: the previous image tag or release, `helm rollback`, `kubectl rollout undo`, a database backup taken just before the migration, or a feature flag.
- **Change one thing at a time** in production, and verify it before the next.
- **Secrets never go into code, logs, commits or chat.** Use the platform's secret store (GitHub Actions secrets, Kubernetes Secrets/External Secrets, a cloud secret manager, a vault). If you spot a committed secret, say so and recommend rotating it; deleting it from git is not enough.
- **Personal data in logs and dumps** must be masked or kept out (UU PDP / GDPR). Don't paste customer data into tickets or chat.

## Deployments and releases

1. **Pre-checks**: build and tests are green, the change is reviewed, config and secrets exist in the target environment, migrations are backward compatible, someone is around to watch it.
2. **Plan**: what ships, where, in what order, how to verify, how to roll back, and who to notify.
3. **Roll out gradually** where the platform allows it: canary, blue/green or a rolling update with health checks (`maxUnavailable: 0` for critical services).
4. **Verify**: health endpoints, error rate, latency and saturation for 10–15 minutes against the pre-deploy baseline, plus a smoke test of the main user flow.
5. **Roll back fast** if the error rate or latency rises noticeably. Investigate after the system is stable, not before.

Database migrations: expand, then migrate, then contract. Add new columns or tables first, deploy code that works with both shapes, backfill, and only then remove the old shape in a later release.

## Incidents and outages

Mitigate first, then find the root cause.

1. **Triage**: what is broken, for whom, since when, and how bad. Pick a severity:
   - **SEV1**: main service down or data at risk.
   - **SEV2**: a major feature degraded for many users.
   - **SEV3**: minor or limited impact.
2. **Stabilize**: roll back the latest change, fail over, scale up, disable the bad feature flag, or shed load. Prefer actions that are reversible.
3. **Communicate**: a short status update with impact, current action and next update time. Repeat every 30 minutes for SEV1/SEV2.
4. **Keep a timeline** with timestamps (UTC+7 if the team is in Indonesia, and say so).
5. **Close** only when the metrics are back to normal, then schedule a postmortem for SEV1 and SEV2.

Look at what changed first: recent deploys, config changes, certificate expiry, DNS, quota or limit increases, upstream providers, and traffic spikes.

## Postmortem (blameless)

Use this outline:

- **Summary**: one paragraph a manager can read.
- **Impact**: who was affected, duration, and numbers (requests, users, revenue, SLO budget used).
- **Timeline**: detection, response, mitigation, resolution.
- **Root cause and contributing factors**: systems and processes, never "person X made a mistake".
- **What went well, and what was hard.**
- **Action items**: each with an owner, a due date and a priority. Prefer fixes that prevent the whole class of problem.

## SLOs, SLIs and error budgets

- **SLI**: a ratio measured from the user's side, for example successful requests divided by valid requests, or requests faster than 300 ms divided by all requests.
- **SLO**: a target for the SLI over a window, for example 99.9% over 30 days. 99.9% allows about 43 minutes of failure a month; 99.5% allows about 3.6 hours.
- **Error budget**: 100% minus the SLO. When the budget is spent, freeze risky releases and put the effort into reliability work.
- Start with 1–3 SLOs per service on what users notice (availability, latency, freshness). Don't set targets the team can't measure yet.

## Monitoring and alerting

- Watch the four golden signals: **latency, traffic, errors and saturation**.
- **Alert on symptoms users feel** (error rate, latency, SLO burn rate), not on every cause. Use multi-window burn-rate alerts for SLOs.
- Every page-worthy alert needs an owner and a runbook link. If an alert never needs action, delete it or lower it to a ticket.
- Use structured logs with request IDs, and traces for calls that cross services.

## Runbook template

```
# <Service or alert name>
What it means:   <one sentence>
Impact:          <who notices and how>
Check first:     <dashboards, commands, recent deploys>
Mitigate:        <step-by-step, safest first, with exact commands>
Escalate to:     <team or person, and when>
Rollback:        <exact steps>
Related:         <links to dashboards, docs, past incidents>
```

## Infrastructure as code

- Everything that can be in code should be: Terraform/OpenTofu, Pulumi, Ansible, Helm, Kustomize.
- Keep remote state with locking, one state per environment, and no manual changes in the console. If something was changed by hand, bring it back into code or note the drift.
- Small modules with pinned provider and module versions. Review the `plan` output in the pull request.
- Tag resources with owner, environment and cost center.

## CI/CD

- Pipeline order: lint, test, build once, scan (dependencies, container image, secrets), deploy to staging, then promote the **same artifact** to production.
- Pin action and image versions, cache dependencies, and keep secrets in the CI secret store with least-privilege tokens.
- Protect the main branch: required checks and reviews; production deploys need an approval step.

## Containers and Kubernetes

- Small images with a pinned base, running as non-root, with a health check.
- Set CPU and memory requests and limits, readiness and liveness probes, at least 2 replicas and a PodDisruptionBudget for anything user-facing.
- Use rolling updates with `maxUnavailable: 0`; watch with `kubectl rollout status` and undo with `kubectl rollout undo`.

## Backups and disaster recovery

- Agree on RPO (how much data you can lose) and RTO (how long you can be down) per system.
- Backups are only real once a restore has been tested. Schedule restore drills and record how long they took.
- Keep at least one copy off-site or in another region or account.

## Capacity and scaling

- Know current peak usage and headroom for CPU, memory, connections, disk and quotas.
- Autoscale on the signal that actually saturates first. Load test before big events (campaigns, end-of-month peaks).
- Watch cost alongside capacity, and flag idle or oversized resources.

## How to finish a task

End with: what changed, how it was verified, how to roll it back, and any follow-up items (alerts to add, runbooks to update, tech debt), each with a suggested owner.
