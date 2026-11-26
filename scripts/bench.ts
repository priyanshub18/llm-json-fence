import { performance } from "node:perf_hooks";
import { extractJson, parsePartialJson } from "../src/index.js";

function bench(name: string, iterations: number, fn: () => void): void {
  // Warmup
  for (let i = 0; i < 500; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedMs = performance.now() - start;
  const opsPerSec = Math.round((iterations / elapsedMs) * 1000);
  console.log(
    `${name.padEnd(36)} ${opsPerSec.toLocaleString().padStart(10)} ops/sec  (${elapsedMs.toFixed(1)} ms / ${iterations.toLocaleString()} runs)`
  );
}

const directPayload = JSON.stringify({
  title: "Distributed Systems",
  cards: [
    { q: "What is Raft?", a: "Consensus protocol with leader election and log replication." },
    { q: "What is MVCC?", a: "Multi-version concurrency control avoiding read/write locks." },
  ],
});

const fencedRepairedPayload = `Sure! Here is your JSON response:
\`\`\`json
{
  // Generated flashcard deck
  "title": "Distributed Systems",
  "url": "https://raft.github.io/",
  "active": True,
  "cards": [
    {"q": "What is Raft?", "a": "Consensus protocol",},
  ],
}
\`\`\`
Hope this helps!`;

const partialPayload = `\`\`\`json\n{"title":"Distributed Systems","cards":[{"q":"What is Raft?","a":"Consensus protocol with leader`;

console.log("llm-json-fence micro-benchmark (Node " + process.version + ")\n");
bench("1. Direct JSON fast-path", 50_000, () => extractJson(directPayload));
bench("2. Fenced + Comments + Repair", 50_000, () => extractJson(fencedRepairedPayload));
bench("3. Streaming Partial Completion", 50_000, () => parsePartialJson(partialPayload));
