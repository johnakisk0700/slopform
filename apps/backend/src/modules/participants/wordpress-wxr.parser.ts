import {
  WORDPRESS_PROFILE_IMPORT_SCHEMA_VERSION,
  WORDPRESS_PROFILE_SOURCE,
  type WordpressProfileExport,
} from "./wordpress-profile-import.schemas.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    (entity) => {
      const body = entity.slice(1, -1);

      if (body === "amp") return "&";
      if (body === "lt") return "<";
      if (body === "gt") return ">";
      if (body === "quot") return '"';
      if (body === "apos") return "'";

      const codePoint = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint)
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

function elementText(fragment: string, tagName: string): string | undefined {
  const tag = escapeRegExp(tagName);
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(
    fragment,
  );

  if (!match?.[1]) {
    return undefined;
  }

  const content = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return decodeXmlEntities(content);
}

function extractMeta(item: string): Map<string, string> {
  const meta = new Map<string, string>();
  const blocks = item.matchAll(/<wp:postmeta>([\s\S]*?)<\/wp:postmeta>/g);

  for (const block of blocks) {
    const content = block[1];

    if (!content) {
      continue;
    }

    const key = elementText(content, "wp:meta_key");
    const value = elementText(content, "wp:meta_value");

    if (key?.startsWith("jts_") && value !== undefined) {
      meta.set(key, value);
    }
  }

  return meta;
}

function splitInterests(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  if (value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) &&
        parsed.every((item) => typeof item === "string")
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  return value
    .split(",")
    .map((interest) => interest.trim())
    .filter(Boolean);
}

export function parseWordpressWxrProfiles(xml: string): WordpressProfileExport {
  const exportedAtRaw = elementText(xml, "pubDate");
  const exportedAt = exportedAtRaw ? new Date(exportedAtRaw) : undefined;

  if (!exportedAt || Number.isNaN(exportedAt.getTime())) {
    throw new Error("WordPress WXR export has no valid channel pubDate");
  }

  const profiles: WordpressProfileExport["profiles"] = [];

  for (const itemMatch of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = itemMatch[1];

    if (!item || elementText(item, "wp:post_type") !== "jts_profile") {
      continue;
    }

    const sourceProfileId = elementText(item, "wp:post_id");
    const sourceStatus = elementText(item, "wp:status");

    if (!sourceProfileId || !sourceStatus) {
      throw new Error("WordPress WXR profile is missing source identity");
    }

    if (
      !["publish", "private", "draft", "pending", "future", "trash"].includes(
        sourceStatus,
      )
    ) {
      throw new Error(`Unsupported WordPress profile status: ${sourceStatus}`);
    }

    const meta = extractMeta(item);
    const sourceUserId = elementText(item, "dc:creator");

    profiles.push({
      sourceProfileId,
      ...(sourceUserId ? { sourceUserId } : {}),
      sourceStatus:
        sourceStatus as WordpressProfileExport["profiles"][number]["sourceStatus"],
      sourceUpdatedAt: null,
      answers: {
        name: meta.get("jts_name") ?? "",
        age: meta.get("jts_age") ?? "",
        telephone: meta.get("jts_telephone") ?? "",
        city: meta.get("jts_city") ?? "",
        interests: splitInterests(meta.get("jts_interests")),
        personality: meta.get("jts_personality") ?? "",
        email: meta.get("jts_email") ?? "",
      },
    });
  }

  return {
    schemaVersion: WORDPRESS_PROFILE_IMPORT_SCHEMA_VERSION,
    source: WORDPRESS_PROFILE_SOURCE,
    exportedAt: exportedAt.toISOString(),
    profiles,
  };
}
