#!/usr/bin/env node
// raen-call — curl for paid APIs.
// One command: fetch → 402 → decode challenge → sign with your wallet → pay USDC on Base → retry → answer + settlement receipt.
// Wallet key comes from an env var, NEVER from argv (argv leaks into shell history and process lists).

import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const VERSION = "1.0.0";

const USAGE = `raen-call v${VERSION} — curl for paid APIs (x402 / USDC on Base)

USAGE
  raen-call <url> [options]

OPTIONS
  -d, --data <json>       Request body (JSON string). Implies POST unless --method given.
  -X, --method <method>   HTTP method (default: POST if -d given, else GET)
  -H, --header <h>        Extra header "Name: value" (repeatable)
  --key-env <name>        Env var holding the wallet private key (default: X402_PRIVATE_KEY)
  --network <caip2>       Network for the signer (default: eip155:8453 = Base mainnet)
  --max-value <usd>       Safety cap: refuse challenges above this USD price (default: 1.00)
  --no-pay                Fetch only; print the 402 challenge, do not pay
  --json                  Print only the final response body (pipe-friendly)
  -h, --help              Show this help

WALLET
  Export your EVM private key (it never leaves your machine; it signs the payment only):
    export X402_PRIVATE_KEY=0x...

EXAMPLES
  raen-call https://api.example.com/api/lookup -d '{"query":"FCRA 605"}'
  raen-call https://api.example.com/api/ticker?symbol=AAPL --max-value 5
  raen-call https://api.example.com/api/ping --no-pay        # inspect the price first

If the endpoint is free, raen-call just returns the response like curl.
If it answers 402, raen-call shows you the price BEFORE paying — and caps it.`;

function die(msg, code = 1) {
  if (process.argv.includes("--json")) {
    console.error(JSON.stringify({ error: msg }));
  } else {
    console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  }
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    url: null,
    data: null,
    method: null,
    headers: [],
    keyEnv: "X402_PRIVATE_KEY",
    network: "eip155:8453",
    maxValue: 1.0,
    pay: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else if (a === "-d" || a === "--data") opts.data = argv[++i];
    else if (a === "-X" || a === "--method") opts.method = (argv[++i] || "").toUpperCase();
    else if (a === "-H" || a === "--header") opts.headers.push(argv[++i]);
    else if (a === "--key-env") opts.keyEnv = argv[++i];
    else if (a === "--network") opts.network = argv[++i];
    else if (a === "--max-value") opts.maxValue = parseFloat(argv[++i]);
    else if (a === "--no-pay") opts.pay = false;
    else if (a === "--json") opts.json = true;
    else if (a === "--version") { console.log(VERSION); process.exit(0); }
    else if (a.startsWith("-")) die(`Unknown option: ${a}. Try --help.`);
    else {
      if (opts.url) die(`Unexpected extra argument: ${a}`);
      opts.url = a;
    }
  }
  return opts;
}

function c(color, s) { return opts_json ? s : `\x1b[${color}m${s}\x1b[0m`; }
let opts_json = false;

// Well-known tokens on Base mainnet, for amount→USD conversion and symbol display
const KNOWN_ASSETS = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
};

function assetInfo(addr) {
  return KNOWN_ASSETS[String(addr || "").toLowerCase()] || null;
}

function parsePriceUSD(price) {
  if (typeof price === "number") return price;
  if (typeof price !== "string") return null;
  const m = price.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

// v2 challenges use integer `amount` in token units (e.g. "50000" = $0.05 USDC)
function priceFromAccept(a) {
  const p = parsePriceUSD(a?.price ?? a?.maxAmountRequired);
  if (p !== null) return p;
  const info = assetInfo(a?.asset);
  if (info && a?.amount !== undefined) {
    const amt = BigInt(a.amount);
    return Number(amt) / 10 ** info.decimals;
  }
  return null;
}

function displayAsset(a) {
  const info = assetInfo(a?.asset);
  return info ? info.symbol : (a?.asset ?? "USDC");
}

function decodeChallenge(headerValue) {
  // x402 v2: base64 JSON in the PAYMENT-REQUIRED header. v1 fallback: 402 JSON body.
  try { return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")); }
  catch { try { return JSON.parse(headerValue); } catch { return null; } }
}

function shortAddr(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?"; }

function extractAccepts(challenge) {
  if (!challenge) return [];
  if (Array.isArray(challenge.accepts)) return challenge.accepts;
  if (challenge.accepts && typeof challenge.accepts === "object") return Object.values(challenge.accepts);
  return [];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts_json = opts.json;
  if (!opts.url) { console.error(USAGE); process.exit(1); }
  if (!/^https?:\/\//i.test(opts.url)) die(`URL must start with http(s):// — got: ${opts.url}`);
  return run(opts);
}

async function run(opts) {
  const method = opts.method || (opts.data !== null ? "POST" : "GET");
  const headers = {};
  for (const h of opts.headers) {
    const idx = h.indexOf(":");
    if (idx === -1) die(`Bad header (want "Name: value"): ${h}`);
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  let body;
  if (opts.data !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = opts.data;
    if (typeof body === "string") { try { JSON.parse(body); } catch { die(`--data is not valid JSON: ${body.slice(0, 60)}`); } }
  }

  const t0 = Date.now();
  if (!opts.json) console.error(`${c("2", `→ ${method} ${opts.url}`)}`);

  // --- Step 1: plain fetch. Free endpoints are done right here. ---
  let res;
  try {
    res = await fetch(opts.url, { method, headers, body });
  } catch (e) {
    die(`Network error: ${e.cause?.code || e.message}`);
  }

  if (res.status !== 402) {
    const text = await res.text();
    if (!opts.json) {
      const tag = res.ok ? c("32", `${res.status} OK`) : c("31", `${res.status}`);
      console.error(`${tag} in ${Date.now() - t0}ms — no payment needed`);
    }
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    process.exit(res.ok ? 0 : 2);
  }

  // --- Step 2: decode the 402 challenge (v2 header, v1 body fallback) ---
  const challenge = decodeChallenge(res.headers.get("payment-required")) ||
    await res.text().then((t) => { try { return JSON.parse(t); } catch { return null; } });
  const accepts = extractAccepts(challenge);
  const first = accepts[0] || {};
  const price = priceFromAccept(first);

  if (!opts.json) {
    console.error(c("33", `402 Payment Required — $${price ?? "?"} ${displayAsset(first)} on ${first.network ?? opts.network}`));
  }
  if (!opts.pay) {
    process.stdout.write(JSON.stringify({ challenge }, null, 2) + "\n");
    process.exit(3);
  }
  if (price !== null && price > opts.maxValue) {
    die(`Challenge price $${price} exceeds --max-value $${opts.maxValue}. Refusing to pay. Use --max-value to raise the cap.`);
  }

  // --- Step 3: wallet from env (never argv) ---
  const pk = process.env[opts.keyEnv];
  if (!pk) {
    die(`No wallet found. Set ${opts.keyEnv} to your EVM private key:\n  export ${opts.keyEnv}=0x...\n(The key signs the payment locally; it is never sent anywhere.)`);
  }

  const account = privateKeyToAccount(pk.trim().startsWith("0x") ? pk.trim() : `0x${pk.trim()}`);
  if (!opts.json) {
    console.error(c("2", `Signing with ${shortAddr(account.address)} — network ${opts.network}`));
    console.error(c("2", "Paying…"));
  }

  // --- Step 4: sign + retry via the x402 v2 stack ---
  const client = new x402Client();
  client.register(opts.network, new ExactEvmScheme(account));
  const fetchWithPay = wrapFetchWithPayment(globalThis.fetch.bind(globalThis), client);

  let paid;
  try {
    paid = await fetchWithPay(opts.url, { method, headers, body });
  } catch (e) {
    die(`Payment attempt failed: ${e.message}`);
  }
  const ms = Date.now() - t0;

  // --- Step 5: settlement receipt ---
  const receiptRaw = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
  let receipt = null;
  if (receiptRaw) {
    try { receipt = JSON.parse(Buffer.from(receiptRaw, "base64").toString("utf8")); }
    catch { try { receipt = JSON.parse(receiptRaw); } catch { receipt = { raw: receiptRaw }; } }
  }

  const text = await paid.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text body */ }

  if (!opts.json) {
    if (paid.ok) {
      const tx = receipt?.transaction || receipt?.transactionHash || receipt?.txHash || receipt?.tx || null;
      console.error(c("32", `✓ Paid $${price ?? ""} — settled in ${ms}ms`));
      if (tx) console.error(c("2", `  settlement tx: ${tx}  (verify: basescan.org/tx/${tx})`));
      else if (receipt) console.error(c("2", `  receipt: ${JSON.stringify(receipt).slice(0, 200)}`));
    } else {
      console.error(c("31", `✗ After payment: HTTP ${paid.status} in ${ms}ms`));
    }
  } else {
    // --json: single envelope on stdout, machine-pipeable
    process.stdout.write(JSON.stringify({
      status: paid.status,
      settlement: receipt,
      response: json ?? text,
    }, null, 2) + "\n");
    process.exit(paid.ok ? 0 : 2);
  }

  if (!opts.json) {
    if (json) console.log(JSON.stringify(json, null, 2));
    else process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
  }
  process.exit(paid.ok ? 0 : 2);
}

main().catch((e) => die(e?.stack || String(e)));
