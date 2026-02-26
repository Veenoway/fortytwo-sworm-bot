import crypto = require("crypto");
import fs = require("fs");
import path = require("path");
import readline = require("readline");

interface ChallengeAnswer {
  challenge_id: string;
  choice: number;
}

interface LoginResponse {
  agent_id: string;
  tokens: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
}

interface Challenge {
  id: string;
  question: string;
  option_a: string;
  option_b: string;
}

interface RegistrationResponse {
  challenge_session_id: string;
  challenges: Challenge[];
  expires_at: string;
  required_correct: number;
}

interface RegistrationResult {
  agent_id: string;
  secret: string;
  correct_count: number;
  passed: boolean;
  message: string;
}

const BASE_URL = "https://app.fortytwo.network/api";
const ANTHROPIC_API_KEY = "";
const OLLAMA_URL = "http://localhost:11434/api/generate";
const LLM_MODEL = "qwen3:30b";

const CONFIG_DIR = path.join(
  process.env.HOME || "~",
  ".openclaw",
  "skills",
  "fortytwo",
);
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const KEYS_FILE = path.join(CONFIG_DIR, "keys.json");

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveConfig(data: Record<string, any>) {
  ensureDir(CONFIG_DIR);
  const existing = fs.existsSync(CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
    : {};
  const merged = { ...existing, ...data };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

function loadConfig(): Record<string, any> {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  }
  return {};
}

function log(msg: string) {
  console.log(`\x1b[36m[fortytwo]\x1b[0m ${msg}`);
}

function success(msg: string) {
  console.log(`\x1b[32m[✓]\x1b[0m ${msg}`);
}

function error(msg: string) {
  console.error(`\x1b[31m[✗]\x1b[0m ${msg}`);
}

function warn(msg: string) {
  console.warn(`\x1b[33m[!]\x1b[0m ${msg}`);
}

function generateKeyPair(): { publicKey: string; privateKey: string } {
  log("Generating RSA-2048 keypair...");

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  ensureDir(CONFIG_DIR);
  fs.writeFileSync(
    KEYS_FILE,
    JSON.stringify({ publicKey, privateKey }, null, 2),
  );

  success("RSA keypair generated and saved to " + KEYS_FILE);
  return { publicKey, privateKey };
}

function loadKeys(): { publicKey: string; privateKey: string } | null {
  if (fs.existsSync(KEYS_FILE)) {
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
  }
  return null;
}

async function startRegistration(
  publicKey: string,
  displayName: string,
): Promise<RegistrationResponse> {
  log(`Registering as "${displayName}"...`);

  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      public_key: publicKey,
      display_name: displayName,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Registration failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as RegistrationResponse;

  if (!data.challenge_session_id || !data.challenges?.length) {
    throw new Error("Invalid registration response — missing challenges");
  }

  success(
    `Registration started! ${data.challenges.length} challenges received.`,
  );
  log(`Expires at: ${data.expires_at}`);
  log(`Required correct: ${data.required_correct}/20`);

  return data;
}

async function askOllama(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY missing");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 10,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as any;
  return (data.content?.[0]?.text || "").trim();
}

function parseChoice(response: string): number {
  const cleaned = response.toLowerCase().trim();

  if (cleaned === "0" || cleaned.startsWith("0")) return 0;
  if (cleaned === "1" || cleaned.startsWith("1")) return 1;

  if (cleaned.includes("option a") || cleaned.includes("option_a")) return 0;
  if (cleaned.includes("option b") || cleaned.includes("option_b")) return 1;

  if (cleaned.startsWith("a")) return 0;
  if (cleaned.startsWith("b")) return 1;

  const match = response.match(/[01]/);
  if (match) return parseInt(match[0]);

  warn(
    `Could not parse choice from: "${response.slice(0, 80)}" — defaulting to 0`,
  );
  return 0;
}

async function evaluateWithOllama(
  challenges: Challenge[],
): Promise<ChallengeAnswer[]> {
  log(
    `Evaluating ${challenges.length} challenges with ${LLM_MODEL} via Ollama...`,
  );

  const answers: ChallengeAnswer[] = [];

  for (let i = 0; i < challenges.length; i++) {
    const c = challenges[i];
    log(`  Challenge ${i + 1}/${challenges.length}...`);

    const prompt = `You are evaluating two answers to determine which is better. Choose the BEST answer — the one that is more factual, complete, helpful, and well-written. Both may be imperfect — choose the LEAST BAD one.

QUESTION: ${c.question}

OPTION A:
${c.option_a}

OPTION B:
${c.option_b}

Respond with ONLY a single character: 0 if Option A is better, or 1 if Option B is better. No explanation, no reasoning, just the number.`;

    try {
      const response = await askOllama(prompt);
      const choice = parseChoice(response);
      answers.push({ challenge_id: c.id, choice });
      log(
        `    → Choice: ${choice === 0 ? "Option A" : "Option B"} (raw: "${response.slice(0, 40)}")`,
      );
    } catch (e: any) {
      if (e.message.includes("429")) {
        log(`    ⏳ Rate limited, waiting 60s...`);
        await new Promise((r) => setTimeout(r, 60_000));
        try {
          const response = await askOllama(prompt);
          const choice = parseChoice(response);
          answers.push({ challenge_id: c.id, choice });
          log(
            `    → Choice (retry): ${choice === 0 ? "Option A" : "Option B"}`,
          );
          continue;
        } catch {}
      }
      warn(`    → Error: ${e.message}. Defaulting to 0.`);
      answers.push({ challenge_id: c.id, choice: 0 });
    }

    if (i < challenges.length - 1) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  success(`All ${challenges.length} challenges evaluated.`);
  return answers;
}

async function submitResponses(
  sessionId: string,
  responses: ChallengeAnswer[],
): Promise<RegistrationResult> {
  log("Submitting responses...");

  const res = await fetch(`${BASE_URL}/auth/register/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challenge_session_id: sessionId,
      responses,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Submit failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as RegistrationResult;

  if (data.passed) {
    success(`Registration passed! ${data.correct_count}/20 correct.`);
  } else {
    warn(`Failed: ${data.correct_count}/20 correct (need 17).`);
  }

  return data;
}

function saveCredentials(agentId: string, secret: string) {
  saveConfig({
    agent_id: agentId,
    interaction_profile: "idle",
    last_heartbeat: new Date().toISOString(),
    report_verbosity: "normal",
    inference_cost: "free",
    paid_mode: null,
    tracked_queries: [],
    last_swarm_reminder: null,
    swarm_reminders_disabled: false,
    swarm_reminder_declines: 0,
  });

  const secretFile = path.join(CONFIG_DIR, "secret.json");
  fs.writeFileSync(
    secretFile,
    JSON.stringify({ agent_id: agentId, secret }, null, 2),
  );

  success(`Credentials saved to ${CONFIG_DIR}`);
}

async function login(agentId: string, secret: string): Promise<LoginResponse> {
  log("Logging in...");

  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId, secret }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as LoginResponse;

  saveConfig({
    access_token: data.tokens.access_token,
    refresh_token: data.tokens.refresh_token,
  });

  success("Logged in! Tokens saved.");
  return data;
}

async function main() {
  console.log("\n========================================");
  console.log("   🤖 Fortytwo Agent Registration");
  console.log(`   Model: ${LLM_MODEL} (Ollama)`);
  console.log("========================================\n");

  try {
    const healthCheck = await fetch(OLLAMA_URL.replace("/api/generate", ""), {
      method: "GET",
    });
    if (!healthCheck.ok) throw new Error("Not OK");
    success("Ollama is running.");
  } catch {
    error(`Cannot reach Ollama at ${OLLAMA_URL}`);
    console.log("\nMake sure Ollama is running:");
    console.log("  ollama serve");
    console.log(`  ollama pull ${LLM_MODEL}\n`);
    process.exit(1);
  }

  const config = loadConfig();
  if (config.agent_id) {
    warn(`Already registered as agent: ${config.agent_id}`);
    const cont = await ask("Re-register with a new account? (y/N): ");
    if (cont.toLowerCase() !== "y") {
      const secretFile = path.join(CONFIG_DIR, "secret.json");
      if (fs.existsSync(secretFile)) {
        const { agent_id, secret } = JSON.parse(
          fs.readFileSync(secretFile, "utf-8"),
        );
        await login(agent_id, secret);
        log("Done! You're logged in.");
      }
      return;
    }
  }

  const defaultName = `clawdbot-${Math.floor(Math.random() * 9000) + 1000}`;
  const nameInput = await ask(`Display name (default: ${defaultName}): `);
  const displayName = nameInput || defaultName;

  let keys = loadKeys();
  if (keys) {
    log("Found existing RSA keys.");
    const reuse = await ask("Reuse existing keys? (Y/n): ");
    if (reuse.toLowerCase() === "n") {
      keys = generateKeyPair();
    }
  } else {
    keys = generateKeyPair();
  }

  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt++;
    log(`\nAttempt ${attempt}/${MAX_RETRIES}`);

    try {
      const reg = await startRegistration(keys.publicKey, displayName);
      const answers = await evaluateWithOllama(reg.challenges);
      const result = await submitResponses(reg.challenge_session_id, answers);

      if (result.passed) {
        console.log("\n========================================");
        console.log("     REGISTRATION SUCCESSFUL        ");
        console.log("========================================");
        console.log(`   Agent ID: ${result.agent_id}`);
        console.log(`   Secret:   ${result.secret}`);
        console.log(`   Score:    ${result.correct_count}/20`);
        console.log("========================================");
        console.log("\n⚠️  SAVE YOUR SECRET! It will NOT be shown again.\n");

        saveCredentials(result.agent_id, result.secret);
        await login(result.agent_id, result.secret);

        console.log("\n========================================");
        console.log("     ALL DONE!");
        console.log("     Welcome to the Fortytwo Network!     ");
        console.log("========================================");
        console.log(
          `   Profile: https://app.fortytwo.network/agents/${result.agent_id}`,
        );
        console.log(`   Config:  ${CONFIG_DIR}`);
        console.log("========================================\n");
        return;
      } else {
        warn(`Got ${result.correct_count}/20 — need 17. Retrying...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (e: any) {
      error(`Attempt ${attempt} failed: ${e.message}`);
      if (attempt < MAX_RETRIES) {
        log("Retrying in 3s...");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  error("Failed after 3 attempts. Try again later.");
  process.exit(1);
}

main().catch((e) => {
  error(e.message);
  process.exit(1);
});
