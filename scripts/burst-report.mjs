/**
 * The operator-facing report for the multi-campaign burst rehearsal.
 *
 * `renderBurstReport(result)` turns one `BurstRunResult` into a single
 * self-contained HTML document. The runner writes it to
 * `report/feedback-burst-<timestamp>.html` and it is opened straight from disk:
 * no stylesheet, no CDN, no font fetch, no build step, no network at all.
 *
 * The screen answers one question in its first screenful — **did anything
 * break, and where** — and then lets the operator drill into any of the
 * eighteen conversations without navigating away. Today that answer costs
 * eighteen round trips through the admin.
 *
 * Two rules this file exists to keep:
 *
 * 1. **Everything that comes from `result` is escaped.** Message text is
 *    arbitrary participant input; a rehearsal report that executes its own test
 *    data is a real hazard. The inline `<style>` and `<script>` interpolate
 *    nothing at all, and `adminUrl` is scheme-checked before it becomes an
 *    `href`.
 * 2. **No value a design token owns is invented here.** The document cannot
 *    import `packages/design-tokens/src/tokens.css`, so the subset it needs is
 *    copied verbatim below, under the same `--jts-*` names. A theme change is
 *    then a copy of the same lines into one obvious place.
 *
 * @see {@link ../apps/backend/src/modules/post-event-feedback/burst/burst-scenario.ts}
 * @see {@link ../docs/frontend/theming.md}
 */

/**
 * @typedef {object} BurstRunResult
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {number} durationMs
 * @property {string} model
 * @property {boolean} passed
 * @property {BurstCampaignResult[]} campaigns
 * @property {BurstFinding[]} findings
 */

/**
 * @typedef {object} BurstCampaignResult
 * @property {string} slug
 * @property {string} title
 * @property {string} campaignId
 * @property {string} eventId
 * @property {string} status
 * @property {string} adminUrl
 * @property {BurstConversationResult[]} conversations
 */

/**
 * @typedef {object} BurstConversationResult
 * @property {string} personaId
 * @property {string} displayName
 * @property {string} quirk
 * @property {string} mirrors
 * @property {string} phoneE164
 * @property {string} conversationId
 * @property {string} adminUrl
 * @property {boolean} passed
 * @property {BurstExpectation[]} expectations
 * @property {string[]} received
 * @property {BurstTranscriptEntry[]} transcript
 * @property {BurstActual} actual
 */

/**
 * @typedef {object} BurstTranscriptEntry
 * @property {number} seq
 * @property {string} actor
 * @property {string} text
 * @property {string} at
 */

/**
 * @typedef {object} BurstActual
 * @property {string} lifecycle
 * @property {string|null} closedBecause
 * @property {boolean} optedIn
 * @property {boolean} needsAttention
 * @property {{question: string, about: string|null, value: number|null}[]} answers
 * @property {{type: string, text: string, about: string|null, flagged: boolean}[]} notes
 * @property {number} modelCalls
 */

/**
 * @typedef {object} BurstExpectation
 * @property {string} label
 * @property {string} expected
 * @property {string} actual
 * @property {boolean} passed
 */

/**
 * @typedef {object} BurstFinding
 * @property {string} kind
 * @property {string} detail
 * @property {string[]} conversationIds
 */

/* -----------------------------------------------------------------------------
   Greek vocabulary. The product is Greek and so is its operator, so the
   interface copy is Greek too; the raw enum value is kept as the fallback so an
   unknown value from a newer runner still renders something truthful.
   ----------------------------------------------------------------------------- */

const FINDING_LABELS = {
  duplicate_outbound: "Διπλό εξερχόμενο",
  cross_conversation_citation: "Παραπομπή σε άλλη συνομιλία",
  lost_participant_text: "Χαμένο κείμενο συμμετέχοντα",
  campaign_not_terminal: "Καμπάνια χωρίς τερματική κατάσταση",
  job_failed: "Αποτυχία εργασίας",
  script_exhausted: "Εξαντλημένο σενάριο",
};

const CAMPAIGN_STATUS_LABELS = {
  launched: "Ξεκίνησε",
  paused: "Σε παύση",
  closed: "Έκλεισε",
};

const CAMPAIGN_STATUS_TONES = {
  launched: "success",
  paused: "warning",
  closed: "neutral",
};

const LIFECYCLE_LABELS = {
  open: "Ανοιχτή",
  closed: "Κλειστή",
};

const CLOSED_BECAUSE_LABELS = {
  completed: "Ολοκληρώθηκε",
  stopped: "Διακόπηκε",
  expired: "Έληξε",
  cancelled: "Ακυρώθηκε",
};

const QUESTION_LABELS = {
  event_score: "Βαθμολογία βραδιάς",
  liked: "Συμπάθησε",
  meet_again: "Θα ξανασυναντούσε",
  avoid: "Να αποφευχθεί",
};

const NOTE_TYPE_LABELS = {
  activity_interest: "Ενδιαφέρον για δραστηριότητα",
  general: "Γενική σημείωση",
};

const ACTOR_LABELS = {
  participant: "Συμμετέχων",
  bot: "Bot",
  staff: "Προσωπικό",
  system: "Σύστημα",
};

/** Fallback for any display value that came back empty. */
const EMPTY = "—";

/* -----------------------------------------------------------------------------
   Icons. Internal constants, never participant data — so their markup is the
   one thing on the page that is not escaped. Stroked, flat, `currentColor`:
   the theming invariants forbid glows, gradients and pulsing dots.
   ----------------------------------------------------------------------------- */

const ICON_PATHS = {
  check: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
  cross: '<path d="M4 4 12 12M12 4 4 12"/>',
  alert:
    '<path d="M8 2.5 1.75 13.5h12.5z"/><path d="M8 6.4v3.1"/><path d="M8 11.6h.01"/>',
  campaign:
    '<rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.75"/><path d="M2.25 6.75h11.5M5.5 1.75v2.5M10.5 1.75v2.5"/>',
  phone:
    '<rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.75"/><path d="M7 12.25h2"/>',
  chat: '<path d="M13.5 8.75a4.25 4.25 0 0 1-4.25 4.25H5.5L2.5 15v-3.4A4.25 4.25 0 0 1 2.5 8.4V6.75A4.25 4.25 0 0 1 6.75 2.5h2.5A4.25 4.25 0 0 1 13.5 6.75z"/>',
  clock: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8.4l2.4 1.6"/>',
  external:
    '<path d="M9.25 2.75h4v4"/><path d="M13.25 2.75 7.5 8.5"/><path d="M12.25 9.75v2.5a1.5 1.5 0 0 1-1.5 1.5h-7a1.5 1.5 0 0 1-1.5-1.5v-7a1.5 1.5 0 0 1 1.5-1.5h2.5"/>',
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  outbound: '<path d="M2.5 8h10"/><path d="M9 4.5 12.5 8 9 11.5"/>',
  spark:
    '<path d="M8 1.75 9.6 6.4 14.25 8 9.6 9.6 8 14.25 6.4 9.6 1.75 8 6.4 6.4z"/>',
};

/**
 * Renders the whole report.
 *
 * @param {BurstRunResult} result
 * @returns {string} a complete, self-contained HTML document
 */
export function renderBurstReport(result) {
  const run = readRun(result);
  const stats = summarise(run);
  const index = indexConversations(run);

  const title = `Πρόβα ριπής — ${stats.failed > 0 || stats.findings > 0 ? "απέτυχε" : "πέρασε"}`;

  return [
    "<!doctype html>",
    '<html lang="el">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    // Set before first paint so the JS-only controls never flash in and out.
    '<script>document.documentElement.classList.add("js");</script>',
    "</head>",
    `<body class="${stats.failedConversations.length === 0 ? "no-failures" : ""}">`,
    '<a class="skip-link" href="#etymigoria">Στο πόρισμα</a>',
    renderMasthead(run, stats),
    renderRail(run, stats),
    '<main class="page" id="etymigoria">',
    renderVerdict(run, stats),
    renderStats(stats),
    renderFindings(run.findings, index),
    renderFailureIndex(stats),
    ...run.campaigns.map((campaign) => renderCampaign(campaign)),
    "</main>",
    renderFooter(),
    `<script>${SCRIPT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/* -----------------------------------------------------------------------------
   Reading the result. Deliberately forgiving: this page is most valuable
   exactly when the run went wrong, so a missing array must never stop it from
   rendering the parts that survived.
   ----------------------------------------------------------------------------- */

function readRun(result) {
  const source = isObject(result) ? result : {};
  return {
    startedAt: text(source.startedAt),
    finishedAt: text(source.finishedAt),
    durationMs: Number.isFinite(source.durationMs) ? source.durationMs : null,
    model: text(source.model),
    passed: source.passed === true,
    campaigns: list(source.campaigns).map(readCampaign),
    findings: list(source.findings).map(readFinding),
  };
}

function readCampaign(campaign) {
  const source = isObject(campaign) ? campaign : {};
  return {
    slug: text(source.slug),
    title: text(source.title),
    campaignId: text(source.campaignId),
    eventId: text(source.eventId),
    status: text(source.status),
    adminUrl: text(source.adminUrl),
    conversations: list(source.conversations).map(readConversation),
  };
}

function readConversation(conversation) {
  const source = isObject(conversation) ? conversation : {};
  const actual = isObject(source.actual) ? source.actual : {};
  return {
    personaId: text(source.personaId),
    displayName: text(source.displayName),
    quirk: text(source.quirk),
    mirrors: text(source.mirrors),
    phoneE164: text(source.phoneE164),
    conversationId: text(source.conversationId),
    adminUrl: text(source.adminUrl),
    passed: source.passed === true,
    expectations: list(source.expectations).map((expectation) => {
      const row = isObject(expectation) ? expectation : {};
      return {
        label: text(row.label),
        expected: text(row.expected),
        actual: text(row.actual),
        passed: row.passed === true,
      };
    }),
    received: list(source.received).map(text),
    transcript: list(source.transcript).map((entry) => {
      const row = isObject(entry) ? entry : {};
      return {
        seq: Number.isFinite(row.seq) ? row.seq : null,
        actor: text(row.actor),
        text: text(row.text),
        at: text(row.at),
      };
    }),
    actual: {
      lifecycle: text(actual.lifecycle),
      closedBecause:
        actual.closedBecause == null ? null : text(actual.closedBecause),
      optedIn: actual.optedIn === true,
      needsAttention: actual.needsAttention === true,
      answers: list(actual.answers).map((answer) => {
        const row = isObject(answer) ? answer : {};
        return {
          question: text(row.question),
          about: row.about == null ? null : text(row.about),
          value: Number.isFinite(row.value) ? row.value : null,
        };
      }),
      notes: list(actual.notes).map((note) => {
        const row = isObject(note) ? note : {};
        return {
          type: text(row.type),
          text: text(row.text),
          about: row.about == null ? null : text(row.about),
          flagged: row.flagged === true,
        };
      }),
      modelCalls: Number.isFinite(actual.modelCalls) ? actual.modelCalls : null,
    },
  };
}

function readFinding(finding) {
  const source = isObject(finding) ? finding : {};
  return {
    kind: text(source.kind),
    detail: text(source.detail),
    conversationIds: list(source.conversationIds).map(text),
  };
}

/**
 * Everything the header needs, counted once.
 *
 * `derivedPassed` is not simply `result.passed`: the shape promises the flag is
 * false when any conversation or finding failed, and a report that quietly
 * agreed with a flag contradicting its own rows would hide exactly the class of
 * bug this rehearsal hunts. The page shows the pessimistic verdict and says so.
 */
function summarise(run) {
  const conversations = run.campaigns.flatMap((campaign) =>
    campaign.conversations.map((conversation) => ({ campaign, conversation })),
  );
  const failedConversations = conversations.filter(
    (row) => !row.conversation.passed,
  );
  const expectations = conversations.flatMap(
    (row) => row.conversation.expectations,
  );

  const derivedPassed =
    failedConversations.length === 0 && run.findings.length === 0;

  return {
    campaigns: run.campaigns.length,
    conversations: conversations.length,
    failed: failedConversations.length,
    failedConversations,
    expectations: expectations.length,
    failedExpectations: expectations.filter((row) => !row.passed).length,
    findings: run.findings.length,
    received: conversations.reduce(
      (total, row) => total + row.conversation.received.length,
      0,
    ),
    modelCalls: conversations.reduce(
      (total, row) => total + (row.conversation.actual.modelCalls ?? 0),
      0,
    ),
    derivedPassed,
    /** True when the run claims success while its own rows say otherwise. */
    inconsistent: run.passed && !derivedPassed,
  };
}

/** Conversation id → the human facts a finding needs to name it. */
function indexConversations(run) {
  const index = new Map();
  for (const campaign of run.campaigns) {
    for (const conversation of campaign.conversations) {
      if (conversation.conversationId === "") {
        continue;
      }
      index.set(conversation.conversationId, {
        displayName: conversation.displayName,
        campaignTitle: campaign.title,
        anchor: conversationAnchor(conversation.conversationId),
      });
    }
  }
  return index;
}

/* -----------------------------------------------------------------------------
   Sections.
   ----------------------------------------------------------------------------- */

function renderMasthead(run, stats) {
  const meta = [
    metaItem("clock", "Έναρξη", formatTimestamp(run.startedAt)),
    metaItem("spark", "Μοντέλο", run.model === "" ? EMPTY : run.model),
    metaItem("clock", "Διάρκεια", formatDuration(run.durationMs)),
  ];
  return `<header class="masthead">
<div class="masthead-inner">
<div class="masthead-brand">
<span class="brand-mark" aria-hidden="true"></span>
<span>
<span class="kicker">Join The Six</span>
<span class="masthead-title">Ανατροφοδότηση μετά την εκδήλωση — πρόβα ριπής</span>
</span>
</div>
<dl class="masthead-meta">${meta.join("")}</dl>
</div>
<p class="masthead-note"><span>${escapeHtml(String(stats.campaigns))} καμπάνιες ταυτόχρονα, ${escapeHtml(String(stats.conversations))} συνομιλίες. Το ερώτημα δεν είναι η ταχύτητα· είναι αν ο μηχανισμός μένει σωστός όταν απαντούν όλοι μαζί.</span></p>
</header>`;
}

function metaItem(iconName, label, value) {
  return `<div class="masthead-meta-item">${icon(iconName)}<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

/** The sticky bar: the verdict stays on screen for the whole scroll. */
function renderRail(run, stats) {
  const tone = stats.derivedPassed ? "success" : "danger";
  const jumps = run.campaigns
    .map((campaign) => {
      const clean = campaign.conversations.every(
        (conversation) => conversation.passed,
      );
      return `<a class="rail-jump${clean ? "" : " is-fail"}" href="#${escapeHtml(campaignAnchor(campaign))}">${escapeHtml(campaign.title === "" ? campaign.slug : campaign.title)}</a>`;
    })
    .join("");

  const findingsJump =
    stats.findings > 0
      ? `<a class="rail-jump is-fail" href="#evrimata">Ευρήματα (${escapeHtml(String(stats.findings))})</a>`
      : "";

  return `<nav class="rail" aria-label="Πλοήγηση αναφοράς">
<div class="rail-inner">
<span class="badge is-${tone} is-strong">${icon(stats.derivedPassed ? "check" : "cross")}${stats.derivedPassed ? "Πέρασε" : "Απέτυχε"}</span>
<span class="rail-count">${escapeHtml(String(stats.conversations - stats.failed))}<span class="rail-sep">/</span>${escapeHtml(String(stats.conversations))} συνομιλίες πέρασαν</span>
<div class="rail-jumps">${findingsJump}${jumps}</div>
<div class="rail-tools js-only">
<label class="toggle"><input type="checkbox" id="filter-failures"> Μόνο αποτυχίες</label>
<button type="button" class="button" data-expand="open">Ανάπτυξη όλων</button>
<button type="button" class="button" data-expand="close">Σύμπτυξη όλων</button>
</div>
</div>
</nav>`;
}

function renderVerdict(run, stats) {
  const passed = stats.derivedPassed;
  const headline = passed ? "Όλα πέρασαν" : "Απέτυχε";
  const lines = [];

  if (stats.findings > 0) {
    lines.push(
      `${count(stats.findings, "εύρημα", "ευρήματα")} σε επίπεδο εκτέλεσης`,
    );
  }
  if (stats.failed > 0) {
    lines.push(
      `${count(stats.failed, "συνομιλία απέτυχε", "συνομιλίες απέτυχαν")}`,
    );
  }
  if (stats.failedExpectations > 0) {
    lines.push(
      `${count(stats.failedExpectations, "έλεγχος έπεσε", "έλεγχοι έπεσαν")}`,
    );
  }
  if (lines.length === 0) {
    lines.push(
      "Κανένα διπλό εξερχόμενο, καμία διασταυρωμένη παραπομπή, καμία συνομιλία εκτός προδιαγραφής",
    );
  }

  const warning = stats.inconsistent
    ? `<p class="verdict-warning">${icon("alert")}Η εκτέλεση δηλώνει <code>passed: true</code>, αλλά οι ίδιες οι γραμμές της δείχνουν αποτυχίες. Η αναφορά δείχνει το δυσμενέστερο από τα δύο.</p>`
    : "";

  const separator = ' <span class="dot">·</span> ';

  return `<section class="verdict is-${passed ? "success" : "danger"}" aria-labelledby="verdict-title">
<div class="verdict-mark" aria-hidden="true">${icon(passed ? "check" : "alert")}</div>
<div class="verdict-body">
<p class="kicker">Πόρισμα εκτέλεσης</p>
<h1 id="verdict-title">${escapeHtml(headline)}</h1>
<p class="verdict-lines">${lines.map((line) => escapeHtml(line)).join(separator)}</p>
${warning}
</div>
</section>`;
}

function renderStats(stats) {
  const tiles = [
    tile(
      "Συνομιλίες",
      `${stats.conversations - stats.failed}/${stats.conversations}`,
      stats.failed > 0 ? "danger" : "success",
      "πέρασαν",
    ),
    tile(
      "Έλεγχοι",
      `${stats.expectations - stats.failedExpectations}/${stats.expectations}`,
      stats.failedExpectations > 0 ? "danger" : "success",
      "πέρασαν",
    ),
    tile(
      "Ευρήματα",
      String(stats.findings),
      stats.findings > 0 ? "danger" : "success",
      "σε επίπεδο εκτέλεσης",
    ),
    tile("Καμπάνιες", String(stats.campaigns), "neutral", "ταυτόχρονα"),
    tile(
      "Στο τηλέφωνο",
      String(stats.received),
      "neutral",
      "εξερχόμενα που έφτασαν",
    ),
    tile("Κλήσεις μοντέλου", String(stats.modelCalls), "neutral", "συνολικά"),
  ];
  return `<section class="stats" aria-label="Αριθμοί εκτέλεσης">${tiles.join("")}</section>`;
}

function tile(label, value, tone, hint) {
  return `<div class="tile is-${tone}">
<p class="tile-value">${escapeHtml(value)}</p>
<p class="kicker">${escapeHtml(label)}</p>
<p class="tile-hint">${escapeHtml(hint)}</p>
</div>`;
}

/**
 * Findings come before the conversation list because they outrank it: a
 * duplicate outbound is a worse result than any one persona missing an
 * expectation, and burying it under eighteen rows would invert that.
 */
function renderFindings(findings, index) {
  if (findings.length === 0) {
    return `<section class="findings is-clean" id="evrimata" aria-labelledby="findings-title">
<h2 id="findings-title" class="section-title">Ευρήματα</h2>
<p class="findings-clean">${icon("check")}Κανένα εύρημα. Κανένα διπλό μήνυμα δεν έφτασε σε τηλέφωνο και καμία απάντηση δεν γράφτηκε σε λάθος συνομιλία.</p>
</section>`;
  }

  const cards = findings
    .map((finding) => {
      const label = FINDING_LABELS[finding.kind] ?? finding.kind;
      const links = finding.conversationIds
        .map((conversationId) => {
          const known = index.get(conversationId);
          if (!known) {
            return `<span class="chip is-mono">${escapeHtml(conversationId)}</span>`;
          }
          return `<a class="chip is-link" href="#${escapeHtml(known.anchor)}">${escapeHtml(known.displayName === "" ? conversationId : known.displayName)}</a>`;
        })
        .join("");
      const involved =
        links === ""
          ? '<p class="finding-involved is-empty">Δεν αφορά συγκεκριμένη συνομιλία.</p>'
          : `<p class="finding-involved"><span class="kicker">Εμπλέκονται</span>${links}</p>`;
      return `<article class="finding">
<p class="finding-kind">${icon("alert")}<span>${escapeHtml(label)}</span><code>${escapeHtml(finding.kind)}</code></p>
<p class="finding-detail">${escapeHtml(finding.detail)}</p>
${involved}
</article>`;
    })
    .join("");

  return `<section class="findings" id="evrimata" aria-labelledby="findings-title">
<h2 id="findings-title" class="section-title">Ευρήματα<span class="section-count">${escapeHtml(String(findings.length))}</span></h2>
<p class="section-lede">Αστοχίες που ανήκουν στην εκτέλεση, όχι σε μία συνομιλία. Είναι ο λόγος που γίνεται αυτή η πρόβα.</p>
<div class="finding-grid">${cards}</div>
</section>`;
}

/** "Πού έσπασε" — the whole answer to "where", without scrolling. */
function renderFailureIndex(stats) {
  if (stats.failedConversations.length === 0) {
    // Nothing to index, but the failures filter still needs something to say.
    return '<p class="filter-empty">Καμία συνομιλία δεν απέτυχε — το φίλτρο δεν έχει τι να δείξει.</p>';
  }
  const chips = stats.failedConversations
    .map(({ campaign, conversation }) => {
      const failed = conversation.expectations.filter(
        (expectation) => !expectation.passed,
      ).length;
      return `<a class="failure-chip" href="#${escapeHtml(conversationAnchor(conversation.conversationId))}">
<span class="failure-name">${escapeHtml(conversation.displayName === "" ? conversation.personaId : conversation.displayName)}</span>
<span class="failure-meta">${escapeHtml(campaign.title === "" ? campaign.slug : campaign.title)}${failed > 0 ? ` <span class="dot">·</span> ${escapeHtml(count(failed, "έλεγχος", "έλεγχοι"))}` : ""}</span>
</a>`;
    })
    .join("");

  return `<section class="failures" aria-labelledby="failures-title">
<h2 id="failures-title" class="section-title">Πού έσπασε<span class="section-count">${escapeHtml(String(stats.failedConversations.length))}</span></h2>
<div class="failure-chips">${chips}</div>
</section>`;
}

function renderCampaign(campaign) {
  const failed = campaign.conversations.filter(
    (conversation) => !conversation.passed,
  ).length;
  const clean = failed === 0;
  const statusLabel =
    CAMPAIGN_STATUS_LABELS[campaign.status] ?? campaign.status;
  const statusTone = CAMPAIGN_STATUS_TONES[campaign.status] ?? "neutral";
  const anchor = campaignAnchor(campaign);

  return `<section class="campaign${clean ? " is-clean" : " is-fail"}" id="${escapeHtml(anchor)}" aria-labelledby="${escapeHtml(anchor)}-title">
<header class="campaign-head">
<div class="campaign-identity">
<p class="kicker">${icon("campaign")}Καμπάνια <code>${escapeHtml(campaign.slug)}</code></p>
<h2 class="campaign-title" id="${escapeHtml(anchor)}-title">${escapeHtml(campaign.title === "" ? campaign.slug : campaign.title)}</h2>
<p class="campaign-ids"><span title="campaignId">${escapeHtml(campaign.campaignId === "" ? EMPTY : campaign.campaignId)}</span> <span class="dot">·</span> <span title="eventId">${escapeHtml(campaign.eventId === "" ? EMPTY : campaign.eventId)}</span></p>
</div>
<div class="campaign-side">
<span class="badge is-${statusTone}">${escapeHtml(statusLabel === "" ? EMPTY : statusLabel)}</span>
<span class="badge is-${clean ? "success" : "danger"}">${escapeHtml(`${campaign.conversations.length - failed}/${campaign.conversations.length} πέρασαν`)}</span>
${adminLink(campaign.adminUrl, "Άνοιγμα καμπάνιας στο admin")}
</div>
</header>
<div class="conv-list">${campaign.conversations.map((conversation) => renderConversation(conversation)).join("")}</div>
</section>`;
}

/**
 * One conversation. Failed ones are open on arrival; passed ones collapse to a
 * scannable row. `<details>` is native, so the collapse survives JavaScript
 * being off — nothing here needs the script to be readable.
 */
function renderConversation(conversation) {
  const failedExpectations = conversation.expectations.filter(
    (expectation) => !expectation.passed,
  ).length;
  const anchor = conversationAnchor(conversation.conversationId);
  const name =
    conversation.displayName === ""
      ? conversation.personaId
      : conversation.displayName;

  const checks =
    failedExpectations > 0
      ? `<span class="chip is-danger">${escapeHtml(count(failedExpectations, "έλεγχος έπεσε", "έλεγχοι έπεσαν"))}</span>`
      : `<span class="chip">${escapeHtml(count(conversation.expectations.length, "έλεγχος", "έλεγχοι"))}</span>`;

  return `<details class="conv ${conversation.passed ? "is-pass" : "is-fail"}" id="${escapeHtml(anchor)}"${conversation.passed ? "" : " open"}>
<summary class="conv-summary">
<span class="badge is-${conversation.passed ? "success" : "danger"}${conversation.passed ? "" : " is-strong"}">${icon(conversation.passed ? "check" : "cross")}${conversation.passed ? "Πέρασε" : "Απέτυχε"}</span>
<h3 class="conv-name">${escapeHtml(name)}</h3>
<span class="conv-chips">
${conversation.mirrors === "" ? "" : `<span class="chip is-mono" title="Αντιστοιχεί στο σενάριο ${escapeHtml(conversation.mirrors)}">${escapeHtml(conversation.mirrors)}</span>`}
<span class="chip is-mono">${icon("phone")}<span class="visually-hidden">Τηλέφωνο </span>${escapeHtml(conversation.phoneE164 === "" ? EMPTY : conversation.phoneE164)}</span>
<span class="chip" title="Μηνύματα που έφτασαν στο τηλέφωνο">${icon("outbound")}<span class="visually-hidden">Μηνύματα που έφτασαν: </span>${escapeHtml(String(conversation.received.length))}</span>
${checks}
</span>
<span class="conv-chevron" aria-hidden="true">${icon("chevron")}</span>
<span class="conv-quirk">${escapeHtml(conversation.quirk)}</span>
</summary>
<div class="conv-body">
<div class="conv-col">
${renderExpectations(conversation.expectations)}
${renderReceived(conversation.received)}
${renderActual(conversation.actual)}
</div>
<div class="conv-col">
${renderTranscript(conversation.transcript)}
</div>
<p class="conv-foot">
<span class="chip is-mono" title="conversationId">${escapeHtml(conversation.conversationId === "" ? EMPTY : conversation.conversationId)}</span>
<span class="chip is-mono" title="personaId">${escapeHtml(conversation.personaId === "" ? EMPTY : conversation.personaId)}</span>
${adminLink(conversation.adminUrl, "Άνοιγμα συνομιλίας στο admin")}
</p>
</div>
</details>`;
}

/**
 * Expectations. A failed row spans the full width and puts expected beside
 * actual, so the comparison never needs a scroll.
 */
function renderExpectations(expectations) {
  if (expectations.length === 0) {
    return `<section class="panel"><h4 class="panel-title">Έλεγχοι</h4><p class="empty">Δεν δηλώθηκε κανένας έλεγχος.</p></section>`;
  }
  const rows = expectations
    .map(
      (
        expectation,
      ) => `<li class="exp ${expectation.passed ? "is-pass" : "is-fail"}">
<p class="exp-head">${icon(expectation.passed ? "check" : "cross")}<span class="exp-label">${escapeHtml(expectation.label)}</span></p>
<div class="exp-values">
<div class="exp-value"><span class="kicker">Αναμενόταν</span><span>${escapeHtml(expectation.expected === "" ? EMPTY : expectation.expected)}</span></div>
<div class="exp-value"><span class="kicker">Βρέθηκε</span><span>${escapeHtml(expectation.actual === "" ? EMPTY : expectation.actual)}</span></div>
</div>
</li>`,
    )
    .join("");
  return `<section class="panel">
<h4 class="panel-title">Έλεγχοι</h4>
<ul class="exp-list">${rows}</ul>
</section>`;
}

/**
 * The transcript is a WhatsApp conversation between a person and a bot, so it
 * is rendered as one. `white-space: pre-wrap` keeps the participant's own line
 * breaks without ever building a tag out of their text.
 */
function renderTranscript(entries) {
  if (entries.length === 0) {
    return `<section class="panel"><h4 class="panel-title">Συνομιλία</h4><p class="empty">Κανένα μήνυμα.</p></section>`;
  }
  const first = Date.parse(entries[0].at);
  const bubbles = entries
    .map((entry, position) => {
      const side = entry.actor === "participant" ? "in" : "out";
      const actorLabel = ACTOR_LABELS[entry.actor] ?? entry.actor;
      const at = Date.parse(entry.at);
      // The gap since the first message is what makes a burst legible; on the
      // first message itself it would only ever read "+0,0".
      const offset =
        position > 0 &&
        Number.isFinite(first) &&
        Number.isFinite(at) &&
        at >= first
          ? `<span class="bubble-offset" title="Από την αρχή της συνομιλίας">+${escapeHtml(formatSeconds(at - first))}</span>`
          : "";
      return `<li class="bubble is-${side} is-actor-${slug(entry.actor)}">
<p class="bubble-actor"><span class="visually-hidden">Από: </span>${escapeHtml(actorLabel)}</p>
<p class="bubble-text">${escapeHtml(entry.text)}</p>
<p class="bubble-meta">${entry.seq === null ? "" : `<span class="bubble-seq">#${escapeHtml(String(entry.seq))}</span>`}<span title="${escapeHtml(entry.at)}">${escapeHtml(formatClock(entry.at))}</span>${offset}</p>
</li>`;
    })
    .join("");
  return `<section class="panel">
<h4 class="panel-title">${icon("chat")}Συνομιλία<span class="panel-count">${escapeHtml(count(entries.length, "μήνυμα", "μηνύματα"))}</span></h4>
<ol class="thread">${bubbles}</ol>
</section>`;
}

/**
 * What actually reached the phone. Repeated text is annotated with the earlier
 * position rather than judged: the `findings` list is the authority on whether
 * a repeat is a duplicate outbound, but an operator reading this column should
 * not have to spot the repetition by eye.
 */
function renderReceived(received) {
  if (received.length === 0) {
    return `<section class="panel"><h4 class="panel-title">Τι έφτασε στο τηλέφωνο</h4><p class="empty">Δεν έφτασε κανένα μήνυμα.</p></section>`;
  }
  const seen = new Map();
  const items = received
    .map((message, position) => {
      const earlier = seen.get(message);
      if (earlier === undefined) {
        seen.set(message, position + 1);
      }
      const repeat =
        earlier === undefined
          ? ""
          : `<span class="chip is-warning">ίδιο κείμενο με το #${escapeHtml(String(earlier))}</span>`;
      return `<li class="sent${earlier === undefined ? "" : " is-repeat"}">
<p class="sent-head"><span class="sent-index">#${escapeHtml(String(position + 1))}</span>${repeat}</p>
<p class="sent-text">${escapeHtml(message)}</p>
</li>`;
    })
    .join("");
  return `<section class="panel">
<h4 class="panel-title">${icon("outbound")}Τι έφτασε στο τηλέφωνο<span class="panel-count">${escapeHtml(count(received.length, "μήνυμα", "μηνύματα"))}</span></h4>
<ol class="sent-list">${items}</ol>
</section>`;
}

function renderActual(actual) {
  const lifecycleLabel = LIFECYCLE_LABELS[actual.lifecycle] ?? actual.lifecycle;
  const closedBecause =
    actual.closedBecause === null
      ? null
      : (CLOSED_BECAUSE_LABELS[actual.closedBecause] ?? actual.closedBecause);

  const badges = [
    `<span class="badge is-${actual.lifecycle === "closed" ? "neutral" : "info"}">${escapeHtml(lifecycleLabel === "" ? EMPTY : lifecycleLabel)}${closedBecause === null ? "" : ` <span class="dot">·</span> ${escapeHtml(closedBecause)}`}</span>`,
    `<span class="badge is-${actual.optedIn ? "success" : "neutral"}">${actual.optedIn ? "Έδωσε συναίνεση" : "Χωρίς συναίνεση"}</span>`,
    actual.needsAttention
      ? '<span class="badge is-warning is-strong">Χρειάζεται προσοχή</span>'
      : "",
    `<span class="badge is-neutral">${escapeHtml(count(actual.modelCalls ?? 0, "κλήση μοντέλου", "κλήσεις μοντέλου"))}</span>`,
  ].join("");

  const answers =
    actual.answers.length === 0
      ? '<p class="empty">Καμία απάντηση δεν καταγράφηκε.</p>'
      : `<ul class="facts">${actual.answers
          .map((answer) => {
            const label = QUESTION_LABELS[answer.question] ?? answer.question;
            const value =
              answer.value === null
                ? (answer.about ?? EMPTY)
                : String(answer.value);
            const about =
              answer.about === null || answer.value === null
                ? ""
                : ` <span class="fact-about">${escapeHtml(answer.about)}</span>`;
            return `<li class="fact"><span class="kicker">${escapeHtml(label)}</span><span class="fact-value">${escapeHtml(value)}${about}</span></li>`;
          })
          .join("")}</ul>`;

  const notes =
    actual.notes.length === 0
      ? ""
      : `<ul class="notes">${actual.notes
          .map((note) => {
            const label = NOTE_TYPE_LABELS[note.type] ?? note.type;
            return `<li class="note${note.flagged ? " is-flagged" : ""}">
<p class="note-head"><span class="kicker">${escapeHtml(label)}</span>${note.about === null ? "" : `<span class="chip">${escapeHtml(note.about)}</span>`}${note.flagged ? '<span class="chip is-warning">Για έλεγχο</span>' : ""}</p>
<p class="note-text">${escapeHtml(note.text)}</p>
</li>`;
          })
          .join("")}</ul>`;

  return `<section class="panel">
<h4 class="panel-title">Τι κατέγραψε ο μηχανισμός</h4>
<p class="badge-row">${badges}</p>
<p class="kicker panel-sub">Απαντήσεις</p>
${answers}
${notes === "" ? "" : '<p class="kicker panel-sub">Σημειώσεις</p>'}
${notes}
</section>`;
}

function renderFooter() {
  return `<footer class="footer">
<p>Παράχθηκε από <code>scripts/burst-report.mjs</code>. Αυτόνομο αρχείο: κανένα εξωτερικό stylesheet, script ή γραμματοσειρά — ανοίγει από τον δίσκο και εκτός δικτύου.</p>
</footer>`;
}

/* -----------------------------------------------------------------------------
   Small helpers.
   ----------------------------------------------------------------------------- */

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * The single escape for everything that came out of `result`, used for text and
 * attribute positions alike. Quotes are included so it is safe in both.
 */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char]);
}

/**
 * `adminUrl` is data like anything else. Only http(s), same-document and
 * root-relative links become links; anything else (`javascript:`, `data:`) is
 * shown as inert text so the report can never be made to run its own input.
 */
function safeHref(value) {
  const raw = text(value).trim();
  if (raw === "") {
    return null;
  }
  if (raw.startsWith("#") || raw.startsWith("/")) {
    return raw.startsWith("//") ? null : raw;
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(raw);
  if (scheme === null) {
    return null;
  }
  const protocol = scheme[1].toLowerCase();
  return protocol === "http" || protocol === "https" ? raw : null;
}

function adminLink(value, label) {
  const href = safeHref(value);
  if (href === null) {
    return text(value) === ""
      ? ""
      : `<span class="chip is-mono" title="Μη ασφαλής σύνδεσμος — δεν έγινε link">${escapeHtml(value)}</span>`;
  }
  return `<a class="admin-link" href="${escapeHtml(href)}" rel="noreferrer">${icon("external")}${escapeHtml(label)}</a>`;
}

function icon(name) {
  const paths = ICON_PATHS[name];
  if (paths === undefined) {
    return "";
  }
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

/** Ids come from the runner, so they are reduced to a safe anchor token. */
function slug(value) {
  const cleaned = text(value)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return cleaned === "" ? "x" : cleaned;
}

function conversationAnchor(conversationId) {
  return `syn-${slug(conversationId)}`;
}

function campaignAnchor(campaign) {
  return `kmp-${slug(campaign.slug === "" ? campaign.campaignId : campaign.slug)}`;
}

/** Greek needs the singular and the plural spelled out, not an "(s)". */
function count(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatDuration(durationMs) {
  if (durationMs === null || durationMs < 0) {
    return EMPTY;
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }
  if (durationMs < 60_000) {
    return `${formatSeconds(durationMs)}`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes} λ ${String(seconds).padStart(2, "0")} δλ`;
}

/** One decimal, Greek decimal comma. */
function formatSeconds(durationMs) {
  return `${(durationMs / 1000).toFixed(1).replace(".", ",")} δλ`;
}

/** Timestamps are shown exactly as the runner wrote them; no timezone maths. */
function isoParts(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/u.exec(
    text(value),
  );
  return match === null ? null : { date: match[1], time: match[2] };
}

function formatTimestamp(value) {
  const parts = isoParts(value);
  if (parts === null) {
    return text(value) === "" ? EMPTY : text(value);
  }
  return `${parts.date} ${parts.time}`;
}

function formatClock(value) {
  const parts = isoParts(value);
  return parts === null
    ? text(value) === ""
      ? EMPTY
      : text(value)
    : parts.time;
}

/* -----------------------------------------------------------------------------
   The stylesheet.

   Nothing from `result` is interpolated here. The `--jts-*` block is copied
   verbatim from `packages/design-tokens/src/tokens.css` (the subset this page
   uses, primitives included, under the same names) because a file opened from
   disk cannot import it. The one deliberate change: the admin flips theme on
   the `dark` class that `useTheme()` owns, and a standalone report has no such
   store, so the dark layer moves into `prefers-color-scheme: dark` — same
   values, different signal. Change a colour in `tokens.css` and the same lines
   change here.
   ----------------------------------------------------------------------------- */

const STYLES = `
:root {
  color-scheme: light;

  /* Primitives — tokens.css §1. Defining semantics only. */
  --jts-wine-100: #fde7ea;
  --jts-wine-200: #f9ccd4;
  --jts-wine-300: #f0a2b1;
  --jts-wine-400: #de6f84;
  --jts-wine-500: #c8455f;
  --jts-wine-700: #86223b;
  --jts-wine-800: #6d1f33;
  --jts-wine-900: #591d2e;
  --jts-clay-0: #ffffff;
  --jts-clay-50: #fffdfb;
  --jts-clay-150: #faece6;
  --jts-clay-200: #f4e1da;
  --jts-clay-300: #e9d5cd;
  --jts-clay-400: #d5bbb2;
  --jts-clay-600: #6f5961;
  --jts-clay-900: #1e131a;
  --jts-clay-950: #150c10;
  --jts-forest-50: #edf4ef;
  --jts-forest-300: #74bd93;
  --jts-forest-600: #1f6b45;
  --jts-amber-50: #f9f0df;
  --jts-amber-300: #dfa74d;
  --jts-amber-600: #8a5207;
  --jts-terracotta-50: #fbe9e5;
  --jts-terracotta-300: #e78979;
  --jts-terracotta-600: #b42318;
  --jts-slate-50: #ecf0f4;
  --jts-slate-300: #8fa3b7;
  --jts-slate-600: #3b4f63;
  --jts-copper-300: #dda283;
  --jts-copper-500: #bd6945;

  /* Semantic — tokens.css §2 (light). */
  --jts-color-canvas: var(--jts-clay-150);
  --jts-color-surface: var(--jts-clay-50);
  --jts-color-surface-raised: var(--jts-clay-0);
  --jts-color-surface-sunken: var(--jts-clay-200);
  --jts-color-surface-strong: var(--jts-wine-900);
  --jts-color-border-subtle: color-mix(in srgb, var(--jts-clay-400) 40%, transparent);
  --jts-color-border: var(--jts-clay-300);
  --jts-color-border-strong: var(--jts-clay-400);
  --jts-color-text: #24161b;
  --jts-color-text-muted: var(--jts-clay-600);
  --jts-color-text-subtle: #7f6a71;
  --jts-color-text-on-strong: #fbeef0;
  --jts-color-text-on-strong-muted: color-mix(in srgb, #fbeef0 64%, transparent);
  --jts-color-primary: var(--jts-wine-700);
  --jts-color-primary-contrast: #ffffff;
  --jts-color-primary-soft: var(--jts-wine-100);
  --jts-color-primary-border: color-mix(in srgb, var(--jts-wine-700) 24%, var(--jts-clay-300));
  --jts-color-accent: var(--jts-copper-500);
  --jts-color-link: var(--jts-wine-700);
  --jts-color-link-hover: var(--jts-wine-800);
  --jts-color-focus: var(--jts-wine-500);
  --jts-color-success: var(--jts-forest-600);
  --jts-color-success-soft: var(--jts-forest-50);
  --jts-color-success-border: color-mix(in srgb, var(--jts-forest-600) 26%, transparent);
  --jts-color-warning: var(--jts-amber-600);
  --jts-color-warning-soft: var(--jts-amber-50);
  --jts-color-warning-border: color-mix(in srgb, var(--jts-amber-600) 30%, transparent);
  --jts-color-danger: var(--jts-terracotta-600);
  --jts-color-danger-soft: var(--jts-terracotta-50);
  --jts-color-danger-border: color-mix(in srgb, var(--jts-terracotta-600) 28%, transparent);
  --jts-color-info: var(--jts-slate-600);
  --jts-color-info-soft: var(--jts-slate-50);
  --jts-color-info-border: color-mix(in srgb, var(--jts-slate-600) 26%, transparent);
  --jts-color-highlight: var(--jts-wine-100);
  --jts-color-highlight-text: var(--jts-wine-800);

  /* Type, space, radius, shadow, motion — tokens.css §3. */
  --jts-font-sans: "Manrope Variable", "Manrope", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --jts-font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --jts-weight-regular: 400;
  --jts-weight-medium: 500;
  --jts-weight-semibold: 600;
  --jts-weight-bold: 700;
  --jts-weight-extrabold: 800;
  --jts-text-2xs: 0.625rem;
  --jts-text-xs: 0.75rem;
  --jts-text-sm: 0.875rem;
  --jts-text-md: 1rem;
  --jts-text-lg: clamp(1.0625rem, 1rem + 0.2vw, 1.2rem);
  --jts-text-xl: clamp(1.35rem, 1.15rem + 0.7vw, 1.75rem);
  --jts-text-2xl: clamp(1.75rem, 1.4rem + 1.4vw, 2.6rem);
  --jts-text-3xl: clamp(2.4rem, 1.8rem + 2.6vw, 4rem);
  --jts-leading-tight: 1.1;
  --jts-leading-snug: 1.35;
  --jts-leading-body: 1.6;
  --jts-tracking-tight: -0.02em;
  --jts-tracking-caps: 0.12em;
  --jts-space-1: 0.25rem;
  --jts-space-2: 0.5rem;
  --jts-space-3: 0.75rem;
  --jts-space-4: 1rem;
  --jts-space-5: 1.25rem;
  --jts-space-6: 1.5rem;
  --jts-space-8: 2rem;
  --jts-space-10: 2.5rem;
  --jts-space-12: 3rem;
  --jts-radius-xs: 0.25rem;
  --jts-radius-sm: 0.4rem;
  --jts-radius-md: 0.6rem;
  --jts-radius-lg: 0.85rem;
  --jts-radius-xl: 1.1rem;
  --jts-radius-pill: 999px;
  --jts-shadow-xs: 0 1px 2px rgb(52 11 24 / 6%);
  --jts-shadow-sm: 0 1px 2px rgb(52 11 24 / 6%), 0 1px 3px rgb(52 11 24 / 4%);
  --jts-shadow-md: 0 6px 16px -6px rgb(52 11 24 / 12%), 0 2px 6px -3px rgb(52 11 24 / 8%);
  --jts-duration-fast: 120ms;
  --jts-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --jts-content-width: 96rem;
}

/* tokens.css §4 — the dark semantic layer. The admin keys this off the \`dark\`
   class owned by useTheme(); a file on disk has no such control, so the only
   honest signal left is the browser's own preference. */
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --jts-color-canvas: var(--jts-clay-950);
    --jts-color-surface: var(--jts-clay-900);
    --jts-color-surface-raised: #281922;
    --jts-color-surface-sunken: #170e13;
    --jts-color-surface-strong: #24101a;
    --jts-color-border-subtle: color-mix(in srgb, #ffffff 6%, transparent);
    --jts-color-border: #3f2a33;
    --jts-color-border-strong: #573a46;
    --jts-color-text: #fbeef0;
    --jts-color-text-muted: #d2b9c1;
    --jts-color-text-subtle: #a78c96;
    --jts-color-text-on-strong: #fbeef0;
    --jts-color-text-on-strong-muted: color-mix(in srgb, #fbeef0 60%, transparent);
    --jts-color-primary: var(--jts-wine-300);
    --jts-color-primary-contrast: #33101a;
    --jts-color-primary-soft: color-mix(in srgb, var(--jts-wine-500) 20%, var(--jts-clay-900));
    --jts-color-primary-border: color-mix(in srgb, var(--jts-wine-300) 26%, transparent);
    --jts-color-accent: var(--jts-copper-300);
    --jts-color-link: var(--jts-wine-300);
    --jts-color-link-hover: var(--jts-wine-200);
    --jts-color-focus: var(--jts-wine-300);
    --jts-color-success: var(--jts-forest-300);
    --jts-color-success-soft: color-mix(in srgb, var(--jts-forest-600) 24%, var(--jts-clay-900));
    --jts-color-success-border: color-mix(in srgb, var(--jts-forest-300) 30%, transparent);
    --jts-color-warning: var(--jts-amber-300);
    --jts-color-warning-soft: color-mix(in srgb, var(--jts-amber-600) 26%, var(--jts-clay-900));
    --jts-color-warning-border: color-mix(in srgb, var(--jts-amber-300) 30%, transparent);
    --jts-color-danger: var(--jts-terracotta-300);
    --jts-color-danger-soft: color-mix(in srgb, var(--jts-terracotta-600) 26%, var(--jts-clay-900));
    --jts-color-danger-border: color-mix(in srgb, var(--jts-terracotta-300) 30%, transparent);
    --jts-color-info: var(--jts-slate-300);
    --jts-color-info-soft: color-mix(in srgb, var(--jts-slate-600) 26%, var(--jts-clay-900));
    --jts-color-info-border: color-mix(in srgb, var(--jts-slate-300) 30%, transparent);
    --jts-color-highlight: color-mix(in srgb, var(--jts-wine-400) 26%, transparent);
    --jts-color-highlight-text: #fbeff0;
    --jts-shadow-xs: 0 1px 2px rgb(0 0 0 / 40%);
    --jts-shadow-sm: 0 1px 2px rgb(0 0 0 / 40%), 0 1px 3px rgb(0 0 0 / 30%);
    --jts-shadow-md: 0 8px 20px -6px rgb(0 0 0 / 55%), 0 2px 8px -3px rgb(0 0 0 / 40%);
  }
}

/* --- base ---------------------------------------------------------------- */

*, *::before, *::after { box-sizing: border-box; }

html {
  min-width: 20rem;
  background: var(--jts-color-canvas);
  color: var(--jts-color-text);
  font-family: var(--jts-font-sans);
  font-size: 100%;
  line-height: var(--jts-leading-body);
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  scroll-behavior: smooth;
}

body { margin: 0; }

h1, h2, h3, h4 {
  margin: 0;
  line-height: var(--jts-leading-tight);
  letter-spacing: var(--jts-tracking-tight);
  text-wrap: balance;
}

p { margin: 0; text-wrap: pretty; }
ul, ol { margin: 0; padding: 0; list-style: none; }

code {
  font-family: var(--jts-font-mono);
  font-size: 0.92em;
  overflow-wrap: anywhere;
}

a { color: var(--jts-color-link); }
a:hover { color: var(--jts-color-link-hover); }

::selection {
  background: var(--jts-color-highlight);
  color: var(--jts-color-highlight-text);
}

:focus-visible {
  outline: 2px solid var(--jts-color-focus);
  outline-offset: 3px;
  border-radius: var(--jts-radius-xs);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}

.icon {
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
  vertical-align: -0.125em;
}

/* The metadata recipe (tokens.css type scale + the admin's jts-overline):
   2xs, extrabold, uppercase, caps tracking. Greek uppercase drops its accents
   correctly because the document is lang="el". */
.kicker {
  display: block;
  font-size: var(--jts-text-2xs);
  font-weight: var(--jts-weight-extrabold);
  text-transform: uppercase;
  letter-spacing: var(--jts-tracking-caps);
  color: var(--jts-color-text-muted);
}

/* One rule keeps every theme at AA: --jts-color-text-subtle is tuned for
   --jts-color-surface and -raised, and drops to ~4.3:1 on the tinted
   backgrounds this page also uses (canvas, -sunken, the *-soft status fills).
   Anywhere but a plain card, metadata uses --jts-color-text-muted. */
.dot { color: var(--jts-color-text-muted); }

.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.skip-link {
  position: absolute;
  left: var(--jts-space-4);
  top: -4rem;
  z-index: 60;
  padding: var(--jts-space-2) var(--jts-space-4);
  background: var(--jts-color-surface-raised);
  border: 1px solid var(--jts-color-border);
  border-radius: var(--jts-radius-sm);
  font-weight: var(--jts-weight-semibold);
  text-decoration: none;
}
.skip-link:focus { top: var(--jts-space-4); }

/* JS-only controls stay out of the document until the script has run. */
.js-only { display: none; }
.js .js-only { display: flex; }

/* --- masthead ------------------------------------------------------------ */

.masthead {
  background: var(--jts-color-surface-strong);
  color: var(--jts-color-text-on-strong);
  padding: var(--jts-space-5) var(--jts-space-6) var(--jts-space-6);
}

.masthead-inner,
.rail-inner,
.page,
.footer-inner {
  max-width: var(--jts-content-width);
  margin-inline: auto;
}

.masthead-inner {
  display: flex;
  flex-wrap: wrap;
  gap: var(--jts-space-5);
  align-items: center;
  justify-content: space-between;
}

.masthead-brand { display: flex; gap: var(--jts-space-3); align-items: center; }
.masthead-brand .kicker { color: var(--jts-color-text-on-strong-muted); }

.masthead-title {
  display: block;
  font-size: var(--jts-text-lg);
  font-weight: var(--jts-weight-bold);
  letter-spacing: var(--jts-tracking-tight);
}

/* The six-dot brand mark, copied from apps/admin/src/styles/globals.css. */
.brand-mark {
  display: inline-block;
  width: 1.7rem;
  height: 1.7rem;
  flex: 0 0 auto;
  border: 1.5px solid currentcolor;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 12%, currentcolor 0 1.5px, transparent 2px),
    radial-gradient(circle at 83% 31%, currentcolor 0 1.5px, transparent 2px),
    radial-gradient(circle at 83% 69%, currentcolor 0 1.5px, transparent 2px),
    radial-gradient(circle at 50% 88%, currentcolor 0 1.5px, transparent 2px),
    radial-gradient(circle at 17% 69%, currentcolor 0 1.5px, transparent 2px),
    radial-gradient(circle at 17% 31%, currentcolor 0 1.5px, transparent 2px);
}

.masthead-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--jts-space-5);
  margin: 0;
}
.masthead-meta-item { display: grid; grid-template-columns: auto auto; gap: 0 var(--jts-space-2); }
.masthead-meta-item .icon { grid-row: 1 / 3; align-self: center; color: var(--jts-color-text-on-strong-muted); }
.masthead-meta dt {
  font-size: var(--jts-text-2xs);
  font-weight: var(--jts-weight-extrabold);
  text-transform: uppercase;
  letter-spacing: var(--jts-tracking-caps);
  color: var(--jts-color-text-on-strong-muted);
}
.masthead-meta dd {
  margin: 0;
  font-size: var(--jts-text-sm);
  font-weight: var(--jts-weight-semibold);
  font-variant-numeric: tabular-nums;
}

.masthead-note {
  max-width: var(--jts-content-width);
  margin: var(--jts-space-4) auto 0;
  font-size: var(--jts-text-sm);
  color: var(--jts-color-text-on-strong-muted);
}
.masthead-note span { display: block; max-inline-size: 76ch; }

/* --- sticky rail --------------------------------------------------------- */

.rail {
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--jts-color-surface);
  border-bottom: 1px solid var(--jts-color-border);
  box-shadow: var(--jts-shadow-xs);
}

.rail-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--jts-space-3) var(--jts-space-4);
  padding: var(--jts-space-3) var(--jts-space-6);
}

.rail-count {
  font-size: var(--jts-text-sm);
  font-weight: var(--jts-weight-semibold);
  font-variant-numeric: tabular-nums;
  color: var(--jts-color-text-muted);
}
.rail-sep { color: var(--jts-color-text-muted); padding-inline: 0.1em; }

.rail-jumps { display: flex; flex-wrap: wrap; gap: var(--jts-space-2); }

.rail-jump {
  padding: var(--jts-space-1) var(--jts-space-3);
  border: 1px solid var(--jts-color-border);
  border-radius: var(--jts-radius-pill);
  background: var(--jts-color-surface-raised);
  color: var(--jts-color-text-muted);
  font-size: var(--jts-text-xs);
  font-weight: var(--jts-weight-semibold);
  text-decoration: none;
}
.rail-jump:hover { border-color: var(--jts-color-border-strong); color: var(--jts-color-text); }
.rail-jump.is-fail {
  border-color: var(--jts-color-danger-border);
  background: var(--jts-color-danger-soft);
  color: var(--jts-color-danger);
}

.rail-tools { margin-inline-start: auto; gap: var(--jts-space-3); align-items: center; flex-wrap: wrap; }

.toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--jts-space-2);
  font-size: var(--jts-text-xs);
  font-weight: var(--jts-weight-semibold);
  color: var(--jts-color-text-muted);
  cursor: pointer;
}
.toggle input { accent-color: var(--jts-color-primary); width: 1rem; height: 1rem; }

.button {
  padding: var(--jts-space-1) var(--jts-space-3);
  border: 1px solid var(--jts-color-border);
  border-radius: var(--jts-radius-sm);
  background: var(--jts-color-surface-raised);
  color: var(--jts-color-text-muted);
  font: inherit;
  font-size: var(--jts-text-xs);
  font-weight: var(--jts-weight-semibold);
  cursor: pointer;
}
.button:hover { border-color: var(--jts-color-border-strong); color: var(--jts-color-text); }

/* --- page ---------------------------------------------------------------- */

.page {
  padding: var(--jts-space-8) var(--jts-space-6) var(--jts-space-12);
  display: flex;
  flex-direction: column;
  gap: var(--jts-space-8);
}

.section-title {
  display: flex;
  align-items: baseline;
  gap: var(--jts-space-3);
  font-size: var(--jts-text-lg);
  font-weight: var(--jts-weight-bold);
}
.section-title::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--jts-color-border-subtle);
}
.section-count {
  font-size: var(--jts-text-xs);
  font-weight: var(--jts-weight-extrabold);
  font-variant-numeric: tabular-nums;
  color: var(--jts-color-text-muted);
}
.section-lede {
  margin-top: var(--jts-space-2);
  font-size: var(--jts-text-sm);
  color: var(--jts-color-text-muted);
  max-inline-size: 72ch;
}

/* --- verdict ------------------------------------------------------------- */

.verdict {
  display: flex;
  gap: var(--jts-space-5);
  align-items: center;
  padding: var(--jts-space-6);
  border: 1px solid var(--jts-color-border);
  /* The 3px marker: "something happened". Vertical on an accented card. */
  border-inline-start: 3px solid var(--jts-color-border-strong);
  border-radius: var(--jts-radius-lg);
  background: var(--jts-color-surface);
}
.verdict.is-success {
  border-color: var(--jts-color-success-border);
  border-inline-start-color: var(--jts-color-success);
  background: var(--jts-color-success-soft);
}
.verdict.is-danger {
  border-color: var(--jts-color-danger-border);
  border-inline-start-color: var(--jts-color-danger);
  background: var(--jts-color-danger-soft);
}
.verdict-mark { font-size: clamp(2rem, 1.4rem + 2.4vw, 3.4rem); display: flex; }
.verdict.is-success .verdict-mark { color: var(--jts-color-success); }
.verdict.is-danger .verdict-mark { color: var(--jts-color-danger); }
.verdict-body { min-width: 0; }
.verdict h1 {
  font-size: var(--jts-text-3xl);
  font-weight: var(--jts-weight-extrabold);
  text-transform: uppercase;
  margin-block: var(--jts-space-1);
}
.verdict.is-success h1 { color: var(--jts-color-success); }
.verdict.is-danger h1 { color: var(--jts-color-danger); }
.verdict-lines {
  font-size: var(--jts-text-md);
  font-weight: var(--jts-weight-semibold);
  color: var(--jts-color-text);
}
.verdict-warning {
  display: flex;
  gap: var(--jts-space-2);
  margin-top: var(--jts-space-3);
  padding: var(--jts-space-3);
  border: 1px solid var(--jts-color-warning-border);
  border-radius: var(--jts-radius-sm);
  background: var(--jts-color-warning-soft);
  color: var(--jts-color-warning);
  font-size: var(--jts-text-sm);
  font-weight: var(--jts-weight-semibold);
}

/* --- stats --------------------------------------------------------------- */

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--jts-space-3);
}
.tile {
  padding: var(--jts-space-4);
  border: 1px solid var(--jts-color-border);
  border-radius: var(--jts-radius-md);
  background: var(--jts-color-surface);
}
.tile-value {
  font-size: var(--jts-text-xl);
  font-weight: var(--jts-weight-extrabold);
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--jts-tracking-tight);
  line-height: var(--jts-leading-tight);
}
.tile.is-danger .tile-value { color: var(--jts-color-danger); }
.tile.is-success .tile-value { color: var(--jts-color-success); }
.tile .kicker { margin-top: var(--jts-space-2); }
.tile-hint {
  font-size: var(--jts-text-xs);
  color: var(--jts-color-text-subtle);
  line-height: var(--jts-leading-snug);
}

/* --- findings ------------------------------------------------------------ */

.findings-clean {
  display: flex;
  gap: var(--jts-space-2);
  align-items: flex-start;
  margin-top: var(--jts-space-3);
  padding: var(--jts-space-4);
  border: 1px solid var(--jts-color-success-border);
  border-radius: var(--jts-radius-md);
  background: var(--jts-color-success-soft);
  color: var(--jts-color-success);
  font-size: var(--jts-text-sm);
  font-weight: var(--jts-weight-semibold);
}

.finding-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
  gap: var(--jts-space-3);
  margin-top: var(--jts-space-4);
}
.finding {
  display: flex;
  flex-direction: column;
  gap: var(--jts-space-2);
  padding: var(--jts-space-4);
  border: 1px solid var(--jts-color-danger-border);
  border-inline-start: 3px solid var(--jts-color-danger);
  border-radius: var(--jts-radius-md);
  background: var(--jts-color-surface);
}
.finding-kind {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--jts-space-1) var(--jts-space-2);
  color: var(--jts-color-danger);
  font-size: var(--jts-text-md);
  font-weight: var(--jts-weight-bold);
}
/* The raw kind moves to its own line rather than breaking mid-identifier. */
.finding-kind code {
  color: var(--jts-color-text-subtle);
  font-weight: var(--jts-weight-regular);
  overflow-wrap: normal;
  white-space: nowrap;
}
.finding-detail { font-size: var(--jts-text-sm); overflow-wrap: anywhere; }
.finding-involved {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--jts-space-2);
}
.finding-involved.is-empty { font-size: var(--jts-text-xs); color: var(--jts-color-text-subtle); }

/* --- failure index ------------------------------------------------------- */

.failure-chips {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: var(--jts-space-2);
  margin-top: var(--jts-space-4);
}
.failure-chip {
  padding: var(--jts-space-3) var(--jts-space-4);
  border: 1px solid var(--jts-color-danger-border);
  border-inline-start: 3px solid var(--jts-color-danger);
  border-radius: var(--jts-radius-sm);
  background: var(--jts-color-surface);
  text-decoration: none;
  color: inherit;
}
.failure-chip:hover { background: var(--jts-color-danger-soft); }
.failure-name {
  display: block;
  font-weight: var(--jts-weight-bold);
  overflow-wrap: anywhere;
}
.failure-meta { display: block; font-size: var(--jts-text-xs); color: var(--jts-color-text-muted); }

/* --- campaign ------------------------------------------------------------ */

.campaign { scroll-margin-top: 5.5rem; }
.campaign-head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--jts-space-4);
  align-items: flex-end;
  justify-content: space-between;
  padding-bottom: var(--jts-space-3);
  border-bottom: 1px solid var(--jts-color-border);
}
.campaign-identity { min-width: 0; }
.campaign-identity .kicker { display: flex; align-items: center; gap: var(--jts-space-2); }
.campaign-identity .kicker code { letter-spacing: 0; text-transform: none; }
.campaign-title {
  margin-top: var(--jts-space-1);
  font-size: var(--jts-text-xl);
  font-weight: var(--jts-weight-extrabold);
  overflow-wrap: anywhere;
}
/* The 3px marker, horizontal under the title of a section that broke. */
.campaign.is-fail .campaign-title::after {
  content: "";
  display: block;
  width: 3.5rem;
  height: 3px;
  margin-top: var(--jts-space-2);
  background: var(--jts-color-danger);
  border-radius: var(--jts-radius-pill);
}
.campaign-ids {
  margin-top: var(--jts-space-2);
  font-family: var(--jts-font-mono);
  font-size: var(--jts-text-xs);
  color: var(--jts-color-text-muted);
  overflow-wrap: anywhere;
}
.campaign-side { display: flex; flex-wrap: wrap; gap: var(--jts-space-2); align-items: center; }

.conv-list { display: flex; flex-direction: column; gap: var(--jts-space-2); margin-top: var(--jts-space-4); }

/* --- conversation row ---------------------------------------------------- */

.conv {
  border: 1px solid var(--jts-color-border);
  border-inline-start: 3px solid transparent;
  border-radius: var(--jts-radius-md);
  background: var(--jts-color-surface);
  scroll-margin-top: 5.5rem;
}
.conv.is-fail { border-color: var(--jts-color-danger-border); border-inline-start-color: var(--jts-color-danger); }
.conv:target { box-shadow: 0 0 0 3px color-mix(in srgb, var(--jts-color-focus) 30%, transparent); }

.conv-summary {
  display: grid;
  grid-template-columns: auto minmax(8rem, 1fr) auto auto;
  align-items: center;
  gap: var(--jts-space-1) var(--jts-space-3);
  padding: var(--jts-space-3) var(--jts-space-4);
  cursor: pointer;
  list-style: none;
}
.conv-summary::-webkit-details-marker { display: none; }
.conv-summary:hover { background: var(--jts-color-surface-sunken); border-radius: var(--jts-radius-sm); }

/* Every cell is placed by hand: auto-placement drops the row-spanning chevron
   into the name's column and throws the whole row out of order. */
.conv-summary > .badge { grid-column: 1; grid-row: 1 / 3; }
.conv-name {
  grid-column: 2;
  grid-row: 1;
  font-size: var(--jts-text-md);
  font-weight: var(--jts-weight-bold);
  overflow-wrap: anywhere;
  min-width: 0;
}
.conv-chips {
  grid-column: 3;
  grid-row: 1;
  display: flex;
  flex-wrap: wrap;
  gap: var(--jts-space-2);
  justify-content: flex-end;
}
.conv-chevron {
  grid-column: 4;
  grid-row: 1 / 3;
  color: var(--jts-color-text-muted);
  display: flex;
  transition: transform var(--jts-duration-fast) var(--jts-ease-standard);
}
.conv[open] > .conv-summary .conv-chevron { transform: rotate(90deg); }
.conv-quirk {
  grid-column: 2 / 4;
  grid-row: 2;
  font-size: var(--jts-text-sm);
  color: var(--jts-color-text-muted);
  overflow-wrap: anywhere;
}

@media (max-width: 60rem) {
  .conv-summary { grid-template-columns: auto minmax(0, 1fr) auto; }
  .conv-chips { grid-column: 1 / -1; grid-row: 3; justify-content: flex-start; }
  .conv-chevron { grid-column: 3; }
  .conv-quirk { grid-column: 2 / 4; }
}

.conv-body {
  display: grid;
  /* Two explicit columns, not auto-fit: auto-fit would open a third, empty
     track on a wide screen and squeeze both panels into the left half. */
  grid-template-columns: minmax(0, 1fr);
  gap: var(--jts-space-4);
  padding: var(--jts-space-4);
  border-top: 1px solid var(--jts-color-border-subtle);
  background: var(--jts-color-surface-sunken);
  border-end-start-radius: var(--jts-radius-md);
  border-end-end-radius: var(--jts-radius-md);
}
@media (min-width: 64rem) {
  .conv-body { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
/* Left: what the mechanism asserted, sent and recorded. Right: the
   conversation itself, so the delivered messages sit beside the thread that
   was supposed to produce them. */
.conv-col {
  display: flex;
  flex-direction: column;
  align-content: start;
  gap: var(--jts-space-4);
  min-width: 0;
}
.conv-foot {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: var(--jts-space-2);
  align-items: center;
}

/* --- panels -------------------------------------------------------------- */

.panel {
  padding: var(--jts-space-4);
  border: 1px solid var(--jts-color-border-subtle);
  border-radius: var(--jts-radius-md);
  background: var(--jts-color-surface-raised);
  min-width: 0;
}
.panel-title {
  display: flex;
  align-items: center;
  gap: var(--jts-space-2);
  font-size: var(--jts-text-sm);
  font-weight: var(--jts-weight-extrabold);
  text-transform: uppercase;
  letter-spacing: var(--jts-tracking-caps);
  color: var(--jts-color-text-muted);
}
.panel-count {
  margin-inline-start: auto;
  font-size: var(--jts-text-2xs);
  font-weight: var(--jts-weight-semibold);
  letter-spacing: 0;
  text-transform: none;
  color: var(--jts-color-text-muted);
}
.panel-sub { margin-top: var(--jts-space-4); }
.empty { margin-top: var(--jts-space-2); font-size: var(--jts-text-sm); color: var(--jts-color-text-muted); }

/* --- expectations -------------------------------------------------------- */

.exp-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: var(--jts-space-2);
  margin-top: var(--jts-space-3);
}
.exp {
  padding: var(--jts-space-3);
  border: 1px solid var(--jts-color-border-subtle);
  border-inline-start: 3px solid transparent;
  border-radius: var(--jts-radius-sm);
  min-width: 0;
}
.exp.is-pass { color: var(--jts-color-text-muted); }
.exp.is-pass .exp-head { color: var(--jts-color-success); }
/* A failed check takes the whole row so expected and actual sit side by side. */
.exp.is-fail {
  grid-column: 1 / -1;
  border-color: var(--jts-color-danger-border);
  border-inline-start-color: var(--jts-color-danger);
  background: var(--jts-color-danger-soft);
}
.exp.is-fail .exp-head { color: var(--jts-color-danger); }
.exp-head {
  display: flex;
  align-items: center;
  gap: var(--jts-space-2);
  font-weight: var(--jts-weight-bold);
  font-size: var(--jts-text-sm);
}
.exp-label { color: var(--jts-color-text); overflow-wrap: anywhere; }
.exp-values {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: var(--jts-space-1) var(--jts-space-3);
  margin-top: var(--jts-space-2);
}
.exp-value { min-width: 0; font-size: var(--jts-text-sm); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.exp.is-fail .exp-value:last-child { color: var(--jts-color-danger); font-weight: var(--jts-weight-semibold); }

/* --- transcript ---------------------------------------------------------- */

.thread { display: flex; flex-direction: column; gap: var(--jts-space-2); margin-top: var(--jts-space-3); }
.bubble {
  max-width: min(90%, 42rem);
  padding: var(--jts-space-2) var(--jts-space-3);
  border: 1px solid var(--jts-color-border-subtle);
  border-radius: var(--jts-radius-lg);
  min-width: 0;
}
.bubble.is-in {
  align-self: flex-start;
  border-start-start-radius: var(--jts-radius-xs);
  background: var(--jts-color-surface-sunken);
}
.bubble.is-out {
  align-self: flex-end;
  border-start-end-radius: var(--jts-radius-xs);
  background: var(--jts-color-primary-soft);
  border-color: var(--jts-color-primary-border);
}
.bubble.is-actor-staff { background: var(--jts-color-info-soft); border-color: var(--jts-color-info-border); }
.bubble-actor {
  font-size: var(--jts-text-2xs);
  font-weight: var(--jts-weight-extrabold);
  text-transform: uppercase;
  letter-spacing: var(--jts-tracking-caps);
  color: var(--jts-color-text-muted);
}
.bubble-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--jts-text-sm);
  line-height: var(--jts-leading-snug);
}
.bubble-meta {
  display: flex;
  gap: var(--jts-space-2);
  justify-content: flex-end;
  margin-top: var(--jts-space-1);
  font-size: var(--jts-text-2xs);
  font-variant-numeric: tabular-nums;
  color: var(--jts-color-text-muted);
}
.bubble-seq { margin-inline-end: auto; }
/* The gap since the first message is the thing you read a burst by, so it is
   weighted rather than tinted: --jts-color-accent on a tinted bubble is 3.2:1. */
.bubble-offset { font-weight: var(--jts-weight-bold); }

/* --- what reached the phone ---------------------------------------------- */

.sent-list { display: flex; flex-direction: column; gap: var(--jts-space-2); margin-top: var(--jts-space-3); }
.sent {
  padding: var(--jts-space-2) var(--jts-space-3);
  border: 1px solid var(--jts-color-border-subtle);
  border-inline-start: 3px solid transparent;
  border-radius: var(--jts-radius-sm);
  background: var(--jts-color-surface);
}
.sent.is-repeat {
  border-color: var(--jts-color-warning-border);
  border-inline-start-color: var(--jts-color-warning);
  background: var(--jts-color-warning-soft);
}
.sent-head { display: flex; flex-wrap: wrap; gap: var(--jts-space-2); align-items: center; }
.sent-index {
  font-size: var(--jts-text-2xs);
  font-weight: var(--jts-weight-extrabold);
  font-variant-numeric: tabular-nums;
  color: var(--jts-color-text-muted);
}
.sent-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--jts-text-sm); }

/* --- recorded state ------------------------------------------------------ */

.badge-row { display: flex; flex-wrap: wrap; gap: var(--jts-space-2); margin-top: var(--jts-space-3); }
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: var(--jts-space-2);
  margin-top: var(--jts-space-2);
}
.fact {
  padding: var(--jts-space-2) var(--jts-space-3);
  border: 1px solid var(--jts-color-border-subtle);
  border-radius: var(--jts-radius-sm);
  min-width: 0;
}
.fact-value {
  font-size: var(--jts-text-md);
  font-weight: var(--jts-weight-bold);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.fact-about { font-size: var(--jts-text-sm); font-weight: var(--jts-weight-regular); color: var(--jts-color-text-muted); }

.notes { display: flex; flex-direction: column; gap: var(--jts-space-2); margin-top: var(--jts-space-2); }
.note {
  padding: var(--jts-space-2) var(--jts-space-3);
  border: 1px solid var(--jts-color-border-subtle);
  border-inline-start: 3px solid transparent;
  border-radius: var(--jts-radius-sm);
}
.note.is-flagged { border-color: var(--jts-color-warning-border); border-inline-start-color: var(--jts-color-warning); }
.note-head { display: flex; flex-wrap: wrap; gap: var(--jts-space-2); align-items: center; }
.note-text { font-size: var(--jts-text-sm); white-space: pre-wrap; overflow-wrap: anywhere; }

/* --- badges and chips ---------------------------------------------------- */

.badge, .chip {
  display: inline-flex;
  align-items: center;
  gap: var(--jts-space-1);
  padding: var(--jts-space-1) var(--jts-space-3);
  border: 1px solid var(--jts-color-border);
  border-radius: var(--jts-radius-pill);
  background: var(--jts-color-surface-raised);
  color: var(--jts-color-text-muted);
  font-size: var(--jts-text-xs);
  font-weight: var(--jts-weight-semibold);
  line-height: var(--jts-leading-snug);
  white-space: nowrap;
}
.badge {
  font-size: var(--jts-text-2xs);
  font-weight: var(--jts-weight-extrabold);
  text-transform: uppercase;
  letter-spacing: var(--jts-tracking-caps);
}
.badge.is-success { color: var(--jts-color-success); background: var(--jts-color-success-soft); border-color: var(--jts-color-success-border); }
.badge.is-danger { color: var(--jts-color-danger); background: var(--jts-color-danger-soft); border-color: var(--jts-color-danger-border); }
.badge.is-warning { color: var(--jts-color-warning); background: var(--jts-color-warning-soft); border-color: var(--jts-color-warning-border); }
.badge.is-info { color: var(--jts-color-info); background: var(--jts-color-info-soft); border-color: var(--jts-color-info-border); }
/* The strong emphasis is the one badge an operator must not skim past: a solid
   fill, and still carrying its own label, never colour alone. */
.badge.is-strong.is-danger { background: var(--jts-color-danger); color: var(--jts-color-canvas); }
.badge.is-strong.is-warning { background: var(--jts-color-warning); color: var(--jts-color-canvas); }
.badge.is-strong.is-success { background: var(--jts-color-success); color: var(--jts-color-canvas); }

.chip.is-mono { font-family: var(--jts-font-mono); white-space: normal; overflow-wrap: anywhere; }
.chip.is-danger { color: var(--jts-color-danger); background: var(--jts-color-danger-soft); border-color: var(--jts-color-danger-border); }
.chip.is-warning { color: var(--jts-color-warning); background: var(--jts-color-warning-soft); border-color: var(--jts-color-warning-border); }
.chip.is-link { color: var(--jts-color-link); text-decoration: none; }
.chip.is-link:hover { border-color: var(--jts-color-primary-border); background: var(--jts-color-primary-soft); }

.admin-link {
  display: inline-flex;
  align-items: center;
  gap: var(--jts-space-2);
  padding: var(--jts-space-1) var(--jts-space-3);
  border: 1px solid var(--jts-color-primary-border);
  border-radius: var(--jts-radius-pill);
  background: var(--jts-color-primary-soft);
  color: var(--jts-color-primary);
  font-size: var(--jts-text-xs);
  font-weight: var(--jts-weight-semibold);
  text-decoration: none;
  white-space: nowrap;
}
.admin-link:hover { color: var(--jts-color-primary); border-color: var(--jts-color-primary); }

/* --- the failures filter (JS toggles one class on <body>) ----------------- */

body.is-filtered .conv.is-pass,
body.is-filtered .campaign.is-clean,
body.is-filtered .findings.is-clean { display: none; }
.filter-empty {
  display: none;
  padding: var(--jts-space-4);
  border: 1px solid var(--jts-color-border);
  border-radius: var(--jts-radius-md);
  background: var(--jts-color-surface);
  font-size: var(--jts-text-sm);
  color: var(--jts-color-text-muted);
}
body.is-filtered .filter-empty { display: block; }

/* --- footer -------------------------------------------------------------- */

.footer {
  border-top: 1px solid var(--jts-color-border);
  padding: var(--jts-space-5) var(--jts-space-6);
  font-size: var(--jts-text-xs);
  color: var(--jts-color-text-muted);
}
.footer p { max-width: var(--jts-content-width); margin-inline: auto; }
`;

/* -----------------------------------------------------------------------------
   The enhancement layer.

   It interpolates nothing — every value it touches is already in the DOM — and
   the page is complete without it: `<details>` collapses natively, the jump
   links are anchors, and the two controls this script owns are hidden until it
   has run.
   ----------------------------------------------------------------------------- */

const SCRIPT = `
(function () {
  var body = document.body;

  var filter = document.getElementById("filter-failures");
  if (filter) {
    filter.addEventListener("change", function () {
      body.classList.toggle("is-filtered", filter.checked);
    });
  }

  document.querySelectorAll("[data-expand]").forEach(function (button) {
    button.addEventListener("click", function () {
      var open = button.getAttribute("data-expand") === "open";
      document.querySelectorAll("details.conv").forEach(function (details) {
        details.open = open;
      });
    });
  });

  // A link into a collapsed conversation must land on an open one.
  function revealHash() {
    var hash = window.location.hash;
    if (hash.length < 2) {
      return;
    }
    var target = document.getElementById(decodeURIComponent(hash.slice(1)));
    while (target) {
      if (target.tagName === "DETAILS") {
        target.open = true;
      }
      target = target.parentElement;
    }
  }

  window.addEventListener("hashchange", revealHash);
  revealHash();
})();
`;
