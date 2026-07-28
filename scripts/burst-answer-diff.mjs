#!/usr/bin/env node

/**
 * Answers the rehearsal actually recorded, against the answers its fixtures
 * declare.
 *
 * The runner already asserts this per conversation, but it stops at the first
 * failure it reports and it says nothing about *which* answer went missing. This
 * prints the whole grid at once: one summary line, then every difference. It is
 * the tool for the question "did the extraction get worse, and where", which is
 * the only question worth asking between two paid runs.
 *
 * Identity is the reserved phone number, not the name: `burstPersonaPhoneE164`
 * derives it from the persona's campaign and ordinal, so renaming a persona in
 * the fixture cannot silently turn into a run of missing answers. The subject of
 * an answer is still matched by name, because that is what a fixture declares.
 *
 * A live guest is **observed, not graded**. Its fixture declares no answers at
 * all, because nobody can predict what an improvised person will say, so every
 * answer it produces is by definition undeclared. Counting those as `extra` is
 * what made one run read as four spurious failures. They are listed separately
 * below, as observations.
 *
 * Read-only: see `scripts/burst-inspect.mjs` for the scoping guarantee.
 */

import path from "node:path";

import {
  RESERVED_PHONE_PREFIX,
  openBurstInspection,
  repositoryRoot,
} from "./burst-inspect.mjs";

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const { BURST_PERSONAS } = await import(
    path.join(
      repositoryRoot,
      "apps/backend/dist/modules/post-event-feedback/burst/burst-personas.js",
    )
  );
  const { burstPersonaDisplayName, burstPersonaPhoneE164 } = await import(
    path.join(
      repositoryRoot,
      "apps/backend/dist/modules/post-event-feedback/burst/burst-scenario.js",
    )
  );

  const inspection = await openBurstInspection({
    applicationName: "burst-answer-diff",
  });
  try {
    const recorded = await recordedAnswersByPhone(inspection.pool);

    let matched = 0;
    let missing = 0;
    let extra = 0;
    const differences = [];
    const observations = [];

    for (const persona of BURST_PERSONAS) {
      const name = burstPersonaDisplayName(persona);
      const got = recorded.get(burstPersonaPhoneE164(persona)) ?? new Set();

      if (persona.live) {
        observations.push({ name, id: persona.id, got: [...got].sort() });
        continue;
      }

      const want = new Set(
        (persona.expect.answers ?? []).map((answer) =>
          answerKey({
            question: answer.question,
            about: answer.about,
            value: answer.value,
          }),
        ),
      );
      const absent = [...want].filter((key) => !got.has(key)).sort();
      const undeclared = [...got].filter((key) => !want.has(key)).sort();

      matched += [...want].filter((key) => got.has(key)).length;
      missing += absent.length;
      extra += undeclared.length;
      if (absent.length > 0 || undeclared.length > 0) {
        differences.push({ name, id: persona.id, absent, undeclared });
      }
    }

    console.log(`matched=${matched}  missing=${missing}  extra=${extra}`);
    console.log("(live guests are observed, not graded)\n");

    if (differences.length === 0) {
      console.log("Every scripted persona recorded exactly what it declared.");
    }
    for (const difference of differences) {
      console.log(`── ${difference.name}  (${difference.id})`);
      for (const key of difference.absent) {
        console.log(`   MISSING  ${key}`);
      }
      for (const key of difference.undeclared) {
        console.log(`   EXTRA    ${key}`);
      }
    }

    console.log("\n── live guests (observations, not assertions)");
    for (const observation of observations) {
      const summary = observation.got.length
        ? observation.got.join("  ")
        : "nothing recorded";
      console.log(`   ${observation.name}: ${summary}`);
    }
  } finally {
    await inspection.close();
  }
}

/**
 * Every answer the reserved block produced, keyed by the respondent's phone so
 * it lines up with what the fixture derives. The subject join is a left join
 * because most questions have no subject at all.
 */
async function recordedAnswersByPhone(pool) {
  const result = await pool.query(
    `select respondent.phone_e164 as phone,
            answer.question_key as question,
            answer.value_int as value,
            subject.preferred_name as about
       from feedback_answers answer
       join participants respondent
         on respondent.id = answer.respondent_participant_id
       left join participants subject
         on subject.id = answer.subject_participant_id
      where respondent.phone_e164 like $1`,
    [`${RESERVED_PHONE_PREFIX}%`],
  );

  const byPhone = new Map();
  for (const row of result.rows) {
    if (!byPhone.has(row.phone)) {
      byPhone.set(row.phone, new Set());
    }
    byPhone.get(row.phone).add(answerKey(row));
  }
  return byPhone;
}

/**
 * One comparable string per answer. Both sides go through this function so a
 * null subject and a null score are spelled the same way on both, which is the
 * only reason the set difference above means anything.
 */
function answerKey({ question, about, value }) {
  return `${question}|${about ?? ""}|${value ?? ""}`;
}
