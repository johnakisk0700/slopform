#!/usr/bin/env node
// =============================================================================
// cut-doodle — turn a raw model render into a transparent, web-ready doodle
// =============================================================================
//
// WHAT IT DOES
//   A Seedream/Banana render is an opaque square: the drawn object sits on a
//   flat solid background (plum, maroon, cream…). This tool removes that flat
//   background so the object "floats", then normalises the file for use as a
//   Mermaid/diagram image node:
//
//     raw render (object on flat bg)  ──►  transparent PNG, resized, [packed]
//
//   It is the cutting stage of the Mermaid icon pipeline. Generation lives in
//   `bun run design:icon`; Mermaid consumes the resulting PNG directly in the
//   browser, so there is deliberately no diagram build stage.
//
// WHY IMAGEMAGICK (and not sharp / jimp)
//   Background removal here is a SEEDED FLOOD FILL, not a colour delete:
//   we fill inward from the image border and stop at the object's ink outline.
//   That is the only way to key a flat background WITHOUT eating same-coloured
//   fills inside the object (a global `-fuzz NN% -transparent cream` would
//   also erase the object's cream body). ImageMagick's
//   `-draw 'color x,y floodfill'` is the proven primitive for this; Node's
//   raster libs (sharp, jimp) have no good seeded flood fill. So we orchestrate
//   the ImageMagick CLI from Node — Node owns the ergonomics (args, defaults,
//   dry-run, validation), ImageMagick owns the pixels.
//
//   Requires the `magick` binary on PATH (`brew install imagemagick`).
//   Docs:
//     - floodfill / -draw:   https://imagemagick.org/script/magick-draw.php
//     - -fuzz (tolerance):   https://imagemagick.org/script/command-line-options.php#fuzz
//     - -trim / +repage:     https://imagemagick.org/script/command-line-options.php#trim
//     - PNG32 (force RGBA):  https://imagemagick.org/script/formats.php
//
// USAGE
//   node scripts/cut-doodle.mjs <src> <out> [options]
//   node scripts/cut-doodle.mjs raw.jpg public/work/foo-transparent.png
//   node scripts/cut-doodle.mjs raw.jpg out.png --fuzz 25 --size 768 --pack
//   node scripts/cut-doodle.mjs raw.jpg out.png --dry-run   # print the magick cmd, run nothing
//
// OPTIONS
//   --fuzz <pct>     Colour tolerance for the flood fill, 0–100 (default 20).
//                    Raise if bg survives; lower if it eats the object's edge.
//   --size <px>      Square resize of the final PNG (default 768). --size 0 skips.
//   --trim           Crop away the fully-transparent margin after keying, so the
//                    object fills the frame (default off — keeps the render's margin).
//   --pack           Alpha-trim, resize the visible art to --fill of the square,
//                    then place it on a transparent --size canvas with a stable
//                    --bottom-pad. This is the Mermaid-node default: labels are
//                    positioned after the full PNG canvas, not after visible pixels.
//   --fill <pct>     Longest visible-art dimension as a percentage of --size when
//                    --pack is enabled (default 88).
//   --bottom-pad <px> Transparent pixels below packed art (default 24).
//   --seeds <list>   Override flood-fill seed points, e.g. "0,0;100,100".
//                    Default = the 4 corners + 4 edge midpoints (computed per image).
//   --dry-run        Print the ImageMagick command that WOULD run, then exit.
//   --verbose        Print the command before running it.
//   --help           This help.
//
// DEBUGGING
//   `--dry-run` prints the exact `magick` invocation — copy/paste it, tweak a
//   `-draw` seed or `-fuzz`, and re-run by hand. Every step below is a small
//   named function, so you can also import and unit-test them in isolation.
// =============================================================================

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Tunables — one place to change defaults. */
const DEFAULTS = Object.freeze({
  fuzz: 20, // percent colour tolerance for the flood fill
  size: 768, // final square px; 0 = no resize
  trim: false, // crop the transparent margin after keying
  pack: false, // alpha-aware square repacking for Mermaid image nodes
  fill: 88, // longest alpha-bounds dimension as % of the final square
  bottomPad: 24, // transparent pixels between visible art and canvas bottom
});

// --- tiny arg parser (keeps main() readable; no dependency needed) -----------

/**
 * Parse argv into positionals + options. Deliberately minimal — a real flag
 * library would be overkill for six options and would hide what's happening.
 * @param {string[]} argv  process.argv.slice(2)
 */
function parseArgs(argv) {
  const opts = {
    ...DEFAULTS,
    seeds: null,
    dryRun: false,
    verbose: false,
    help: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "--trim":
        opts.trim = true;
        break;
      case "--pack":
        opts.pack = true;
        break;
      case "--fuzz":
        opts.fuzz = Number(argv[(i += 1)]);
        break;
      case "--size":
        opts.size = Number(argv[(i += 1)]);
        break;
      case "--fill":
        opts.fill = Number(argv[(i += 1)]);
        break;
      case "--bottom-pad":
        opts.bottomPad = Number(argv[(i += 1)]);
        break;
      case "--seeds":
        opts.seeds = argv[(i += 1)];
        break;
      default:
        if (arg.startsWith("--"))
          throw new UsageError(`Unknown option: ${arg}`);
        positionals.push(arg);
    }
  }
  const [src, out] = positionals;
  return { src, out, ...opts };
}

/** Thrown for bad input; main() turns it into a clean message + exit 2. */
class UsageError extends Error {}

// --- ImageMagick adapter (the only place that knows about `magick`) ----------

/** Fail early with an actionable message if ImageMagick is missing. */
function assertMagickAvailable() {
  try {
    execFileSync("magick", ["-version"], { stdio: "ignore" });
  } catch {
    throw new UsageError(
      "ImageMagick `magick` not found on PATH. Install it: brew install imagemagick",
    );
  }
}

/** Read pixel dimensions of an image via `magick identify`. */
function imageSize(path) {
  const out = execFileSync("magick", ["identify", "-format", "%w %h", path], {
    encoding: "utf8",
  });
  const [w, h] = out.trim().split(/\s+/).map(Number);
  if (!w || !h) throw new UsageError(`Could not read image size of ${path}`);
  return { w, h };
}

/**
 * Seed points for the flood fill: the 4 corners + 4 edge midpoints. Filling
 * from several border points (not just one corner) covers backgrounds the
 * object touches on one side, and costs nothing.
 * @returns {string[]} e.g. ["0,0", "1023,0", ...]
 */
function borderSeeds(w, h) {
  const x1 = w - 1;
  const y1 = h - 1;
  const mx = Math.floor(w / 2);
  const my = Math.floor(h / 2);
  return [
    `0,0`,
    `${x1},0`,
    `0,${y1}`,
    `${x1},${y1}`,
    `${mx},0`,
    `0,${my}`,
    `${x1},${my}`,
    `${mx},${y1}`,
  ];
}

/**
 * Build the ImageMagick argument vector. Pure function of its inputs — no I/O —
 * so it is trivial to snapshot-test and to print in --dry-run.
 */
function buildMagickArgs({
  src,
  out,
  fuzz,
  size,
  trim,
  pack,
  fill,
  bottomPad,
  seeds,
}) {
  const args = [src, "-alpha", "set", "-fuzz", `${fuzz}%`, "-fill", "none"];
  for (const seed of seeds) args.push("-draw", `color ${seed} floodfill`);
  if (pack) {
    const artSize = Math.round((size * fill) / 100);
    const contentHeight = size - bottomPad;
    args.push(
      "-trim",
      "+repage",
      "-resize",
      `${artSize}x${artSize}`,
      "-background",
      "none",
      "-gravity",
      "south",
      "-extent",
      `${size}x${contentHeight}`,
      "-gravity",
      "north",
      "-extent",
      `${size}x${size}`,
    );
  } else {
    if (trim) args.push("-trim", "+repage");
    if (size > 0) args.push("-resize", `${size}x${size}`);
  }
  args.push(`PNG32:${out}`); // PNG32 = force a full RGBA png (keeps the alpha we just cut)
  return args;
}

/** Quote an arg for human-readable copy/paste of the command. */
const shellQuote = (a) =>
  /[^\w./:%-]/.test(a) ? `'${a.replaceAll("'", "'\\''")}'` : a;
const renderCommand = (args) => ["magick", ...args].map(shellQuote).join(" ");

// --- orchestration -----------------------------------------------------------

/**
 * Cut one doodle. Returns the resolved output path.
 * @param {object} cfg  parsed args (src, out, fuzz, size, trim, seeds, dryRun, verbose)
 */
function cutDoodle(cfg) {
  if (!cfg.src || !cfg.out)
    throw new UsageError("Expected: <src> <out> [options]");

  const src = resolve(process.cwd(), cfg.src);
  const out = resolve(process.cwd(), cfg.out);
  if (!existsSync(src)) throw new UsageError(`Source not found: ${cfg.src}`);
  if (!Number.isFinite(cfg.fuzz) || cfg.fuzz < 0 || cfg.fuzz > 100)
    throw new UsageError(`--fuzz must be 0–100, got ${cfg.fuzz}`);
  if (!Number.isInteger(cfg.size) || cfg.size < 0)
    throw new UsageError(
      `--size must be a non-negative integer, got ${cfg.size}`,
    );
  if (!Number.isFinite(cfg.fill) || cfg.fill <= 0 || cfg.fill > 100)
    throw new UsageError(`--fill must be > 0 and <= 100, got ${cfg.fill}`);
  if (!Number.isInteger(cfg.bottomPad) || cfg.bottomPad < 0)
    throw new UsageError(
      `--bottom-pad must be a non-negative integer, got ${cfg.bottomPad}`,
    );
  if (cfg.pack && cfg.size === 0)
    throw new UsageError("--pack requires --size greater than 0.");
  if (cfg.pack && cfg.trim)
    throw new UsageError("Use either --trim or --pack, not both.");
  if (cfg.pack && cfg.bottomPad >= cfg.size)
    throw new UsageError("--bottom-pad must be smaller than --size.");
  if (
    cfg.pack &&
    Math.round((cfg.size * cfg.fill) / 100) > cfg.size - cfg.bottomPad
  )
    throw new UsageError(
      "--fill is too large for the requested --bottom-pad; reduce one of them.",
    );

  assertMagickAvailable();

  const { w, h } = imageSize(src);
  const seeds = cfg.seeds
    ? cfg.seeds.split(";").map((s) => s.trim())
    : borderSeeds(w, h);
  const args = buildMagickArgs({
    src,
    out,
    fuzz: cfg.fuzz,
    size: cfg.size,
    trim: cfg.trim,
    pack: cfg.pack,
    fill: cfg.fill,
    bottomPad: cfg.bottomPad,
    seeds,
  });

  if (cfg.dryRun || cfg.verbose) console.log(renderCommand(args));
  if (cfg.dryRun) return out;

  execFileSync("magick", args, { stdio: "inherit" });
  const final = cfg.size > 0 ? imageSize(out) : { w, h };
  const geometry = cfg.pack
    ? `, packed ${cfg.fill}% fill / ${cfg.bottomPad}px bottom pad`
    : cfg.trim
      ? ", trimmed"
      : "";
  console.log(
    `✓ ${cfg.out}  (${final.w}x${final.h}, fuzz ${cfg.fuzz}%${geometry})`,
  );
  return out;
}

// --- CLI entrypoint ----------------------------------------------------------

function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof UsageError ? err.message : err);
    process.exit(2);
  }
  if (cfg.help || (!cfg.src && !cfg.out)) {
    // The header comment IS the manual; point at it rather than duplicating.
    console.log(
      "Usage: node scripts/cut-doodle.mjs <src> <out> [--fuzz N] [--size N] [--trim | --pack] [--fill N] [--bottom-pad N] [--dry-run] [--verbose]",
    );
    console.log(
      "See the comment block at the top of this file for the full manual and the why.",
    );
    process.exit(cfg.help ? 0 : 2);
  }
  try {
    cutDoodle(cfg);
  } catch (err) {
    console.error(err instanceof UsageError ? `✗ ${err.message}` : err);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}

main();

// Exported for tests / reuse (import from another script without spawning a CLI).
export { parseArgs, borderSeeds, buildMagickArgs, renderCommand, cutDoodle };
