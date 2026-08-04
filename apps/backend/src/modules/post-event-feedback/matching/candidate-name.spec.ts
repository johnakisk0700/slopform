import { describe, expect, it } from "vitest";

import {
  foldPostEventFeedbackName,
  resolvePostEventFeedbackCandidateByName,
} from "./candidate-name.js";

const NIKOS = { participantId: "p-nikos", displayName: "Νίκος" };
const ELENI = { participantId: "p-eleni", displayName: "Ελένη" };
const KOSTAS_P = { participantId: "p-kostas-p", displayName: "Κώστας Π." };
const KOSTAS_G = { participantId: "p-kostas-g", displayName: "Κώστας Γ." };
const MARI = {
  participantId: "p-mari",
  displayName: "Μάρη Μονοεμοτζούλα",
};

describe("foldPostEventFeedbackName", () => {
  it("lands both alphabets on the same skeleton", () => {
    expect(foldPostEventFeedbackName("Νίκος")).toBe(
      foldPostEventFeedbackName("Nikos"),
    );
    expect(foldPostEventFeedbackName("Ελένη")).toBe(
      foldPostEventFeedbackName("Eleni"),
    );
    expect(foldPostEventFeedbackName("Γιώργος")).toBe(
      foldPostEventFeedbackName("Giorgos"),
    );
  });

  it("absorbs the many ways one sound gets written", () => {
    // ι/η/υ/ει/οι are one sound and four spellings; ο/ω are one sound.
    expect(foldPostEventFeedbackName("Δήμητρα")).toBe(
      foldPostEventFeedbackName("Dimitra"),
    );
    expect(foldPostEventFeedbackName("Δημητρα")).toBe(
      foldPostEventFeedbackName("Dhmhtra"),
    );
    // χ is written x, h or ch depending on who is typing.
    expect(foldPostEventFeedbackName("Χάρης")).toBe(
      foldPostEventFeedbackName("Xaris"),
    );
    expect(foldPostEventFeedbackName("Χάρης")).toBe(
      foldPostEventFeedbackName("Charis"),
    );
  });

  it("folds «ου» whether it is typed `ou` or `oy`", () => {
    // `y` is how a Greek typing Latin letters writes υ — it is the shape, not
    // the sound — so «ου» arrives as `oy` about as often as `ou`. Until this
    // fold existed, «loyla» folded to `loila` and matched neither «loula» nor
    // «Λούλα»: the name resolved to nobody, the answer was never banked, and
    // the goal stayed open. Two live guests wrote it this way in one day's paid
    // rehearsals and were each asked the same question again and again.
    expect(foldPostEventFeedbackName("loyla")).toBe(
      foldPostEventFeedbackName("loula"),
    );
    expect(foldPostEventFeedbackName("loyla")).toBe(
      foldPostEventFeedbackName("Λούλα"),
    );
    expect(foldPostEventFeedbackName("Royla")).toBe(
      foldPostEventFeedbackName("Roula"),
    );
    expect(foldPostEventFeedbackName("Royla")).toBe(
      foldPostEventFeedbackName("Ρούλα"),
    );
    expect(foldPostEventFeedbackName("koyla")).toBe(
      foldPostEventFeedbackName("koula"),
    );
    // The two names the burst table deliberately collides still stay apart:
    // widening how «ου» is spelled must not widen who answers to it.
    expect(foldPostEventFeedbackName("loyla")).not.toBe(
      foldPostEventFeedbackName("Ρούλα"),
    );
  });

  it("keeps the case ending in the skeleton itself", () => {
    // The inflection fold is deliberately not here. The skeleton stays letter
    // for letter, and it is `candidateNameKeys` that lets a Τάκης answer to
    // «taki» — stripping the sigma inside the fold would run on the mention
    // too, and a mention in the genitive usually marks the *owner* of the
    // subject, not the subject: «ο φίλος της Ελένης» must never land on Ελένη.
    expect(foldPostEventFeedbackName("taki")).not.toBe(
      foldPostEventFeedbackName("takis"),
    );
    expect(foldPostEventFeedbackName("Ελένης")).not.toBe(
      foldPostEventFeedbackName("Ελένη"),
    );
  });

  it("keeps different names apart", () => {
    expect(foldPostEventFeedbackName("Νίκος")).not.toBe(
      foldPostEventFeedbackName("Ελένη"),
    );
    expect(foldPostEventFeedbackName("Μαρία")).not.toBe(
      foldPostEventFeedbackName("Μάριος"),
    );
  });
});

describe("resolvePostEventFeedbackCandidateByName", () => {
  it("resolves an unambiguous transliteration", () => {
    expect(
      resolvePostEventFeedbackCandidateByName("nikos", [NIKOS, ELENI]),
    ).toMatchObject({ participantId: "p-nikos" });
    // Rule 4β echoes names with the article the participant used; the article
    // word folds too short to match anybody, so only «Nikos» carries the match.
    expect(
      resolvePostEventFeedbackCandidateByName("o Nikos", [NIKOS, ELENI]),
    ).toMatchObject({ participantId: "p-nikos" });
  });

  it("resolves a mention that carries a Greek article before the name", () => {
    expect(
      resolvePostEventFeedbackCandidateByName("η Μαρη", [MARI, ELENI]),
    ).toMatchObject({ participantId: "p-mari" });
    expect(
      resolvePostEventFeedbackCandidateByName("ο Νίκος", [NIKOS, ELENI]),
    ).toMatchObject({ participantId: "p-nikos" });
    // A bare article has no addressable word and must not stand for a person.
    expect(
      resolvePostEventFeedbackCandidateByName("η", [MARI, ELENI]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName("ο", [NIKOS, ELENI]),
    ).toBeUndefined();
  });

  it("refuses to choose between two people with the same first name", () => {
    // The ordinary case at a table of six, and the one where a wrong guess
    // attributes somebody's opinion to the wrong real person.
    expect(
      resolvePostEventFeedbackCandidateByName("Κώστας", [
        KOSTAS_P,
        KOSTAS_G,
        NIKOS,
      ]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName("kostas", [KOSTAS_P, KOSTAS_G]),
    ).toBeUndefined();
  });

  it("resolves a first name against a candidate carrying a surname", () => {
    // A display name is normally the participant's preferred name — one word —
    // which is why comparing whole names worked. Where it carries a surname,
    // «O Tasos itan o kalyteros» resolved nobody and the directed answer was
    // dropped for a person named plainly and unambiguously.
    const TASOS = {
      participantId: "p-tasos",
      displayName: "Τάσος Γαμωσταυρίδης",
    };
    const MARIA = { participantId: "p-maria", displayName: "Μαρία Φλερτατζού" };

    expect(
      resolvePostEventFeedbackCandidateByName("Τάσος", [TASOS, MARIA]),
    ).toMatchObject({ participantId: "p-tasos" });
    expect(
      resolvePostEventFeedbackCandidateByName("Tasos", [TASOS, MARIA]),
    ).toMatchObject({ participantId: "p-tasos" });
    // The surname alone still names exactly one person.
    expect(
      resolvePostEventFeedbackCandidateByName("Γαμωσταυρίδης", [TASOS, MARIA]),
    ).toMatchObject({ participantId: "p-tasos" });
    // And the full name keeps working in either alphabet.
    expect(
      resolvePostEventFeedbackCandidateByName("Tasos Gamostavridis", [
        TASOS,
        MARIA,
      ]),
    ).toMatchObject({ participantId: "p-tasos" });
  });

  it("still refuses two people who share a first name but not a surname", () => {
    // The wine table really has two Κώστας. Recognising first names must not
    // become choosing between them — that attributes an opinion to the wrong
    // real person, which is worse than recording nothing.
    const MYTO = {
      participantId: "p-myto",
      displayName: "Κώστας Μυτοχωνάκιας",
    };
    const SVISTO = {
      participantId: "p-svisto",
      displayName: "Κώστας Σβηστομετανιώτης",
    };

    expect(
      resolvePostEventFeedbackCandidateByName("Κώστας", [MYTO, SVISTO]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName("kostas", [MYTO, SVISTO]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName("ο Κώστας", [MYTO, SVISTO]),
    ).toBeUndefined();
    // Each is still reachable by the half that is his alone.
    expect(
      resolvePostEventFeedbackCandidateByName("Μυτοχωνάκιας", [MYTO, SVISTO]),
    ).toMatchObject({ participantId: "p-myto" });
  });

  it("does not let an initial or an article stand for a person", () => {
    // «Κώστας Π.» has one addressable word, not two, or every candidate with a
    // «Π.» would answer to it.
    expect(
      resolvePostEventFeedbackCandidateByName("Π.", [KOSTAS_P, NIKOS]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName("Κώστας", [KOSTAS_P, NIKOS]),
    ).toMatchObject({ participantId: "p-kostas-p" });
  });

  it("resolves the greeklish `oy` spelling to the person who was actually there", () => {
    // Verbatim from paid rehearsal runs 13 and 14 (2026-07-31), where two
    // different guests improvised by composer-2.5-fast spelled her «loyla» and
    // one of them ended up writing «re eipa idi 3 fores, i loyla!».
    const LOULA = { participantId: "p-loula", displayName: "Λούλα" };
    const ROULA = { participantId: "p-roula", displayName: "Ρούλα" };

    expect(
      resolvePostEventFeedbackCandidateByName("loyla", [LOULA, ROULA, NIKOS]),
    ).toMatchObject({ participantId: "p-loula" });
    expect(
      resolvePostEventFeedbackCandidateByName("i loyla", [LOULA, ROULA]),
    ).toMatchObject({ participantId: "p-loula" });
    // Λούλα and Ρούλα sit at the same table on purpose, and the fold must not
    // make one of them answer for the other.
    expect(
      resolvePostEventFeedbackCandidateByName("royla", [LOULA, ROULA, NIKOS]),
    ).toMatchObject({ participantId: "p-roula" });
  });

  it("resolves an inflected first name to the person it declines from", () => {
    // Verbatim from report/feedback-burst-2026-08-04T16-44-08Z.json: the
    // mention «taki», a Τάκης at the table, and no match — so his praise was
    // filed as an unattributable note and the question was asked again.
    const TAKIS = {
      participantId: "p-takis",
      displayName: "Τάκης Γκροκοβούβαλος",
    };

    expect(
      resolvePostEventFeedbackCandidateByName("taki", [TAKIS, NIKOS, ELENI]),
    ).toMatchObject({ participantId: "p-takis" });
    expect(
      resolvePostEventFeedbackCandidateByName("Τάκη", [TAKIS, NIKOS, ELENI]),
    ).toMatchObject({ participantId: "p-takis" });
    expect(
      resolvePostEventFeedbackCandidateByName("ο τακη", [TAKIS, NIKOS]),
    ).toMatchObject({ participantId: "p-takis" });
    expect(
      resolvePostEventFeedbackCandidateByName("kosta", [KOSTAS_P, NIKOS]),
    ).toMatchObject({ participantId: "p-kostas-p" });
    expect(
      resolvePostEventFeedbackCandidateByName("Κώστα", [KOSTAS_P, NIKOS]),
    ).toMatchObject({ participantId: "p-kostas-p" });
  });

  it("still refuses when the inflected form fits two different people", () => {
    // A Τάκης and a Τάκη who are two real people share the sigma-less form.
    // That is exactly when guessing is most tempting and most wrong: the
    // widening adds forms a candidate answers to, never touches the
    // exactly-one-match requirement, so the shared form refuses.
    const TAKIS = { participantId: "p-takis", displayName: "Τάκης" };
    const TAKI = { participantId: "p-taki", displayName: "Τάκη" };

    expect(
      resolvePostEventFeedbackCandidateByName("taki", [TAKIS, TAKI, NIKOS]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName("Τάκη", [TAKIS, TAKI]),
    ).toBeUndefined();
    // The full nominative is a form only one of them carries, so it keeps
    // resolving exactly as it did before the widening.
    expect(
      resolvePostEventFeedbackCandidateByName("Τάκης", [TAKIS, TAKI]),
    ).toMatchObject({ participantId: "p-takis" });
    // And the vocative reaches both Κώστας exactly as the nominative does.
    expect(
      resolvePostEventFeedbackCandidateByName("kosta", [KOSTAS_P, KOSTAS_G]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName("Κώστα", [KOSTAS_P, KOSTAS_G]),
    ).toBeUndefined();
  });

  it("does not read a genitive mention as the person who owns it", () => {
    // «ο φίλος της Ελένης» is about the friend, not about Ελένη — and it is
    // the disclosure case where attributing the sentence to her is the worst
    // available outcome. The widening is one-sided on purpose: candidates gain
    // their sigma-less form, mentions gain nothing, so «Ελένης» is not a form
    // the candidate «Ελένη» answers to.
    expect(
      resolvePostEventFeedbackCandidateByName("Ελένης", [ELENI, NIKOS]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName("ο φίλος της Ελένης", [
        ELENI,
        NIKOS,
      ]),
    ).toBeUndefined();
  });

  it("does not let the sigma widening pull «Μαρία» onto her neighbours", () => {
    // Μαρία, Μάρη and Μάριος are three different people one or two letters
    // apart. Only a final sigma is dropped, and only on the candidate side, so
    // Μαρία keeps her whole name and resolves to herself alone even with both
    // neighbours seeded.
    const MARIA = { participantId: "p-maria", displayName: "Μαρία" };
    const MARIOS = { participantId: "p-marios", displayName: "Μάριος" };

    expect(
      resolvePostEventFeedbackCandidateByName("μαρια", [MARIA, MARIOS, MARI]),
    ).toMatchObject({ participantId: "p-maria" });
    expect(
      resolvePostEventFeedbackCandidateByName("maria", [MARIA, MARIOS, MARI]),
    ).toMatchObject({ participantId: "p-maria" });
    // Μάριος keeps answering to his own vocative, not to hers.
    expect(
      resolvePostEventFeedbackCandidateByName("Μάριο", [MARIA, MARIOS]),
    ).toMatchObject({ participantId: "p-marios" });
  });

  it("resolves nothing for an unknown name or an empty mention", () => {
    expect(
      resolvePostEventFeedbackCandidateByName("Ρούλα", [NIKOS, ELENI]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName(null, [NIKOS]),
    ).toBeUndefined();
    expect(
      resolvePostEventFeedbackCandidateByName("  ", [NIKOS]),
    ).toBeUndefined();
  });
});
