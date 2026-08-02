#!/usr/bin/env node
// =============================================================================
// openrouter-image — OpenRouter Images / chat image generation CLI
// =============================================================================
// Ported from bento-portfolio with Recraft img2img --strength support.
//
// USAGE
//   node scripts/openrouter-image.mjs --prompt "..." -o tmp/out.png
//   node scripts/openrouter-image.mjs --model recraft --raw \
//     --reference assets/logo-raw.png --strength 0.3 \
//     -f assets/prompts/logo.md -o tmp/logo.svg
//
// Recraft strength (when a --reference is present): 0 ≈ almost identical to the
// source, 1 ≈ minimal similarity. Typical cleanup/straighten: 0.25–0.4.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MODEL_ALIASES = {
  gpt: "openai/gpt-5.4-image-2",
  "gpt-image-2": "openai/gpt-5.4-image-2",
  banana: "google/gemini-3-pro-image",
  "banana-pro": "google/gemini-3-pro-image",
  "banana-2": "google/gemini-3.1-flash-image",
  seedream: "bytedance-seed/seedream-4.5",
  "seedream-4.5": "bytedance-seed/seedream-4.5",
  seedance: "bytedance-seed/seedream-4.5",
  "seedance-4.5": "bytedance-seed/seedream-4.5",
  recraft: "recraft/recraft-v4.1-pro-vector",
  "recraft-pro": "recraft/recraft-v4.1-pro-vector",
  "recraft-vector": "recraft/recraft-v4.1-vector",
  "recraft-v4.1-vector": "recraft/recraft-v4.1-vector",
};

const IMAGE_API_MODELS = new Set([
  "bytedance-seed/seedream-4.5",
  "recraft/recraft-v4.1-pro-vector",
  "recraft/recraft-v4.1-vector",
  "recraft/recraft-v4-pro-vector",
  "recraft/recraft-v4-vector",
  "sourceful/riverflow-v2.5-pro",
  "black-forest-labs/flux.2-max",
  "google/gemini-3-pro-image",
]);

const IMAGE_API_RESOLUTION_MODELS = new Set([
  "bytedance-seed/seedream-4.5",
  "sourceful/riverflow-v2.5-pro",
  "google/gemini-3-pro-image",
]);

const IMAGE_API_ASPECT_RATIO_MODELS = new Set([
  "bytedance-seed/seedream-4.5",
  "recraft/recraft-v4.1-pro-vector",
  "recraft/recraft-v4.1-vector",
  "recraft/recraft-v4-pro-vector",
  "recraft/recraft-v4-vector",
  "google/gemini-3-pro-image",
]);

const RECRAFT_MODELS = new Set([
  "recraft/recraft-v4.1-pro-vector",
  "recraft/recraft-v4.1-vector",
  "recraft/recraft-v4-pro-vector",
  "recraft/recraft-v4-vector",
]);

const DEFAULT_MODEL = MODEL_ALIASES["banana-2"];

// Optional doodle style for portfolio-style line art; logo work should use --raw.
const DOODLE_STYLE = `Hand-drawn doodle in the style of a confident fineliner sketch: pure black line art on a pure white background, nothing else in the frame. One uniform bold line weight throughout, with a slight natural hand wobble. Flat 2D, no shading, no hatching, no gray tones, no gradients, no texture, no shadows. Simple closed shapes that read clearly as a silhouette. Generous empty white margin around the object. Pure black ink only, no gray pixels.

Subject: `;

function loadEnvFile(fileName) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key]) continue;

    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "").replace(/\\n/g, "\n");
  }
}

function parseArgs(argv) {
  const args = {
    model: process.env.OPENROUTER_IMAGE_MODEL || DEFAULT_MODEL,
    raw: false,
    resolution: "2K",
    aspectRatio: "1:1",
    aspectRatioExplicit: false,
    maxTokens: null,
    n: 1,
    strength: null,
    references: [],
  };

  // pnpm/npm often forward a literal "--" separator into argv.
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;

  for (let index = 0; index < tokens.length; index += 1) {
    const arg = tokens[index];
    const next = tokens[index + 1];

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--list-models") args.listModels = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--raw") args.raw = true;
    else if (arg === "--prompt" || arg === "-p") {
      args.prompt = next;
      index += 1;
    } else if (arg === "--prompt-file" || arg === "-f") {
      args.promptFile = next;
      index += 1;
    } else if (arg === "--model" || arg === "-m") {
      args.model = next;
      index += 1;
    } else if (arg === "--out" || arg === "-o") {
      args.out = next;
      index += 1;
    } else if (arg === "--resolution") {
      args.resolution = next;
      index += 1;
    } else if (arg === "--aspect-ratio") {
      args.aspectRatio = next;
      args.aspectRatioExplicit = true;
      index += 1;
    } else if (arg === "--n") {
      args.n = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--max-tokens") {
      args.maxTokens = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--strength") {
      args.strength = Number.parseFloat(next);
      index += 1;
    } else if (arg === "--reference") {
      args.references.push(next);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.model = MODEL_ALIASES[args.model] || args.model;
  if (!Number.isInteger(args.n) || args.n < 1 || args.n > 10) {
    throw new Error("--n must be an integer from 1 to 10.");
  }
  if (args.maxTokens !== null && (!Number.isInteger(args.maxTokens) || args.maxTokens < 1)) {
    throw new Error("--max-tokens must be a positive integer.");
  }
  if (
    args.strength !== null &&
    (!Number.isFinite(args.strength) || args.strength < 0 || args.strength > 1)
  ) {
    throw new Error("--strength must be a number in [0, 1] (0 ≈ identical, 1 ≈ free).");
  }
  if (args.strength !== null && args.references.length === 0) {
    throw new Error("--strength requires at least one --reference (img2img).");
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/openrouter-image.mjs --prompt "..." -o tmp/out.png
  node scripts/openrouter-image.mjs --model recraft --raw \\
    --reference assets/jts-front-logo-raw.png --strength 0.3 \\
    -f assets/prompts/jts-front-logo-svg.md -o tmp/jts-front-logo.svg

Options:
  --model, -m        gpt-image-2 | banana-2 | banana-pro | seedream-4.5 |
                     recraft (pro-vector) | recraft-vector | exact OpenRouter id
                     default: ${DEFAULT_MODEL}
  --prompt, -p       Prompt text inline.
  --prompt-file, -f  Read prompt from a file instead.
  --out, -o          Output path (required). Extra images get -2, -3 suffixes.
                     Extension is rewritten to the actual media type (svg/png/…).
  --aspect-ratio     For compatible Images API models. Default: 1:1.
  --resolution       Images API resolution (seedream etc). Default: 2K.
  --n                Number of images (Recraft 1–6). Default: 1.
  --strength         Recraft img2img strength in [0, 1]. Requires --reference.
  --max-tokens       Optional Chat Completions output cap.
  --reference        Local path, HTTP URL, or data URL. Repeatable (Recraft: 1).
  --raw              Do not prepend the doodle style block.
  --dry-run          Print request summary without calling OpenRouter.
  --list-models      Show OpenRouter models that can output images.`);
}

async function listModels() {
  const response = await fetch("https://openrouter.ai/api/v1/images/models");
  if (!response.ok) {
    throw new Error(`OpenRouter image models request failed: ${response.status}`);
  }

  const json = await response.json();
  const rows = (json.data || []).map((model) => ({
    id: model.id,
    name: model.name,
    input: model.architecture?.input_modalities,
    refs: model.supported_parameters?.input_references ?? null,
  }));

  console.log(JSON.stringify(rows, null, 2));
}

function outPathForIndex(outPath, index) {
  if (index === 0) return outPath;
  return outPath.replace(/(\.[a-z0-9]+)?$/i, (ext) => `-${index + 1}${ext}`);
}

function imageExtension(bytes, mediaType = "") {
  if (mediaType === "image/svg+xml") return "svg";
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF") return "webp";
  const head = bytes.subarray(0, 256).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "svg";
  return "bin";
}

function withActualExtension(outPath, extension) {
  return outPath.replace(/(\.[a-z0-9]+)?$/i, `.${extension}`);
}

function referenceToDataUrl(reference) {
  if (/^(data:image\/|https?:\/\/)/i.test(reference)) return reference;

  const path = resolve(process.cwd(), reference);
  if (!existsSync(path)) throw new Error(`Reference image not found: ${reference}`);

  const bytes = readFileSync(path);
  const extension = imageExtension(bytes);
  const mediaType =
    extension === "jpg"
      ? "image/jpeg"
      : extension === "svg"
        ? "image/svg+xml"
        : extension === "bin"
          ? null
          : `image/${extension}`;
  if (!mediaType) throw new Error(`Unsupported reference image format: ${reference}`);

  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

async function imageItemToBuffer(item) {
  const dataUrl = item?.image_url?.url ?? item?.url ?? "";
  const base64 = item?.b64_json;

  if (base64) return Buffer.from(base64, "base64");

  const match = dataUrl.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
  if (match) return Buffer.from(match[2], "base64");

  if (/^https?:\/\//i.test(dataUrl)) {
    const response = await fetch(dataUrl);
    if (!response.ok) {
      throw new Error(`Image URL fetch failed: ${response.status} ${dataUrl}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error("Image response item had no b64_json, data URL, or fetchable URL.");
}

async function writeImageApiOutputs(json, outPath) {
  const images = json.data ?? [];
  if (!images.length) {
    throw new Error(
      `OpenRouter Images API response had no images:\n${JSON.stringify(json, null, 2)}`,
    );
  }

  for (const [index, item] of images.entries()) {
    const bytes = await imageItemToBuffer(item);
    const extension = imageExtension(bytes, item?.media_type);
    const targetPath = withActualExtension(outPathForIndex(outPath, index), extension);
    const target = resolve(process.cwd(), targetPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    console.log(`Wrote ${targetPath}`);
  }

  if (json.usage) {
    console.log(`\nUsage: ${JSON.stringify(json.usage)}`);
  }
}

function applyRecraftStrength(requestBody, args) {
  if (args.strength === null || !RECRAFT_MODELS.has(args.model)) return;

  // OpenRouter Recraft pages document image_config.strength; native Recraft
  // imageToImage takes top-level strength. Send both so either adapter wins.
  requestBody.image_config = {
    ...(requestBody.image_config ?? {}),
    strength: args.strength,
  };
  requestBody.provider = {
    ...(requestBody.provider ?? {}),
    options: {
      ...(requestBody.provider?.options ?? {}),
      recraft: {
        ...(requestBody.provider?.options?.recraft ?? {}),
        strength: args.strength,
      },
    },
  };
}

async function runImagesApi({ apiKey, args, prompt }) {
  const requestBody = {
    model: args.model,
    prompt,
    n: args.n,
  };
  if (IMAGE_API_RESOLUTION_MODELS.has(args.model)) {
    requestBody.resolution = args.resolution;
  }
  if (IMAGE_API_ASPECT_RATIO_MODELS.has(args.model)) {
    requestBody.aspect_ratio = args.aspectRatio;
  }
  if (RECRAFT_MODELS.has(args.model)) {
    requestBody.output_format = "svg";
  }
  if (args.references.length) {
    requestBody.input_references = args.references.map((reference) => ({
      type: "image_url",
      image_url: { url: referenceToDataUrl(reference) },
    }));
  }
  applyRecraftStrength(requestBody, args);

  if (args.dryRun) {
    const dryBody = structuredClone(requestBody);
    if (dryBody.input_references) {
      dryBody.input_references = dryBody.input_references.map((ref, index) => ({
        ...ref,
        image_url: {
          url: `[data-url omitted, reference ${index + 1}: ${args.references[index]}]`,
        },
      }));
    }
    console.log(
      JSON.stringify(
        {
          endpoint: "images",
          styleBlock: !args.raw,
          request: dryBody,
        },
        null,
        2,
      ),
    );
    return;
  }

  const response = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost:5173",
      "X-Title": process.env.OPENROUTER_APP_NAME || "join-the-six",
    },
    body: JSON.stringify(requestBody),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(
      `OpenRouter Images API request failed: ${response.status}\n${JSON.stringify(json, null, 2)}`,
    );
  }

  await writeImageApiOutputs(json, args.out);
}

async function runChatCompletionsApi({ apiKey, args, prompt }) {
  const messageContent = args.references.length
    ? [
        { type: "text", text: prompt },
        ...args.references.map((reference) => ({
          type: "image_url",
          image_url: { url: referenceToDataUrl(reference) },
        })),
      ]
    : prompt;
  const requestBody = {
    model: args.model,
    messages: [{ role: "user", content: messageContent }],
    modalities: ["image", "text"],
  };
  if (args.maxTokens !== null) {
    requestBody.max_tokens = args.maxTokens;
  }
  if (args.aspectRatioExplicit) {
    requestBody.image_config = { aspect_ratio: args.aspectRatio };
  }

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          endpoint: "chat/completions",
          model: args.model,
          out: args.out,
          promptCharacters: prompt.length,
          styleBlock: !args.raw,
          aspectRatio: args.aspectRatioExplicit ? args.aspectRatio : null,
          references: args.references,
        },
        null,
        2,
      ),
    );
    return;
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost:5173",
      "X-Title": process.env.OPENROUTER_APP_NAME || "join-the-six",
    },
    body: JSON.stringify(requestBody),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(
      `OpenRouter request failed: ${response.status}\n${JSON.stringify(json, null, 2)}`,
    );
  }

  const message = json.choices?.[0]?.message;
  const images = message?.images ?? [];
  if (!images.length) {
    throw new Error(
      `OpenRouter response had no images. Message text:\n${message?.content ?? "(empty)"}`,
    );
  }

  for (const [index, image] of images.entries()) {
    const url = image?.image_url?.url ?? "";
    const match = url.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
    if (!match) {
      throw new Error(`Image ${index + 1} was not a base64 data URL.`);
    }

    const bytes = Buffer.from(match[2], "base64");
    const extension = imageExtension(bytes, `image/${match[1]}`);
    const targetPath = withActualExtension(outPathForIndex(args.out, index), extension);
    const target = resolve(process.cwd(), targetPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    console.log(`Wrote ${targetPath}`);
  }

  if (typeof message?.content === "string" && message.content.trim()) {
    console.log(`\nModel note: ${message.content.trim()}`);
  }
}

async function main() {
  loadEnvFile(".env");
  loadEnvFile(".env.local");

  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.listModels) {
    await listModels();
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing. Put it in .env or export it.");
  }

  let prompt = args.prompt ?? (args.promptFile
    ? readFileSync(resolve(process.cwd(), args.promptFile), "utf8")
    : "");
  prompt = prompt.trim();
  if (!prompt) {
    throw new Error("No prompt provided. Use --prompt or --prompt-file.");
  }
  if (!args.out) {
    throw new Error("No output path provided. Use --out, e.g. -o tmp/name.svg");
  }

  const fullPrompt = args.raw ? prompt : `${DOODLE_STYLE}${prompt}`;
  const runner = IMAGE_API_MODELS.has(args.model) ? runImagesApi : runChatCompletionsApi;
  await runner({ apiKey, args, prompt: fullPrompt });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
