import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import fs from "fs";
import path from "path";
import "dotenv/config";
import {
  runBenchmark,
  type BenchmarkResult,
  type CaseResult,
} from "./runner";

// ── Config ──

const IMPROVE_MODEL = "gpt-4o";
const GENERATIONS = 5;
const STRATEGY_PATH = "./strategy.md";
const RUNS_DIR = "./runs";

// ── Helpers ──

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function bar(score: number, max: number, width = 20): string {
  const filled = Math.round((score / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatCaseReviews(results: CaseResult[]): string {
  // Each result already has a full timeline report with conversation log,
  // case notes, judgment, human comparison, and behaviors met/missed.
  return results
    .map((r) => r.timeline)
    .join("\n\n---\n\n");
}

function saveGeneration(
  gen: number,
  result: BenchmarkResult,
  strategy: string,
  kept: boolean,
  prevScore: number | null
) {
  const data = {
    generation: gen,
    score: result.score,
    max_score: result.max_score,
    percentage: ((result.score / result.max_score) * 100).toFixed(1),
    kept,
    prev_score: prevScore,
    strategy,
    results: result.results.map((r) => ({
      case_id: r.case_id,
      title: r.title,
      score: r.score,
      feedback: r.feedback,
      human_comparison: r.human_comparison,
      behaviors_met: r.behaviors_met,
      behaviors_missed: r.behaviors_missed,
      messages_count: r.messages.length,
      messages: r.messages,
      has_notes: !!r.case_notes,
    })),
  };

  const filePath = path.join(RUNS_DIR, `gen-${gen}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// ── Strategy Improvement ──

async function generateImprovedStrategy(
  currentStrategy: string,
  benchResult: BenchmarkResult
): Promise<string> {
  const prompt = `You are improving the system prompt for an AI property manager agent.

The agent handles situations for a residential apartment building. It has 3 tools:
1. **send_message(to, message)** — message tenants, the owner, contractors, or emergency services. Contacts reply in real time.
2. **update_case_notes(notes)** — write working notes about the case in markdown
3. **list_contacts()** — see available contacts

The agent receives a scenario and must handle it using these tools. A judge scores performance (1-10) and compares it to how an experienced human property manager would have handled the same situation.

## Current Strategy (the agent's entire system prompt)
---
${currentStrategy}
---

## Benchmark Results: ${benchResult.score}/${benchResult.max_score} (${((benchResult.score / benchResult.max_score) * 100).toFixed(1)}%)

${formatCaseReviews(benchResult.results)}

---

## Your Task

Rewrite the strategy to help the agent score higher. Pay special attention to the **human PM comparison** — those describe exactly what a real property manager would do differently.

The strategy should teach the agent:
- How to triage (what's urgent vs routine)
- Communication approach (empathy first, then action, then follow-up)
- Who to contact and in what order for different situations
- When to notify the owner (and when not to)
- How to document cases properly
- Legal/safety awareness (habitability, required inspections, deposit law)
- How to handle tenant emotions (anger, panic, frustration)
- Process discipline (don't approve things on the spot, follow procedures)

Output rules:
- Output ONLY the new strategy as Markdown — no preamble
- Keep it under 1000 words — the agent needs a focused playbook, not a textbook
- Don't reference specific tenant names, units, or case details — keep it general
- Don't list contacts — the agent gets those separately
- The tools don't change. You can only change HOW THE AGENT THINKS.`;

  const result = await generateText({
    model: openai(IMPROVE_MODEL),
    prompt,
    temperature: 0.7,
    maxTokens: 2500,
  });

  return result.text.trim();
}

// ── Main Loop ──

async function main() {
  ensureDir(RUNS_DIR);

  const history: { gen: number; score: number; max: number; kept: boolean }[] =
    [];

  console.log();
  console.log("╔═══════════════════════════════════════╗");
  console.log("║   StrategyBench · Self-Improvement    ║");
  console.log("╚═══════════════════════════════════════╝");
  console.log();

  // --- Gen 0: baseline ---
  console.log("gen 0 (baseline)");
  let result = await runBenchmark();
  let bestScore = result.score;
  let currentStrategy = fs.readFileSync(STRATEGY_PATH, "utf-8");

  saveGeneration(0, result, currentStrategy, true, null);
  history.push({
    gen: 0,
    score: result.score,
    max: result.max_score,
    kept: true,
  });

  console.log(
    `\n  ${bar(result.score, result.max_score)}  ${result.score}/${result.max_score}  (baseline)\n`
  );

  // --- Improvement loop ---
  for (let gen = 1; gen <= GENERATIONS; gen++) {
    console.log(`gen ${gen}`);
    process.stdout.write("  rewriting strategy... ");
    const newStrategy = await generateImprovedStrategy(
      currentStrategy,
      result
    );
    console.log("done");

    fs.writeFileSync(STRATEGY_PATH, newStrategy);

    const newResult = await runBenchmark();
    const delta = newResult.score - bestScore;
    const kept = newResult.score > bestScore;

    if (kept) {
      bestScore = newResult.score;
      currentStrategy = newStrategy;
      result = newResult;
      console.log(
        `\n  ${bar(newResult.score, newResult.max_score)}  ${newResult.score}/${newResult.max_score}  \x1b[32m↑ +${delta}  kept\x1b[0m\n`
      );
    } else {
      fs.writeFileSync(STRATEGY_PATH, currentStrategy);
      console.log(
        `\n  ${bar(newResult.score, newResult.max_score)}  ${newResult.score}/${newResult.max_score}  \x1b[31m${delta >= 0 ? "=" : delta}  reverted\x1b[0m\n`
      );
    }

    saveGeneration(
      gen,
      newResult,
      newStrategy,
      kept,
      bestScore - (kept ? delta : 0)
    );
    history.push({
      gen,
      score: newResult.score,
      max: newResult.max_score,
      kept,
    });

    if (bestScore === newResult.max_score) {
      console.log("  Perfect score. Stopping.\n");
      break;
    }
  }

  // --- Summary (terminal) ---
  console.log("════════════════════════════════════════");
  for (const h of history) {
    const label = h.gen === 0 ? "baseline" : h.kept ? "kept" : "reverted";
    console.log(
      `  gen ${h.gen}  ${bar(h.score, h.max)}  ${h.score}/${h.max}  (${label})`
    );
  }
  console.log();
  console.log(
    `  best: ${bestScore}/${history[0].max} (${((bestScore / history[0].max) * 100).toFixed(1)}%)`
  );
  console.log("════════════════════════════════════════");

  // --- Save markdown results table ---
  const maxScore = history[0].max;
  const tableLines: string[] = [];
  tableLines.push("| gen | score | | delta | status |");
  tableLines.push("|:---:|:------|:---|:-----:|:------:|");
  for (const h of history) {
    const pct = ((h.score / h.max) * 100).toFixed(0);
    const barStr = bar(h.score, h.max);
    let delta = "—";
    let status = "baseline";
    if (h.gen > 0) {
      const prev = history.find((p) => p.gen === h.gen - 1);
      const bestBefore = Math.max(
        ...history.filter((p) => p.gen < h.gen && p.kept).map((p) => p.score),
        history[0].score
      );
      const d = h.score - bestBefore;
      delta = d > 0 ? `+${d}` : `${d}`;
      status = h.kept ? "kept" : "reverted";
    }
    tableLines.push(
      `| ${h.gen} | **${h.score}/${h.max}** (${pct}%) | \`${barStr}\` | ${delta} | ${status} |`
    );
  }
  tableLines.push("");
  tableLines.push(
    `**Best: ${bestScore}/${maxScore} (${((bestScore / maxScore) * 100).toFixed(0)}%)**`
  );

  const tablePath = path.join(RUNS_DIR, "results.md");
  fs.writeFileSync(tablePath, tableLines.join("\n"));
  console.log(`\n  Results table saved to ${tablePath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
