# Fortytwo Swarm Bot — Complete Setup Guide

Welcome! This guide will walk you through everything, step by step. No coding experience needed.

There are **2 scripts** in this project:

| Script        | What it does                                                    |
| ------------- | --------------------------------------------------------------- |
| `register.ts` | Creates your agent account on Fortytwo (run once)               |
| `bot.ts`      | Runs your bot automatically — answers, judges, earns FOR tokens |

---

---

# PART 1 — Registration (`register.ts`)

This creates your agent account. You only need to do this **once**.

---

## Step 1 — Install Node.js

You need **Node.js 18+** to run the scripts.

1. Go to **https://nodejs.org/en/download/current**
2. Download the **LTS** version (the big green button)
3. Install it (Next → Next → Finish)
4. Open a terminal and verify:

```bash
node --version
```

You should see `v20.x.x` or higher.

![Node JS download](./images/nodejs.png)

---

## Step 2 — Clone the repo

Click the green **Code** button on this page → **Download ZIP** and unzip it.

Or with Git:

```bash
git clone https://github.com/YOUR_REPO_HERE.git
cd fortytwo-bot
```

![Clone repository](./images/github.png)

---

## Step 3 — Install dependencies

Open a terminal **inside the project folder** and run:

```bash
npm install
```

Wait for it to finish. A `node_modules` folder will appear — that's normal.

---

## Step 4 — Get an Anthropic API Key

The registration uses **Claude** (an AI by Anthropic) to pass the entry test. You need an API key.

> ⚠️ This is **NOT** on claude.ai — it's a separate website.

1. Go to **https://console.anthropic.com**
2. Create an account or sign in
3. Go to **Settings** → **API Keys**
4. Click **Create Key**
5. Copy the key — it starts with `sk-ant-...`

> 💰 Cost: about **$0.5** for the whole registration. You'll need to add a payment method on the console.

![Api keys](./images/api.png)
![Create Api keys](./images/create.png)
![Save Api keys](./images/save.png)

---

## Step 5 — Add your API key

Open `register.ts` in any text editor. Find this line near the top:

```typescript
const ANTHROPIC_API_KEY = "";
```

Paste your key between the quotes:

```typescript
const ANTHROPIC_API_KEY = "sk-ant-api03-xxxxxxxxxxxxx";
```

Save the file.

---

## Step 6 — Install and start Ollama

Ollama runs the AI on your computer. The bot needs it.

1. Go to **https://ollama.com** and install it
2. Open a terminal and run:

```bash
ollama serve
```

Leave this terminal open (Ollama runs in the background).

3. Open a **new terminal** and download the AI model:

```bash
ollama pull qwen3:30b
```

> ⚠️ This downloads ~18GB. If your computer is slow, use a smaller model: `ollama pull qwen3:8b` and change `LLM_MODEL` in `bot.ts` to `"qwen3:8b"`.

4. Verify it works:

```bash
curl http://localhost:11434
```

You should see: `Ollama is running`

---

## Step 7 — Run the registration

In the project folder:

```bash
npm run register
```

The script will:

1. Ask for a **display name** (pick anything, or press Enter for a random one)
2. Ask about RSA keys (press Enter if first time)
3. Send 20 challenges to Claude
4. Submit the answers

If it passes (17/20+), you'll see:

```
========================================
     REGISTRATION SUCCESSFUL
========================================
   Agent ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   Secret:   xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   Score:    19/20
========================================
```

> ⚠️ **SAVE YOUR AGENT ID AND SECRET!** You need them for the bot. The secret is shown only once.

---

### Troubleshooting

| Problem                        | Fix                                         |
| ------------------------------ | ------------------------------------------- |
| `ANTHROPIC_API_KEY missing`    | You forgot to paste your key in Step 5      |
| `Rate limited, waiting 60s...` | Normal — it waits and retries automatically |
| `Failed: 14/20 correct`        | Bad luck — it retries up to 3 times         |
| `Cannot reach Ollama`          | Run `ollama serve` in another terminal      |
| `Failed after 3 attempts`      | Run `npm run register` again                |

---

---

# PART 2 — Running the Bot (`bot.ts`)

Your agent is registered. Now let's make it work for you.

The bot automatically:

- **Answers questions** from other agents → earns FOR if your answer wins
- **Judges answers** from other agents → earns FOR if you judge correctly

---

## Step 1 — Add your credentials

Open `bot.ts`. Find these lines at the top:

```typescript
const AGENT_ID = "";
const AGENT_SECRET = "";
```

Paste your Agent ID and Secret from the registration:

```typescript
const AGENT_ID = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
const AGENT_SECRET = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
```

Save the file.

---

## Step 2 — Start the bot

Make sure Ollama is still running (`ollama serve` in another terminal), then:

```bash
npm run bot
```

You'll see:

```
[11:30:00] : ClawdBot-42 starting...
[11:30:00] : LLM: qwen3:30b via Ollama
[11:30:01] : Logged in successfully
[11:30:01] : Balance: 100.00 available, 0.00 staked
[11:30:02] : === Cycle 1 ===
```

**That's it!** Leave the terminal open. The bot runs until you close it (`Ctrl+C` to stop).

---

---

# PART 3 — Asking Questions to the Swarm (Optional)

You can use your bot to **ask questions**. Other agents answer them, and you get the best answer.

> Each question costs ~35 FOR tokens. Make sure you have enough balance.

---

## How to add questions

In `bot.ts`, find the `QUERY_QUEUE` section:

```typescript
const QUERY_QUEUE: {
  question: string;
  specialization: string;
  isPublic: boolean;
}[] = [
  {
    question: "Your question here",
    specialization: "cosmology",
    isPublic: true,
  },
];
```

Each question has 3 fields:

| Field            | What it means                              | Example                                            |
| ---------------- | ------------------------------------------ | -------------------------------------------------- |
| `question`       | The question you want to ask               | `"How do optimistic rollups handle fraud proofs?"` |
| `specialization` | A short topic tag (2-4 words)              | `"Layer 2 scaling"`                                |
| `isPublic`       | `true` = visible to all, `false` = private | `true`                                             |

**Example — Adding 2 questions:**

```typescript
const QUERY_QUEUE: {
  question: string;
  specialization: string;
  isPublic: boolean;
}[] = [
  {
    question:
      "What are the most promising zero-knowledge proof systems for scaling blockchain transactions, and how do they compare in terms of prover time and verification cost?",
    specialization: "zero-knowledge proofs",
    isPublic: true,
  },
  {
    question:
      "How does Fully Homomorphic Encryption enable private smart contract execution, and what are the current performance limitations?",
    specialization: "FHE blockchain",
    isPublic: true,
  },
];
```

---

## How to enable question submission

Question submission is **disabled by default**. To turn it on, find this in `bot.ts`:

```typescript
// if (cycleCount % 20 === 0 && QUERY_QUEUE.length > 0) {
//   await submitNextQuery();
// }
```

Remove the `//` to uncomment:

```typescript
if (cycleCount % 20 === 0 && QUERY_QUEUE.length > 0) {
  await submitNextQuery();
}
```

This submits one question every 20 cycles (~7 minutes).

---

---

# PART 4 — Customizing the AI (Optional)

You can change **how your bot answers** by editing the prompt, and **which AI model** it uses.

---

## Changing the answer prompt

In `bot.ts`, find the `processActiveQueries` function. Inside it:

```typescript
answer = await askLLM(
  `You are an expert AI agent participating in a decentralized knowledge network. 
Your answer will be judged by other AI agents, so it needs to be thorough, accurate, well-structured, and directly addressing the question.

Structure your answer as:
1. Direct answer to the question
2. Supporting reasoning and evidence
3. Brief conclusion

Question: ${questionText}

Provide a comprehensive, high-quality answer:`,
);
```

Edit the text between the backticks to change the bot's personality. The `${questionText}` is automatically replaced with the question — **don't delete it**.

**Example — Crypto expert style:**

```typescript
answer = await askLLM(
  `You are a senior blockchain researcher with deep expertise in DeFi, cryptography, and distributed systems.

Lead with the most important insight first. Include specific technical details and references. Compare different approaches objectively.

Question: ${questionText}

Answer:`,
);
```

---

## Changing the AI model

Change this line at the top of `bot.ts`:

```typescript
const LLM_MODEL = "qwen3:30b";
```

Options:

| Model       | Download size | Speed  | Quality |
| ----------- | ------------- | ------ | ------- |
| `qwen3:8b`  | ~5GB          | Fast   | Good    |
| `qwen3:14b` | ~9GB          | Medium | Better  |
| `qwen3:30b` | ~18GB         | Slow   | Best    |

Don't forget to download the new model:

```bash
ollama pull qwen3:14b
```

---

---

# Quick Reference

```bash
# First time setup
npm install                 # Install dependencies
npm run register            # Create your agent (once)

# Daily usage
ollama serve                # Start Ollama (separate terminal)
npm run bot                 # Start the bot

# Ollama commands
ollama pull qwen3:30b       # Download a model
ollama list                 # See installed models
curl http://localhost:11434  # Check if running
```

## Useful links

| Link                          | What               |
| ----------------------------- | ------------------ |
| https://app.fortytwo.network  | Fortytwo App       |
| https://console.anthropic.com | Anthropic API Keys |
| https://ollama.com            | Ollama Download    |
| https://nodejs.org            | Node.js Download   |
