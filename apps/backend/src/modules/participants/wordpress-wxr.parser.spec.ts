import { describe, expect, it } from "vitest";

import { parseWordpressWxrProfiles } from "./wordpress-wxr.parser.js";

const wxr = `<?xml version="1.0" encoding="UTF-8" ?>
<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <pubDate>Thu, 23 Jul 2026 02:10:00 +0000</pubDate>
    <item>
      <dc:creator><![CDATA[giannis]]></dc:creator>
      <wp:post_id>42</wp:post_id>
      <wp:status><![CDATA[private]]></wp:status>
      <wp:post_type><![CDATA[jts_profile]]></wp:post_type>
      <wp:postmeta><wp:meta_key><![CDATA[jts_name]]></wp:meta_key><wp:meta_value><![CDATA[Γιάννης & Δοκιμή]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[jts_age]]></wp:meta_key><wp:meta_value><![CDATA[25–34]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[jts_telephone]]></wp:meta_key><wp:meta_value><![CDATA[696 969 6969]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[jts_city]]></wp:meta_key><wp:meta_value><![CDATA[Κολωνάκι]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[jts_interests]]></wp:meta_key><wp:meta_value><![CDATA[Ταξίδια, Τέχνη & μουσική]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[jts_personality]]></wp:meta_key><wp:meta_value><![CDATA[3]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[jts_email]]></wp:meta_key><wp:meta_value><![CDATA[test@example.gr]]></wp:meta_value></wp:postmeta>
    </item>
    <item>
      <wp:post_id>99</wp:post_id>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:post_type><![CDATA[post]]></wp:post_type>
    </item>
  </channel>
</rss>`;

describe("parseWordpressWxrProfiles", () => {
  it("converts the WordPress WXR profile and ignores other post types", () => {
    expect(parseWordpressWxrProfiles(wxr)).toEqual({
      schemaVersion: 1,
      source: "wordpress-jts-profile",
      exportedAt: "2026-07-23T02:10:00.000Z",
      profiles: [
        {
          sourceProfileId: "42",
          sourceUserId: "giannis",
          sourceStatus: "private",
          sourceUpdatedAt: null,
          answers: {
            name: "Γιάννης & Δοκιμή",
            age: "25–34",
            telephone: "696 969 6969",
            city: "Κολωνάκι",
            interests: ["Ταξίδια", "Τέχνη & μουσική"],
            personality: "3",
            email: "test@example.gr",
          },
        },
      ],
    });
  });

  it("rejects a profile without a stable source identity", () => {
    expect(() =>
      parseWordpressWxrProfiles(wxr.replace("<wp:post_id>42</wp:post_id>", "")),
    ).toThrow("missing source identity");
  });
});
