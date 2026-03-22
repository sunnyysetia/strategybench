# strategybench

a Karpathy-style self-improving agent harness.

the agent has a set of tools and a markdown file (`strategy.md`) that acts as its operating manual. it runs a benchmark, sees where it failed, rewrites the strategy, and reruns. it keeps the new strategy only if the score improves.

the tools never change. the code never changes.

**the agent cannot change its code. it can only change how it thinks.**

## how it works

the agent starts with a 2-line strategy and runs through a benchmark of 12 cases. a judge scores each case and compares the agent's handling to what an experienced human would have done. the improver reads those gaps, rewrites `strategy.md`, and the loop repeats. changes are kept only if the total score goes up, otherwise the strategy is reverted.

```
strategy.md ──▶ agent ──▶ benchmark ──▶ judge ──▶ improver ──▶ strategy.md
                  │                       │
                  ▼                       ▼
              uses tools          "how would a human
              talks to actors      have done this differently?"
```

## results

| gen | score | | delta | status |
|:---:|:------|:---|:-----:|:------:|
| 0 | **72/120** (60%) | `████████████░░░░░░░░` | - | baseline |
| 1 | **88/120** (73%) | `██████████████░░░░░░` | +16 | kept |
| 2 | **97/120** (81%) | `████████████████░░░░` | +9 | kept |
| 3 | **93/120** (78%) | `███████████████░░░░░` | -4 | reverted |
| 4 | **102/120** (85%) | `█████████████████░░░` | +5 | kept |

gen 3 tried rigid SOPs. scored worse because the agent lost conversational flexibility. the harness reverted it automatically.

## the example: property management

the benchmark here is an AI property manager that handles tenant situations -- leaks, late rent, noise complaints, fire alarms. it messages tenants, the landlord, plumbers. AI actors play each party and respond in character. a judge (gpt-4o) scores each case 1-10.

the agent starts with:

> You are an AI property manager. Handle incoming situations. Use your tools to communicate with contacts and keep notes.

after 4 generations it discovers: triage emergencies first, empathize before enforcing policy, always notify the owner on liability issues, reference lease clauses, document everything.

full conversation timelines for each case are in [`runs/timelines/`](runs/timelines/).

## quickstart

```bash
cp .env.example .env   # add your OpenAI API key
npm install
npm run bench -- water-leak   # run a single case
npm run bench                 # run all 12 cases
npm run improve               # start the self-improvement loop
```

## project structure

```
strategy.md       ← the agent's operating manual (the only thing that changes)
cases.json        ← 12 benchmark scenarios with AI actor definitions
contacts.json     ← tenant/owner/contractor directory
src/agent.ts      ← agent harness (4 tools: send_message, update_case_notes, list_contacts, mark_case_complete)
src/runner.ts     ← runs benchmark, judges each case
src/improve.ts    ← self-improvement loop
runs/             ← generation scores and strategy snapshots
runs/timelines/   ← full conversation logs per case
```

## why

inspired by karpathy's autoresearch -- optimize the program, not the code. `strategy.md` is a learned skill. the benchmark loop is the loss function. the human-comparison feedback is the gradient.
