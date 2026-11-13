# raen-call

**curl for paid APIs.** One command that fetches an x402-paid endpoint — handles the HTTP 402 challenge, signs with your local wallet, pays USDC on Base, retries, and prints the answer plus the on-chain settlement receipt.

No SDK code, no payment plumbing. Just:

```bash
raen-call https://api.example.com/api/lookup -d '{"query":"FCRA 605"}'
```

If the endpoint is free, it behaves exactly like `curl`. If it answers `402 Payment Required`, it shows you the price **before** paying — and refuses anything above your cap.

## Install

```bash
npm install -g raen-call
```

Requires Node ≥ 18. No accounts, no API keys, no facilitator signup.

## Usage

```
raen-call <url> [options]

  -d, --data <json>       Request body (JSON string). Implies POST unless --method given.
  -X, --method <method>   HTTP method (default: POST if -d given, else GET)
  -H, --header <h>        Extra header "Name: value" (repeatable)
  --key-env <name>        Env var holding the wallet private key (default: X402_PRIVATE_KEY)
  --network <caip2>       Signer network (default: eip155:8453 = Base mainnet)
  --max-value <usd>       Safety cap: refuse challenges above this USD price (default: 1.00)
  --no-pay                Fetch only; print the 402 challenge, do not pay
  --json                  Print only a machine-pipeable envelope
```

## Wallet

The private key comes from an **environment variable, never argv** (argv leaks into shell history and process lists):

```bash
export X402_PRIVATE_KEY=0x...
```

The key signs the payment locally. It is never sent anywhere.

## Examples

Inspect the price of a paid endpoint without paying:

```bash
raen-call https://royal-ruby-x402.fly.dev/api/lookup?q=FCRA+605 --no-pay
# → 402 Payment Required — $0.05 USDC on Base mainnet
```

Pay and get the answer + settlement receipt:

```bash
raen-call https://royal-ruby-x402.fly.dev/api/lookup -d '{"q":"FCRA 605"}' --max-value 0.10
# → ✓ Paid $0.05 — settled in 1841ms
#     settlement tx: 0x…  (verify: basescan.org/tx/0x…)
```

Machine-pipeable output:

```bash
raen-call https://api.example.com/api/ticker?symbol=AAPL --json | jq .response
```

## Safety model

- **Price cap by default** (`--max-value 1.00`): a malicious or buggy challenge above the cap is refused, not paid.
- **`--no-pay` first**: always inspect a new endpoint's price before paying.
- **Key never on argv**: env var only, so nothing lands in shell history.
- **Exit codes**: `0` success · `2` HTTP/failure after attempt · `3` printed 402 challenge without paying.

## How it works

1. Plain `fetch` — free endpoints return immediately.
2. On `402`, decode the challenge (x402 v2 base64 `PAYMENT-REQUIRED` header, v1 JSON body fallback).
3. Show the price; enforce the cap.
4. Sign locally with viem and pay via the x402 exact-EVM scheme (`@x402/evm`), retry through `@x402/fetch`.
5. Decode the `PAYMENT-RESPONSE` header into a settlement receipt (transaction hash on Base).

Built on the [x402 protocol](https://www.x402.org) — HTTP-native payments for AI agents.

## License

MIT
