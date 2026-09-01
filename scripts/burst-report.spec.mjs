/**
 * Specs for the burst rehearsal report.
 *
 * These use `node:test` rather than vitest on purpose: `scripts/` is outside
 * every workspace, `turbo run test` therefore never reaches it, and vitest is
 * not resolvable from the repository root (root devDependencies are
 * dotenv-cli, prettier and turbo). A vitest spec here would import nothing and
 * run nowhere. `node --test scripts/burst-report.spec.mjs` runs today with no
 * configuration at all.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderBurstReport } from "./burst-report.mjs";

describe("renderBurstReport", () => {
  it("neutralises hostile message text instead of rendering it as markup", () => {
    const attack = '<script>alert("xss")</script> & <img src=x onerror=1> 😤';
    const html = renderBurstReport(
      run({
        campaigns: [
          campaign({
            conversations: [
              conversation({
                transcript: [
                  { seq: 1, actor: "participant", text: attack, at: AT },
                ],
                received: [attack],
                expectations: [
                  {
                    label: attack,
                    expected: attack,
                    actual: attack,
                    passed: false,
                  },
                ],
                displayName: attack,
                quirk: attack,
                passed: false,
              }),
            ],
          }),
        ],
      }),
    );

    // The literal text survives, escaped, in every place it was given.
    assert.ok(
      html.includes("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"),
    );
    assert.ok(html.includes("😤"));
    // …and never once unescaped, so no tag was built out of it.
    assert.ok(!html.includes(attack));
    assert.ok(!FETCHING_TAG.test(html));
    // The only scripts in the document are the two the renderer owns.
    assert.equal(html.match(/<script>/gu).length, 2);
  });

  it("escapes text that would otherwise break out of an attribute", () => {
    const html = renderBurstReport(
      run({
        campaigns: [
          campaign({
            conversations: [
              conversation({
                transcript: [
                  {
                    seq: 1,
                    actor: "participant",
                    text: "x",
                    at: '2026-07-27T10:00:00.000Z" onmouseover="alert(1)',
                  },
                ],
              }),
            ],
          }),
        ],
      }),
    );

    assert.ok(!html.includes('onmouseover="alert(1)"'));
    assert.ok(html.includes("&quot; onmouseover=&quot;alert(1)"));
  });

  it("renders a clean run and a failed run as visibly different verdicts", () => {
    const clean = renderBurstReport(run({}));
    const broken = renderBurstReport(
      run({
        passed: false,
        campaigns: [
          campaign({
            conversations: [conversation({ passed: false })],
          }),
        ],
      }),
    );

    assert.ok(clean.includes("Όλα πέρασαν"));
    assert.ok(clean.includes('class="verdict is-success"'));
    assert.ok(!clean.includes('class="verdict is-danger"'));

    assert.ok(broken.includes("Απέτυχε"));
    assert.ok(broken.includes('class="verdict is-danger"'));
    assert.ok(!broken.includes('class="verdict is-success"'));
    // "Where" is answered in the header, not only down in the campaign list.
    assert.ok(broken.includes("Πού έσπασε"));
  });

  it("does not call a technically passing run clean when observations diverged", () => {
    const html = renderBurstReport(
      run({
        campaigns: [
          campaign({
            conversations: [
              conversation({
                passed: true,
                expectations: [
                  {
                    label: "observation: needsAttention",
                    expected: "false",
                    actual: "true",
                    passed: false,
                  },
                ],
              }),
            ],
          }),
        ],
      }),
    );

    assert.ok(html.includes("Πέρασε τεχνικά — με αποκλίσεις"));
    assert.ok(html.includes('class="verdict is-warning"'));
    assert.ok(html.includes("Πού έσπασε ή απέκλινε"));
    assert.ok(html.includes('class="conv is-pass has-divergence"'));
    assert.ok(html.includes("Απόκλιση"));
    assert.ok(!html.includes("Όλα πέρασαν"));
  });

  it("makes deterministic live-guest substitution visible as missing coverage", () => {
    const html = renderBurstReport(
      run({
        liveGuests: {
          mode: "deterministic_silence",
          total: 6,
          substituted: 6,
        },
      }),
    );

    assert.ok(html.includes("Ζωντανοί καλεσμένοι"));
    assert.ok(
      html.includes("6/6 ντετερμινιστική σιωπή (χωρίς κάλυψη συμπεριφοράς)"),
    );
  });

  it("stamps the exact simulated transport treatment into the report", () => {
    const html = renderBurstReport(
      run({
        transport: {
          mode: "simulated",
          profile: {
            faultMode: "mixed",
            faultPercent: 20,
            seed: "canary-7",
            maxDelayMs: 4_000,
          },
        },
      }),
    );

    assert.ok(html.includes("Μεταφορά"));
    assert.ok(
      html.includes("simulated · mixed@20% · έως 4000 ms · seed canary-7"),
    );
  });

  it("shows the pessimistic verdict when the run flag disagrees with its rows", () => {
    const html = renderBurstReport(
      run({
        passed: true,
        findings: [
          {
            kind: "duplicate_outbound",
            detail: "Το ίδιο μήνυμα έφτασε δύο φορές.",
            conversationIds: [],
          },
        ],
      }),
    );

    assert.ok(html.includes('class="verdict is-danger"'));
    assert.ok(html.includes("Η εκτέλεση δηλώνει"));
  });

  it("surfaces a finding above the conversation list and names who it hit", () => {
    const html = renderBurstReport(
      run({
        passed: false,
        campaigns: [
          campaign({
            conversations: [
              conversation({
                conversationId: "conv-1",
                displayName: "Κώστας Αργοπληκτρολογάκιας",
              }),
            ],
          }),
        ],
        findings: [
          {
            kind: "duplicate_outbound",
            detail: "Το ίδιο εξερχόμενο έφτασε δύο φορές στο +306900000101.",
            conversationIds: ["conv-1"],
          },
        ],
      }),
    );

    assert.ok(html.includes("Διπλό εξερχόμενο"));
    assert.ok(
      html.includes("Το ίδιο εξερχόμενο έφτασε δύο φορές στο +306900000101."),
    );
    // The finding links to the conversation by persona name, not by raw id.
    assert.ok(
      html.includes('href="#syn-conv-1">Κώστας Αργοπληκτρολογάκιας</a>'),
    );
    // Findings outrank conversations, so they render first.
    assert.ok(
      html.indexOf("Διπλό εξερχόμενο") < html.indexOf('class="campaign'),
    );
  });

  it("says so plainly when there are no findings", () => {
    const html = renderBurstReport(run({}));

    assert.ok(html.includes("Κανένα εύρημα"));
    assert.ok(!html.includes("Διπλό εξερχόμενο"));
  });

  it("is a self-contained document: no asset is fetched over the network", () => {
    const html = renderBurstReport(
      run({
        campaigns: [
          campaign({
            adminUrl: "https://slopform.example.com/admin/feedback/c1",
            conversations: [
              conversation({
                adminUrl: "https://slopform.example.com/admin/feedback/c1?x=1",
              }),
            ],
          }),
        ],
      }),
    );

    // `adminUrl` links are content and stay; everything else must be inline.
    const withoutContentLinks = html.replace(/<a\b[^>]*>/gu, "");
    assert.ok(!withoutContentLinks.includes("http://"));
    assert.ok(!withoutContentLinks.includes("https://"));

    // No tag that would fetch anything, and no CSS that would either.
    assert.ok(!FETCHING_TAG.test(html));
    assert.ok(!/@import/u.test(html));
    assert.ok(!/url\(/u.test(html));
    // The admin links themselves are still there.
    assert.ok(html.includes("https://slopform.example.com/admin/feedback/c1"));
  });

  it("refuses to turn a non-http adminUrl into a link", () => {
    const html = renderBurstReport(
      run({
        campaigns: [
          campaign({
            adminUrl: "javascript:alert(1)",
            conversations: [conversation({ adminUrl: "data:text/html,<b>x" })],
          }),
        ],
      }),
    );

    assert.ok(!html.includes('href="javascript:'));
    assert.ok(!html.includes('href="data:'));
    // The value is still shown, inert, so the operator can see what it was.
    assert.ok(html.includes("javascript:alert(1)"));
  });

  it("annotates an outbound whose text already reached the phone", () => {
    const html = renderBurstReport(
      run({
        campaigns: [
          campaign({
            conversations: [
              conversation({ received: ["Ευχαριστούμε!", "Ευχαριστούμε!"] }),
            ],
          }),
        ],
      }),
    );

    assert.ok(html.includes("ίδιο κείμενο με το #1"));
  });

  it("collapses passing conversations and leaves failing ones open", () => {
    const html = renderBurstReport(
      run({
        passed: false,
        campaigns: [
          campaign({
            conversations: [
              conversation({ conversationId: "ok", passed: true }),
              conversation({ conversationId: "bad", passed: false }),
            ],
          }),
        ],
      }),
    );

    assert.ok(html.includes('class="conv is-pass" id="syn-ok">'));
    assert.ok(html.includes('class="conv is-fail" id="syn-bad" open>'));
  });

  it("leaves a live guest open even when it passed, and names its model", () => {
    // Collapsing on pass assumes passing means "the contract held, nothing to
    // see". A live guest asserts almost nothing — only that it was replied to —
    // so passing tells a reader nothing and its transcript is the whole reason
    // it was seated. Hiding that behind a click hides the finding.
    const html = renderBurstReport(
      run({
        passed: true,
        campaigns: [
          campaign({
            conversations: [
              conversation({
                conversationId: "live",
                passed: true,
                liveModel: "composer-2.5-fast",
              }),
            ],
          }),
        ],
      }),
    );

    assert.ok(html.includes('class="conv is-pass" id="syn-live" open>'));
    assert.ok(html.includes("composer-2.5-fast"));
  });

  it("renders an empty result rather than throwing", () => {
    const html = renderBurstReport({});

    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("Όλα πέρασαν"));
    assert.ok(html.includes("</html>"));
  });
});

/* --- fixtures ------------------------------------------------------------- */

/** Any element that would pull a byte off the network if it existed here. */
const FETCHING_TAG =
  /<(img|iframe|link|source|video|audio|object|embed|track|use|frame)\b/iu;

const AT = "2026-07-27T10:00:00.000Z";

function run(overrides) {
  return {
    startedAt: AT,
    finishedAt: "2026-07-27T10:00:42.000Z",
    durationMs: 42_000,
    model: "stub",
    passed: true,
    campaigns: [],
    findings: [],
    ...overrides,
  };
}

function campaign(overrides) {
  return {
    slug: "taverna",
    title: "Δοκιμαστικό δείπνο — Ταβέρνα",
    campaignId: "campaign-1",
    eventId: "event-1",
    status: "closed",
    adminUrl: "/admin/feedback/campaign-1",
    conversations: [],
    ...overrides,
  };
}

function conversation(overrides) {
  return {
    personaId: "argoplikitrologakias",
    displayName: "Κώστας Αργοπληκτρολογάκιας",
    quirk: "Γράφει αργά, μία λέξη ανά μήνυμα.",
    mirrors: "S02",
    phoneE164: "+306900000101",
    conversationId: "conversation-1",
    adminUrl: "/admin/feedback/campaign-1?conversation=conversation-1",
    passed: true,
    expectations: [
      {
        label: "lifecycle",
        expected: "closed",
        actual: "closed",
        passed: true,
      },
    ],
    received: ["Πώς σου φάνηκε η βραδιά;"],
    transcript: [{ seq: 1, actor: "bot", text: "Γεια σου!", at: AT }],
    actual: {
      lifecycle: "closed",
      closedBecause: "completed",
      optedIn: true,
      needsAttention: false,
      answers: [{ question: "event_score", about: null, value: 5 }],
      notes: [],
      modelCalls: 2,
    },
    ...overrides,
  };
}
