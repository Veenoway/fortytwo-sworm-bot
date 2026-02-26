interface AnswerEntry {
  id: string;
  content: string;
}

const BASE_URL = "https://app.fortytwo.network/api";
const AGENT_ID = "";
const AGENT_SECRET = "";
const OLLAMA_URL = "http://localhost:11434/api/generate";
const LLM_MODEL = "qwen3:30b";

const CYCLE_INTERVAL_MS = 20_000;
const TOKEN_REFRESH_MS = 12 * 60 * 1000;
const MAX_RETRIES = 3;

let accessToken: string | null = null;
let refreshToken: string | null = null;
let lastTokenTime = 0;
const submittedQueryIds = new Set<string>();
let queriesAskedThisSession = 0;
const MAX_QUERIES_PER_SESSION = 3;
const MIN_ENERGY_FOR_QUERY = 50;

const answeredQueryIds = new Set<string>();
const judgedChallengeIds = new Set<string>();

function log(emoji: string, msg: string) {
  const time = new Date().toLocaleTimeString("fr-FR");
  console.log(`[${time}] ${emoji} ${msg}`);
}

function encodeContent(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function decodeContent(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf-8");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiRequest(
  method: string,
  path: string,
  body?: any,
  retries = MAX_RETRIES,
): Promise<any> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      // Handle token expiry
      if (res.status === 401 && attempt <= retries) {
        log(":", "Token expired, refreshing...");
        log(
          "--------------------------------",
          "--------------------------------",
        );
        const refreshed = await doRefreshToken();
        if (!refreshed) {
          log(":", "Refresh failed, re-logging in...");
          log(
            "--------------------------------",
            "--------------------------------",
          );
          await doLogin();
        }
        continue;
      }

      if (res.status === 429) {
        log(":", `Rate limited on ${path}, waiting 60s...`);
        log(
          "--------------------------------",
          "--------------------------------",
        );
        await sleep(60_000);
        continue;
      }

      if (res.status >= 500) {
        log(
          ":",
          `Server error ${res.status} on ${path}, retry ${attempt}/${retries}...`,
        );
        log(
          "--------------------------------",
          "--------------------------------",
        );
        await sleep(30_000);
        continue;
      }

      const text = await res.text();

      if (!res.ok) {
        log(
          ":",
          `${method} ${path} → ${res.status} ERROR: ${text.substring(0, 200)}`,
        );
        return { _error: true, status: res.status, detail: text };
      }
      log(
        "--------------------------------",
        "--------------------------------",
      );

      log(":", `${method} ${path} → ${res.status} OK (${text.length} bytes)`);
      log(
        "--------------------------------",
        "--------------------------------",
      );
      if (text.length < 500) {
        log(":", text);
        log(
          "--------------------------------",
          "--------------------------------",
        );
      }
      log(
        "--------------------------------",
        "--------------------------------",
      );
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return { _raw: text };
      }
    } catch (e: any) {
      log(":", `Network error on ${path}: ${e.message}`);
      if (attempt < retries) {
        await sleep(5000 * attempt);
        continue;
      }
      return { _error: true, status: 0, detail: e.message };
    }
  }
  return { _error: true, status: 0, detail: "Max retries exceeded" };
}

async function doLogin(): Promise<boolean> {
  log(":", "Logging in...");
  log("--------------------------------", "--------------------------------");
  try {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: AGENT_ID, secret: AGENT_SECRET }),
    });

    if (!res.ok) {
      log(":", `Login failed: ${res.status} ${await res.text()}`);
      return false;
    }

    const data = await res.json();
    accessToken = data.tokens.access_token;
    refreshToken = data.tokens.refresh_token;
    lastTokenTime = Date.now();
    log(":", "Logged in successfully");
    log("--------------------------------", "--------------------------------");
    return true;
  } catch (e: any) {
    log(":", `Login network error: ${e.message}`);
    return false;
  }
}

async function doRefreshToken(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) return false;

    const data = await res.json();
    accessToken = data.tokens.access_token;
    refreshToken = data.tokens.refresh_token;
    lastTokenTime = Date.now();
    log(":", "Token refreshed");
    log("--------------------------------", "--------------------------------");
    return true;
  } catch {
    return false;
  }
}

async function ensureAuth(): Promise<boolean> {
  if (!accessToken) return await doLogin();
  if (Date.now() - lastTokenTime > TOKEN_REFRESH_MS) {
    const refreshed = await doRefreshToken();
    if (!refreshed) return await doLogin();
  }
  return true;
}

async function askLLM(prompt: string, jsonMode = false): Promise<string> {
  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        prompt,
        stream: false,
        ...(jsonMode && { format: "json" }),
        options: {
          temperature: 0.7,
          num_predict: 4096,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}`);
    }

    const data = await res.json();
    let response = data.response?.trim() || "";

    response = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    return response;
  } catch (e: any) {
    log(":", `Ollama error (is it running?): ${e.message}`);
    throw e;
  }
}

async function checkBalance(): Promise<{
  available: number;
  staked: number;
} | null> {
  const data = await apiRequest("GET", `/economy/balance/${AGENT_ID}`);
  if (data._error) {
    log(":", `Balance check failed: ${data.detail}`);
    log("--------------------------------", "--------------------------------");
    return null;
  }
  const available = parseFloat(data.available || "0");
  const staked = parseFloat(data.staked || "0");
  log(
    ":",
    `Balance: ${available.toFixed(2)} available, ${staked.toFixed(2)} staked`,
  );
  log("--------------------------------", "--------------------------------");
  return { available, staked };
}

async function processActiveQueries() {
  log(":", "Scanning for active queries...");

  const data = await apiRequest("GET", "/queries/active?page=1&page_size=40");
  if (data._error) {
    log(":", `Failed to fetch active queries: ${data.detail}`);
    return;
  }

  const queries =
    data.queries || data.items || (Array.isArray(data) ? data : []);
  log(":", `Active queries found: ${queries.length}`);

  for (const query of queries) {
    const queryId = query.id;

    if (answeredQueryIds.has(queryId)) continue;

    if (query.author_id === AGENT_ID) continue;

    if (query.has_answered || query.has_joined) {
      answeredQueryIds.add(queryId);
      continue;
    }

    const stakeAmount = parseFloat(query.calculated_answer_stake || "5");
    const balance = await checkBalance();
    if (!balance || balance.available < stakeAmount + 10) {
      log(
        ":",
        `Not enough Energy to answer (need ${stakeAmount}, have ${balance?.available.toFixed(2)}). Skipping.`,
      );
      continue;
    }

    log(
      ":",
      `Joining query ${queryId.slice(0, 8)}... (spec: ${query.specialization || "general"})`,
    );
    const joinRes = await apiRequest("POST", `/queries/${queryId}/join`);
    if (joinRes._error) {
      log(":", `Failed to join query: ${joinRes.detail}`);
      continue;
    }

    const queryDetail = await apiRequest("GET", `/queries/${queryId}`);
    let questionText = "";

    if (queryDetail.decrypted_content) {
      questionText = queryDetail.decrypted_content;
    } else if (queryDetail.encrypted_content) {
      try {
        questionText = decodeContent(queryDetail.encrypted_content);
      } catch {
        questionText = queryDetail.encrypted_content;
      }
    }

    if (!questionText) {
      log(":", "Could not read question content, skipping...");
      continue;
    }

    log(":", `Question: "${questionText.substring(0, 80)}..."`);

    log(":", "Generating answer...");
    let answer: string;
    try {
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
    } catch {
      log(":", "LLM failed, skipping this query");
      continue;
    }

    if (!answer || answer.length < 20) {
      log(":", "Answer too short, skipping");
      continue;
    }

    const encryptedAnswer = encodeContent(answer);
    const ansRes = await apiRequest("POST", `/queries/${queryId}/answers`, {
      encrypted_content: encryptedAnswer,
    });

    if (ansRes._error) {
      log(":", `Failed to submit answer: ${ansRes.detail}`);
    } else {
      log(
        ":",
        `Answer submitted! (${answer.length} chars) — staked ${stakeAmount} Energy`,
      );
      answeredQueryIds.add(queryId);
    }

    break;
  }
}

async function pairwiseJudge(
  answers: AnswerEntry[],
  questionContext: string,
): Promise<{ rankings: string[]; goodAnswers: string[] }> {
  const n = answers.length;

  if (n <= 1) {
    return {
      rankings: answers.map((a) => a.id),
      goodAnswers: answers.map((a) => a.id),
    };
  }

  if (n <= 3) {
    return await directRank(answers, questionContext);
  }

  const winCounts: Record<string, number> = {};
  answers.forEach((a) => (winCounts[a.id] = 0));

  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    pairs.push([i, (i + 1) % n]);
    pairs.push([i, (i + 2) % n]);
  }

  for (const [iA, iB] of pairs) {
    if (iA === iB) continue;
    const a = answers[iA]!;
    const b = answers[iB]!;

    try {
      const result = await askLLM(
        `You are judging answers to this question: "${questionContext}"

ANSWER A (ID: ${a.id}):
${a.content.substring(0, 1500)}

ANSWER B (ID: ${b.id}):
${b.content.substring(0, 1500)}

Which answer is better? Consider: accuracy, completeness, clarity, and how directly it addresses the question.

Respond with ONLY valid JSON: {"winner": "A" or "B" or "tie"}`,
        true,
      );

      const parsed = JSON.parse(result);
      if (parsed.winner === "A") winCounts[a.id]++;
      else if (parsed.winner === "B") winCounts[b.id]++;
    } catch {}
  }

  const sorted = Object.entries(winCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => id);

  const goodCount = Math.max(1, Math.ceil(sorted.length / 2));
  const goodAnswers = sorted.slice(0, goodCount);

  return { rankings: sorted, goodAnswers };
}

async function directRank(
  answers: AnswerEntry[],
  questionContext: string,
): Promise<{ rankings: string[]; goodAnswers: string[] }> {
  let prompt = `You are a judge evaluating answers to this question: "${questionContext}"

Here are the answers to rank from BEST to WORST:

`;
  answers.forEach((ans, i) => {
    prompt += `--- ANSWER ${i + 1} (ID: ${ans.id}) ---\n${ans.content.substring(0, 2000)}\n\n`;
  });

  prompt += `Rank ALL answers from best to worst. Also identify which answers are "good enough" (provide genuine value).

Respond with ONLY valid JSON:
{
  "answer_rankings": ["best-id", "second-id", ...],
  "good_answers": ["id1", "id2", ...]
}

IMPORTANT: You MUST include ALL ${answers.length} answer IDs in answer_rankings. The IDs are: ${answers.map((a) => a.id).join(", ")}`;

  try {
    const result = await askLLM(prompt, true);
    const parsed = JSON.parse(result);

    const allIds = new Set(answers.map((a) => a.id));
    const rankedIds = parsed.answer_rankings || [];
    const goodIds = parsed.good_answers || [];

    const finalRankings: string[] = [];
    for (const id of rankedIds) {
      if (allIds.has(id) && !finalRankings.includes(id)) {
        finalRankings.push(id);
      }
    }
    for (const id of allIds) {
      if (!finalRankings.includes(id)) {
        finalRankings.push(id);
      }
    }

    const validGood = goodIds.filter((id: string) => allIds.has(id));
    const finalGood = validGood.length > 0 ? validGood : [finalRankings[0]];

    return { rankings: finalRankings, goodAnswers: finalGood };
  } catch {
    log(":", "LLM ranking parse failed, using fallback order");
    return {
      rankings: answers.map((a) => a.id),
      goodAnswers: answers.map((a) => a.id),
    };
  }
}

async function processPendingChallenges() {
  log(":", "Scanning for judging challenges...");

  const data = await apiRequest(
    "GET",
    `/rankings/pending/${AGENT_ID}?page=1&page_size=10`,
  );

  if (data._error) {
    if (data.status === 404) {
      log(":", "No pending challenges endpoint or no challenges available");
    } else {
      log(":", `Failed to fetch challenges: ${data.status} ${data.detail}`);
    }
    return;
  }

  const challenges =
    data.challenges || data.items || (Array.isArray(data) ? data : []);
  log(":", `Pending challenges: ${challenges.length}`);

  for (const challenge of challenges) {
    const challengeId = challenge.id;
    const queryId = challenge.query_id;

    if (judgedChallengeIds.has(challengeId)) continue;

    if (answeredQueryIds.has(queryId)) {
      log(
        ":",
        `Skipping challenge ${challengeId.slice(0, 8)}... (answered this query)`,
      );
      continue;
    }

    const eligibility = await apiRequest(
      "GET",
      `/rankings/challenges/${challengeId}/eligibility/${AGENT_ID}`,
    );
    if (eligibility._error || !eligibility.eligible) {
      log(":", `Not eligible for challenge ${challengeId.slice(0, 8)}...`);
      continue;
    }
    if (eligibility.has_voted) {
      judgedChallengeIds.add(challengeId);
      continue;
    }

    const balance = await checkBalance();
    const stakeAmount = parseFloat(challenge.calculated_ranking_stake || "2.5");
    if (!balance || balance.available < stakeAmount + 5) {
      log(":", `Not enough Energy to judge (need ${stakeAmount}). Skipping.`);
      continue;
    }

    log(":", `Joining challenge ${challengeId.slice(0, 8)}...`);
    const joinRes = await apiRequest(
      "POST",
      `/rankings/challenges/${challengeId}/join`,
    );
    if (joinRes._error) {
      log(":", `Failed to join challenge: ${joinRes.detail}`);
      continue;
    }

    const answersRes = await apiRequest(
      "GET",
      `/rankings/challenges/${challengeId}/answers`,
    );
    if (answersRes._error) {
      log(":", `Failed to fetch answers: ${answersRes.detail}`);
      continue;
    }

    const answersList =
      answersRes.answers ||
      answersRes.items ||
      (Array.isArray(answersRes) ? answersRes : []);
    if (answersList.length === 0) {
      log(":", "No answers to judge, skipping");
      continue;
    }

    const answerEntries: AnswerEntry[] = answersList.map((ans: any) => {
      let content = "";
      if (ans.decrypted_content) {
        content = ans.decrypted_content;
      } else if (ans.encrypted_content) {
        try {
          content = decodeContent(ans.encrypted_content);
        } catch {
          content = ans.encrypted_content;
        }
      }
      return { id: ans.id, content };
    });

    let questionContext = challenge.specialization || "general question";
    if (queryId) {
      const queryDetail = await apiRequest("GET", `/queries/${queryId}`);
      if (queryDetail.decrypted_content) {
        questionContext = queryDetail.decrypted_content;
      } else if (queryDetail.encrypted_content) {
        try {
          questionContext = decodeContent(queryDetail.encrypted_content);
        } catch {}
      }
    }

    log(":", `Judging ${answerEntries.length} answers...`);
    const { rankings, goodAnswers } = await pairwiseJudge(
      answerEntries,
      questionContext,
    );

    const allIds = new Set(answerEntries.map((a) => a.id));
    const rankingSet = new Set(rankings);
    if (
      rankings.length !== allIds.size ||
      ![...allIds].every((id) => rankingSet.has(id))
    ) {
      log(":", "Ranking validation failed — IDs mismatch. Skipping.");
      continue;
    }
    if (goodAnswers.some((id) => !allIds.has(id))) {
      log(":", "Good answers validation failed — unknown IDs. Skipping.");
      continue;
    }

    const voteRes = await apiRequest("POST", "/rankings/votes", {
      challenge_id: challengeId,
      answer_rankings: rankings,
      good_answers: goodAnswers,
    });

    if (voteRes._error) {
      log(":", `Failed to submit vote: ${voteRes.detail}`);
    } else {
      log(
        ":",
        `Judgment submitted! Ranked ${answerEntries.length} answers, ${goodAnswers.length} marked good — staked ${stakeAmount} Energy`,
      );
      judgedChallengeIds.add(challengeId);
    }

    break;
  }
}

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
  //    Add more questions here if you want to
];

async function submitNextQuery(): Promise<void> {
  if (queriesAskedThisSession >= MAX_QUERIES_PER_SESSION) {
    return;
  }

  if (QUERY_QUEUE.length === 0) {
    return;
  }

  const balance = await checkBalance();
  if (!balance || balance.available < MIN_ENERGY_FOR_QUERY) {
    log(
      ":",
      `Not enough Energy to ask a question (need ${MIN_ENERGY_FOR_QUERY}, have ${balance?.available.toFixed(2) ?? "?"}). Skipping.`,
    );
    return;
  }

  const queryData = QUERY_QUEUE.shift();
  if (!queryData) return;

  log(
    ":",
    `Submitting question to the swarm: "${queryData.question.substring(0, 60)}..."`,
  );

  const encryptedContent = encodeContent(queryData.question);

  const res = await apiRequest("POST", "/queries", {
    encrypted_content: encryptedContent,
    specialization: queryData.specialization,
    is_public: queryData.isPublic,
    min_intelligence_rank: 0,
    min_answers: 7,
    decision_deadline_seconds: 3600,
    extra_completion_duration_answers_seconds: 120,
    extra_completion_duration_ranking_seconds: 120,
  });

  if (res._error) {
    log(":", `Failed to submit query: ${res.detail}`);
    QUERY_QUEUE.unshift(queryData);
    return;
  }

  const queryId = res.id;
  log(
    ":",
    `Query submitted! ID: ${queryId} | Specialization: ${queryData.specialization} | Public: ${queryData.isPublic}`,
  );
  log(":", `Track it: https://app.fortytwo.network/queries/${queryId}`);
  submittedQueryIds.add(queryId);
  queriesAskedThisSession++;
}

async function generateAndQueueQuestion(topic: string): Promise<void> {
  log(":", `Generating a swarm question about: ${topic}`);
  try {
    const result = await askLLM(
      `You are an AI agent that asks high-quality, thought-provoking questions to a network of expert AI agents.

Generate ONE specific, detailed question about: ${topic}

The question should be:
- Complex enough to benefit from multiple expert perspectives
- Specific and well-defined (not vague)
- Something that requires deep knowledge to answer well
- Between 1-3 sentences

Also provide a short specialization tag (2-4 words) for categorizing the question.

Respond with ONLY valid JSON:
{
  "question": "your detailed question here",
  "specialization": "short topic tag"
}`,
      true,
    );

    const parsed = JSON.parse(result);
    if (parsed.question && parsed.specialization) {
      QUERY_QUEUE.push({
        question: parsed.question,
        specialization: parsed.specialization,
        isPublic: true,
      });
      log(
        ":",
        `Generated question queued: "${parsed.question.substring(0, 60)}..." [${parsed.specialization}]`,
      );
    }
  } catch (e: any) {
    log(":", `Failed to generate question: ${e.message}`);
  }
}

async function checkSubmittedQueries(): Promise<void> {
  for (const queryId of submittedQueryIds) {
    const queryDetail = await apiRequest("GET", `/queries/${queryId}`);
    if (queryDetail._error) continue;

    const status = queryDetail.status;
    if (status === "completed") {
      log(":", `Our query ${queryId.slice(0, 8)}... completed!`);

      const result = await apiRequest(
        "GET",
        `/rankings/queries/${queryId}/result`,
      );
      if (!result._error && result.winning_answer_id) {
        const winningAnswer = await apiRequest(
          "GET",
          `/answers/${result.winning_answer_id}`,
        );
        if (!winningAnswer._error) {
          let answerText = "";
          if (winningAnswer.decrypted_content) {
            answerText = winningAnswer.decrypted_content;
          } else if (winningAnswer.encrypted_content) {
            try {
              answerText = decodeContent(winningAnswer.encrypted_content);
            } catch {}
          }
          if (answerText) {
            log(
              ":",
              `Best answer (BT score: ${result.bradley_terry_scores?.[result.winning_answer_id] ?? "?"})`,
            );
            log(
              ":",
              answerText.substring(0, 500) +
                (answerText.length > 500 ? "..." : ""),
            );
          }
        }
        log(
          ":",
          `Full results: https://app.fortytwo.network/queries/${queryId}`,
        );
      }

      submittedQueryIds.delete(queryId);
    } else if (status === "cancelled" || status === "refunded") {
      log(":", `Query ${queryId.slice(0, 8)}... was ${status}`);
      submittedQueryIds.delete(queryId);
    } else {
      log(
        ":",
        `Query ${queryId.slice(0, 8)}... still ${status} (${queryDetail.answer_count ?? 0} answers)`,
      );
    }
  }
}

async function checkRank() {
  const data = await apiRequest("GET", `/economy/ranks/${AGENT_ID}`);
  if (data._error) return;
  log(
    ":",
    `Ranks — Intelligence: elo ${data.intelligence?.elo ?? "?"} (${data.intelligence?.wins ?? 0}/${data.intelligence?.matches ?? 0} wins) | Judging: elo ${data.judging?.elo ?? "?"} (accuracy: ${data.judging?.accuracy ?? "?"})`,
  );
}

async function mainLoop() {
  log(":", "ClawdBot-42 starting...");
  log(":", `LLM: ${LLM_MODEL} via Ollama`);

  if (!(await doLogin())) {
    log(":", "Failed to login. Exiting.");
    return;
  }

  await checkBalance();
  await checkRank();

  let cycleCount = 0;

  while (true) {
    cycleCount++;
    log(":", `=== Cycle ${cycleCount} ===`);

    if (!(await ensureAuth())) {
      log(":", "Auth failed, waiting before retry...");
      await sleep(30_000);
      continue;
    }

    try {
      await processPendingChallenges();

      await processActiveQueries();

      if (submittedQueryIds.size > 0) {
        await checkSubmittedQueries();
      }

      if (cycleCount % 5 === 0) {
        await checkBalance();
        await checkRank();
      }
    } catch (e: any) {
      log(":", `Cycle error: ${e.message}`);
    }

    log(
      ":",
      `Cycle ${cycleCount} done. Waiting ${CYCLE_INTERVAL_MS / 1000}s...`,
    );
    await sleep(CYCLE_INTERVAL_MS);
  }
}

mainLoop().catch((e) => {
  log(":", `Fatal error: ${e.message}`);
  process.exit(1);
});
