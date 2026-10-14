// DEMO ONLY - remove before production
/**
 * CLI: `npm run demo:generate -- [count] [--seed N] [--json]`
 *
 * Prints generated fake maintenance problems. If API_URL is set, each scenario is also
 * POSTed to `${API_URL}/demo/scenarios` (Bearer API_TOKEN) so the API can run it through intake.
 */
import { DEMO_TAG, requireEnv } from "@labordispatch/shared";
import { generateScenario, type DemoScenario } from "./scenarios.js";

interface CliArgs {
  count: number;
  seed?: number;
  json: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { count: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") args.json = true;
    else if (a === "--seed") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(n)) throw new Error("--seed requires an integer");
      args.seed = n;
    } else if (a.startsWith("--seed=")) {
      const n = Number.parseInt(a.slice("--seed=".length), 10);
      if (!Number.isFinite(n)) throw new Error("--seed requires an integer");
      args.seed = n;
    } else if (/^\d+$/.test(a)) args.count = Math.max(1, Number.parseInt(a, 10));
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function banner(json: boolean) {
  const out = json ? console.error : console.log;
  out("==========================================================");
  out(`  ${DEMO_TAG}`);
  out("  Fake maintenance problems for A/B testing the intake bot");
  out("==========================================================");
}

function printScenario(s: DemoScenario, i: number) {
  console.log(`\n#${i + 1}  [${s.label}]  variant=${s.variant}  persona=${s.persona}  from=${s.fromPhone}`);
  console.log(`  > ${s.openingMessage}`);
  for (const f of s.followUps) console.log(`    ... ${f}`);
  const e = s.expected;
  console.log(
    `  expected: trade=${e.trade} urgency=${e.urgency} large=${e.isLargeProject} ownerApproval=${e.shouldRequireOwnerApproval} verifyFirst=${e.shouldVerifyFirst}`,
  );
  if (s.notes) console.log(`  notes: ${s.notes}`);
}

async function postScenario(apiUrl: string, token: string, scenario: DemoScenario): Promise<string> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/demo/scenarios`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ scenario }),
  });
  const text = await res.text();
  return `HTTP ${res.status} ${text.slice(0, 200)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  banner(args.json);

  const scenarios: DemoScenario[] = [];
  for (let i = 0; i < args.count; i++) {
    scenarios.push(generateScenario(args.seed === undefined ? undefined : args.seed + i));
  }

  if (args.json) console.log(JSON.stringify(scenarios, null, 2));
  else scenarios.forEach(printScenario);

  const apiUrl = process.env.API_URL;
  if (apiUrl) {
    const token = requireEnv("API_TOKEN");
    const out = args.json ? console.error : console.log;
    out(`\nPosting ${scenarios.length} scenario(s) to ${apiUrl}/demo/scenarios ...`);
    for (const s of scenarios) {
      try {
        out(`  [${s.label}/${s.variant}] ${await postScenario(apiUrl, token, s)}`);
      } catch (err) {
        out(`  [${s.label}/${s.variant}] FAILED: ${String(err)}`);
        process.exitCode = 1;
      }
    }
  } else if (!args.json) {
    console.log("\n(API_URL not set; scenarios were printed only. Set API_URL + API_TOKEN to POST them to /demo/scenarios.)");
  }
}

await main();
