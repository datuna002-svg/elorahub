# Running your own model for Elora — no per-token fees to any AI company

This is the setup for a self-hosted, code-focused open-weight model,
replacing the Claude API version. Once this is running, `api/chat.js` calls
*your* GPU instead of Anthropic's servers.

## The model

**Qwen2.5-Coder-14B-Instruct** — an open-weight model specifically trained
for programming: writing code, debugging, explaining unfamiliar codebases,
and following instructions in technical contexts. It fits on a single
80GB GPU with plenty of headroom. If you want to start smaller and cheaper,
**Qwen2.5-Coder-7B-Instruct** runs on a much smaller (and cheaper) GPU at
some cost to quality — a reasonable way to test the whole pipeline before
committing to the bigger model.

Both are free to use — "open-weight" means the model file itself has no
license fee. What you pay for is the GPU time to run it.

## Why serverless, not a dedicated server

A dedicated GPU bills whether anyone's chatting or not — roughly $1,000+/month
for an always-on A100, regardless of traffic. A **serverless** GPU endpoint
scales to zero and only bills while it's actively generating a reply, which
is the sane choice until you have sustained, predictable volume. Everything
below uses RunPod's serverless product for that reason.

## Setup

1. **Create a RunPod account** at runpod.io and add a payment method — this
   is billed by GPU-second used, not a subscription.

2. **Deploy a Serverless vLLM endpoint.** RunPod maintains a ready-made
   vLLM worker template built for exactly this — search "vLLM" in RunPod's
   Serverless quick-deploy templates. When configuring it:
   - Set the model to `Qwen/Qwen2.5-Coder-14B-Instruct` (or the 7B version)
   - Choose a GPU with enough VRAM (80GB card for the 14B model; a 24GB
     card is enough for the 7B model)
   - Leave it on "scale to zero" so idle time costs nothing
   - RunPod's template list and exact configuration options change over
     time — their own docs at docs.runpod.io are the source of truth if
     anything here looks different when you set this up.

3. **Get your endpoint URL and API key.** RunPod gives you an endpoint ID;
   the OpenAI-compatible chat URL is typically:
   ```
   https://api.runpod.ai/v2/<your-endpoint-id>/openai/v1/chat/completions
   ```
   and an API key from RunPod's account settings to authenticate requests.

4. **Set environment variables in Vercel** (Settings → Environment Variables):
   ```
   LLM_ENDPOINT_URL=https://api.runpod.ai/v2/<your-endpoint-id>/openai/v1/chat/completions
   LLM_API_KEY=<your RunPod API key>
   LLM_MODEL=Qwen/Qwen2.5-Coder-14B-Instruct
   ```

5. **Redeploy.** The first request after idle time will be slower (the GPU
   has to "cold start" and load the model into memory — this can be
   10–60 seconds depending on model size). Subsequent requests while the
   endpoint stays warm are much faster. This cold-start delay is the main
   real trade-off of scale-to-zero serverless versus a dedicated server.

## What changed from the Claude API version

- No `@anthropic-ai/sdk` dependency — this calls your endpoint with plain
  `fetch`, since vLLM speaks the same request format either way.
- The system prompt now pushes Elora to lead with coding strength — see the
  `SYSTEM_PROMPT` constant in `chat.js` if you want to rebalance how
  code-focused versus general-purpose she feels.
- Same usage limits and validation as before — those aren't tied to which
  model answers the question.

## Being realistic about the trade-off

A 7B–14B open model, even one built for code, will not match Sonnet or
Opus-level reasoning on genuinely hard problems. What you get instead:
zero per-token dependency on any AI company, full control over the model,
and the option to fine-tune it on your own code/data later for a more
distinct voice. That's a real trade — worth confirming it's the one you
want for launch, versus starting on the Claude API to prove the product
works and moving to self-hosted once you have real usage data to size the
GPU correctly.
