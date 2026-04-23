# AI Provider Keys

MODLai uses 4 AI services. Only **Anthropic is required** (for prompt refinement, comparison, descriptions). The other three are image models — enable as many as you want.

## Anthropic (Claude) — required

Used for: prompt refinement, result comparison, product descriptions, edit reasoning.

1. Go to https://console.anthropic.com/settings/keys
2. **Create Key** → copy the `sk-ant-...` string
3. Add to `.env.local`:
   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   ```

Pricing: Claude Sonnet 4.5 is the default. Roughly $3/M input tokens + $15/M output. Each description ≈ 2¢, each comparison ≈ 1¢.

## Google Gemini — Nano Banana

Used for: Nano Banana image generation + editing. Recommended if you do any editing workflow — it's the best at preserving source details.

1. Go to https://aistudio.google.com/apikey
2. **Create API key** (in a Google Cloud project)
3. Add to `.env.local`:
   ```env
   GOOGLE_API_KEY=AIza...
   ```

Pricing: ~$0.039 per 1024×1024 image.

## OpenAI — gpt-image-1

Used for: creative generation from text, complex prompts.

1. Go to https://platform.openai.com/api-keys
2. **Create new secret key** → copy
3. Add to `.env.local`:
   ```env
   OPENAI_API_KEY=sk-proj-...
   ```

Pricing: $0.042 to $0.25 per image depending on size/quality.

**Note:** `gpt-image-1` requires an organization that's been verified. If you get 403 errors, complete verification at https://platform.openai.com/settings/organization/general.

## Stability AI — Stable Image Ultra

Used for: cost-efficient bulk generation, photorealism.

1. Go to https://platform.stability.ai/account/keys
2. **Create API Key** → copy
3. Add to `.env.local`:
   ```env
   STABILITY_API_KEY=sk-...
   ```

Pricing: $0.04–$0.08 per image. Cheapest option for high volume.

## What if I skip some?

The backend will return a friendly 500 error with `missing_env` code if the user tries to use a model whose key isn't configured. The frontend can handle this by showing the error inline.

The **Anthropic key is the only one that's truly required** — without it, prompt refinement, comparison, and descriptions break. Image generation works with just one provider.

## Cost sanity check (typical month, small brand)

| Item | Volume | Cost |
|---|---|---|
| 500 images (all 3 models) | 1500 API calls | ~$60 |
| 200 descriptions | 200 Claude vision calls | ~$4 |
| 50 edits | 50 Nano Banana calls | ~$2 |
| **Total** | | **~$66/mo** |

If you charge users in credits and the packages (`$9/500cr`, `$39/2500cr`, `$129/10000cr`) are set correctly, you have ~60% margin.
