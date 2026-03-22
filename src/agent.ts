import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import fs from "fs";

// ── Types ──

export interface Message {
  to: string;
  message: string;
  reply?: string;
}

export interface AgentRun {
  messages: Message[];
  case_notes: string;
  steps: number;
  completed: boolean;
  resolution: string;
}

interface ActorMap {
  [name: string]: string; // name → system prompt
}

// ── Config ──

const AGENT_MODEL = "gpt-4o-mini";
const ACTOR_MODEL = "gpt-4o-mini";

// ── Actor simulation ──

async function simulateActor(
  actorPrompt: string,
  incomingMessage: string
): Promise<string> {
  const result = await generateText({
    model: openai(ACTOR_MODEL),
    system: `${actorPrompt}\n\nYou are receiving a message from the property manager. Respond naturally and in character. Keep your response to 1-3 sentences. Stay in character.`,
    prompt: `Property manager says: "${incomingMessage}"`,
    maxTokens: 200,
  });
  return result.text.trim();
}

function findActor(name: string, actors: ActorMap): string | null {
  // Exact match first
  if (actors[name]) return actors[name];

  // Fuzzy match — check if the name contains or is contained by an actor name
  const nameLower = name.toLowerCase();
  for (const [actorName, prompt] of Object.entries(actors)) {
    if (
      nameLower.includes(actorName.toLowerCase()) ||
      actorName.toLowerCase().includes(nameLower)
    ) {
      return prompt;
    }
  }
  return null;
}

// ── Agent ──

export async function runAgent(
  strategy: string,
  scenario: string,
  caseId: string,
  contacts: Record<string, unknown>,
  actors: ActorMap
): Promise<AgentRun> {
  const state: AgentRun = { messages: [], case_notes: "", steps: 0, completed: false, resolution: "" };

  const contactList = formatContacts(contacts);

  await generateText({
    model: openai(AGENT_MODEL),
    system: `${strategy}\n\n## Available Contacts\n${contactList}\n\n## Important\nWork through this case thoroughly. Contact all relevant parties, handle replies, document the case, then call mark_case_complete when done. Do not stop until the case is fully handled.`,
    prompt: scenario,
    maxSteps: 20,
    tools: {
      send_message: tool({
        description:
          "Send a message to a contact (tenant, owner, plumber, etc). They will respond.",
        parameters: z.object({
          to: z.string().describe("Name of the contact to message"),
          message: z
            .string()
            .describe("The message to send"),
        }),
        execute: async ({ to, message }) => {
          const msg: Message = { to, message };

          // Check if we have an actor for this contact
          const actorPrompt = findActor(to, actors);
          if (actorPrompt) {
            const reply = await simulateActor(actorPrompt, message);
            msg.reply = reply;
            state.messages.push(msg);
            return {
              status: "sent_and_replied",
              to,
              reply,
            };
          }

          // No actor — just acknowledge the send
          state.messages.push(msg);
          return {
            status: "sent",
            to,
            note: "Message delivered. No immediate reply.",
          };
        },
      }),

      update_case_notes: tool({
        description:
          "Write or update your working notes for this case. Use markdown. Include: situation assessment, priority level, actions taken, follow-ups needed.",
        parameters: z.object({
          notes: z.string().describe("Full case notes in markdown"),
        }),
        execute: async ({ notes }) => {
          state.case_notes = notes;
          const dir = "./case-notes";
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(`${dir}/${caseId}.md`, notes);
          return { status: "updated" };
        },
      }),

      list_contacts: tool({
        description:
          "List all available contacts with their roles and phone numbers",
        parameters: z.object({}),
        execute: async () => contacts,
      }),

      mark_case_complete: tool({
        description:
          "Mark this case as complete once you have: contacted all relevant parties, taken all necessary actions, documented the case, and set up any follow-ups. Do NOT call this until the case is fully handled.",
        parameters: z.object({
          resolution: z
            .string()
            .describe("Brief summary of how the case was resolved and any pending follow-ups"),
        }),
        execute: async ({ resolution }) => {
          state.completed = true;
          state.resolution = resolution;
          return { status: "case_closed", resolution };
        },
      }),
    },
  });

  state.steps = state.messages.length + (state.case_notes ? 1 : 0);
  return state;
}

// ── Helpers ──

function formatContacts(contacts: Record<string, unknown>): string {
  const lines: string[] = [];

  const tenants = contacts.tenants as Record<
    string,
    { name: string; phone: string }
  >;
  for (const [unit, info] of Object.entries(tenants)) {
    const unitLabel = unit.replace("_", " ").toUpperCase();
    lines.push(`- ${info.name} (Tenant, ${unitLabel}) — ${info.phone}`);
  }

  const roles = [
    "owner",
    "maintenance",
    "plumber",
    "electrician",
    "locksmith",
    "pest_control",
    "emergency",
  ];
  for (const role of roles) {
    const info = contacts[role] as { name: string; phone: string } | undefined;
    if (info) {
      const label = role.replace("_", " ");
      lines.push(
        `- ${info.name} (${label.charAt(0).toUpperCase() + label.slice(1)}) — ${info.phone}`
      );
    }
  }

  return lines.join("\n");
}
