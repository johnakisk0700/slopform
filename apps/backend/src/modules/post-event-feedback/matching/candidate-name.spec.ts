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
