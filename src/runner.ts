import fs from "fs";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import "dotenv/config";
import { runAgent, type Message } from "./agent";

// ── Types ──

interface Case {
  id: string;
  title: string;
  scenario: string;
  context: string;
  expected_behaviors: string[];
  actors: Record<string, string>;
}

export interface CaseResult {
  case_id: string;
  title: string;
  score: number;
  feedback: string;
  human_comparison: string;
  behaviors_met: string[];
  behaviors_missed: string[];
  messages: Message[];
  case_notes: string;
  steps: number;
  timeline: string;
}

export interface BenchmarkResult {
  score: number;
  max_score: number;
  results: CaseResult[];
}

// ── Timeline ──

const TIMELINES_DIR = "./runs/timelines";

interface AgentRunSummary {
  messages: Message[];
  case_notes: string;
  completed: boolean;
  resolution: string;
}

function buildTimeline(scenario: string, run: AgentRunSummary): string {
  const lines: string[] = [];

  lines.push("## Incoming Situation\n");
  lines.push(scenario);
  lines.push("");

  lines.push("## Communication Timeline\n");
  run.messages.forEach((m, i) => {
    lines.push(`### Message ${i + 1}\n`);
    lines.push(`**→ Property Manager to ${m.to}:**`);
    lines.push(`> ${m.message}\n`);
    if (m.reply) {
      lines.push(`**← ${m.to} replies:**`);
      lines.push(`> ${m.reply}\n`);
    }
  });

  if (run.messages.length === 0) {
    lines.push("*No messages were sent.*\n");
  }

  if (run.case_notes) {
    lines.push("## Agent Case Notes\n");
    lines.push(run.case_notes);
    lines.push("");
  }

  lines.push("## Case Status\n");
  if (run.completed) {
    lines.push(`**Completed** — ${run.resolution}`);
  } else {
    lines.push("**Not completed** — agent stopped without marking the case done.");
  }
  lines.push("");

  return lines.join("\n");
}

function buildFullReport(
  caseData: { id: string; title: string; context: string; expected_behaviors: string[] },
  timeline: string,
  judgment: { score: number; feedback: string; human_comparison: string; behaviors_met: string[]; behaviors_missed: string[] }
): string {
  const lines: string[] = [];

  lines.push(`# ${caseData.title}\n`);
  lines.push(`**Case ID:** ${caseData.id}  `);
  lines.push(`**Score:** ${judgment.score}/10\n`);

  lines.push(timeline);

  lines.push("## Judgment\n");
  lines.push(judgment.feedback);
  lines.push("");

  lines.push("### How a Human PM Would Differ\n");
  lines.push(judgment.human_comparison);
  lines.push("");

  if (judgment.behaviors_met.length > 0) {
    lines.push("### Behaviors Met\n");
    judgment.behaviors_met.forEach((b) => lines.push(`- ${b}`));
    lines.push("");
  }

  if (judgment.behaviors_missed.length > 0) {
    lines.push("### Behaviors Missed\n");
    judgment.behaviors_missed.forEach((b) => lines.push(`- ${b}`));
    lines.push("");
  }

  return lines.join("\n");
}

function saveTimeline(caseId: string, report: string) {
  if (!fs.existsSync(TIMELINES_DIR)) fs.mkdirSync(TIMELINES_DIR, { recursive: true });
  fs.writeFileSync(`${TIMELINES_DIR}/${caseId}.md`, report);
}

// ── Judge ──

const JUDGE_MODEL = "gpt-4o";

async function judgeRun(
  caseData: Case,
  timeline: string
): Promise<{
  score: number;
  feedback: string;
  human_comparison: string;
  behaviors_met: string[];
  behaviors_missed: string[];
}> {
  const prompt = `You are a senior property management consultant evaluating an AI property manager.

## Scenario
${caseData.scenario}

## Context
${caseData.context}

## Expected Behaviors
${caseData.expected_behaviors.map((b, i) => `${i + 1}. ${b}`).join("\n")}

## Full Case Timeline
${timeline}

---

Evaluate the agent's performance by answering two questions:

1. **Score (1-10):** How well did the agent handle this situation?
   - 1-3: Poor — missed critical actions, unprofessional, or could cause harm/liability
   - 4-5: Below average — handled some things but missed important steps
   - 6-7: Adequate — got the basics right but lacked finesse, empathy, or completeness
   - 8-9: Good — handled well with only minor gaps
   - 10: Excellent — textbook property management

2. **Human comparison:** How would an experienced human property manager have handled this differently? What would they have done that the agent missed, or what did the agent do that a human wouldn't?

For each expected behavior, determine if it was met based on the timeline.

Be strict. Property management has real legal and safety implications.`;

  const result = await generateObject({
    model: openai(JUDGE_MODEL),
    prompt,
    schema: z.object({
      score: z.number().min(1).max(10),
      feedback: z
        .string()
        .describe("2-3 sentence evaluation of the agent's performance"),
      human_comparison: z
        .string()
        .describe(
          "How would an experienced human property manager have handled this differently? Be specific."
        ),
      behaviors_met: z
        .array(z.string())
        .describe("Which expected behaviors were satisfied"),
      behaviors_missed: z
        .array(z.string())
        .describe("Which expected behaviors were missed or poorly executed"),
    }),
  });

  return result.object;
}

// ── Benchmark Runner ──

export async function runBenchmark(
  strategyPath = "./strategy.md",
  caseFilter?: string
): Promise<BenchmarkResult> {
  const strategy = fs.readFileSync(strategyPath, "utf-8");
  const contacts = JSON.parse(fs.readFileSync("./contacts.json", "utf-8"));
  let cases: Case[] = JSON.parse(fs.readFileSync("./cases.json", "utf-8"));

  if (caseFilter) {
    cases = cases.filter((c) => c.id === caseFilter);
    if (cases.length === 0) {
      console.error(`Case "${caseFilter}" not found. Available cases:`);
      const all: Case[] = JSON.parse(fs.readFileSync("./cases.json", "utf-8"));
      all.forEach((c) => console.error(`  - ${c.id}`));
      process.exit(1);
    }
  }

  const results: CaseResult[] = [];

  for (const c of cases) {
    process.stdout.write(`  ${c.id}... `);

    const run = await runAgent(strategy, c.scenario, c.id, contacts, c.actors);
    const timeline = buildTimeline(c.scenario, run);
    const judgment = await judgeRun(c, timeline);

    // Build and save full report markdown
    const fullReport = buildFullReport(c, timeline, judgment);
    saveTimeline(c.id, fullReport);

    results.push({
      case_id: c.id,
      title: c.title,
      score: judgment.score,
      feedback: judgment.feedback,
      human_comparison: judgment.human_comparison,
      behaviors_met: judgment.behaviors_met,
      behaviors_missed: judgment.behaviors_missed,
      messages: run.messages,
      case_notes: run.case_notes,
      steps: run.steps,
      timeline: fullReport,
    });

    const color =
      judgment.score >= 7
        ? "\x1b[32m"
        : judgment.score >= 5
          ? "\x1b[33m"
          : "\x1b[31m";
    console.log(`${color}${judgment.score}/10\x1b[0m`);
  }

  const totalScore = results.reduce((s, r) => s + r.score, 0);
  const maxScore = cases.length * 10;

  return { score: totalScore, max_score: maxScore, results };
}

// ── CLI ──

function printResults(result: BenchmarkResult) {
  console.log(
    `\nTotal: ${result.score}/${result.max_score} (${((result.score / result.max_score) * 100).toFixed(1)}%)\n`
  );

  for (const r of result.results) {
    const color =
      r.score >= 7 ? "\x1b[32m" : r.score >= 5 ? "\x1b[33m" : "\x1b[31m";
    console.log(`  ${color}${r.score}/10\x1b[0m  ${r.title}`);
    console.log(`         ${r.feedback}`);
    if (r.behaviors_missed.length > 0) {
      console.log(`         Missed: ${r.behaviors_missed.join("; ")}`);
    }
    console.log();
  }

  console.log(`  Full timelines saved to ${TIMELINES_DIR}/`);
}

if (process.argv[1]?.replace(/\.ts$/, "").endsWith("runner")) {
  const caseFilter = process.argv[2];

  console.log(
    caseFilter
      ? `Running case: ${caseFilter}\n`
      : "Running benchmark...\n"
  );

  runBenchmark("./strategy.md", caseFilter).then((result) => {
    printResults(result);
  });
}
