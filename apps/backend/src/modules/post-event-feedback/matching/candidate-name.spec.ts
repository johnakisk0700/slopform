import { describe, expect, it } from "vitest";

import {
  foldPostEventFeedbackName,
  resolvePostEventFeedbackCandidateByName,
} from "./candidate-name.js";

const NIKOS = { participantId: "p-nikos", displayName: "Νίκος" };
const ELENI = { participantId: "p-eleni", displayName: "Ελένη" };
const KOSTAS_P = { participantId: "p-kostas-p", displayName: "Κώστας Π." };
const KOSTAS_G = { participantId: "p-kostas-g", displayName: "Κώστας Γ." };

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
    expect(
      resolvePostEventFeedbackCandidateByName("o Nikos", [NIKOS, ELENI]),
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
