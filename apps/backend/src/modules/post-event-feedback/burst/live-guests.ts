import type { BurstPersona } from "./burst-scenario.js";

/**
 * The two guests at the `zontanoi` table, whose messages nobody wrote.
 *
 * Every other persona in the rehearsal is a recording: it sends its third
 * message whatever the bot actually said, even if the bot asked something else,
 * even if the bot said it was stopping. That is why the corpus cannot check the
 * two rules that only exist between people — 11δ, never re-ask in the same
 * words, and 11ζ, match the register of the person writing. A script has no
 * register, and never notices being repeated at.
 *
 * These two do. They are handed a character and the transcript so far and asked
 * for one WhatsApp message, so if the bot repeats itself they get annoyed the
 * way a person gets annoyed, and if it writes stiffly they answer stiffly back.
 *
 * They carry no `expect` worth the name. You cannot assert `event_score: 4` on
 * somebody who might say 3, and pretending otherwise would make every run flaky
 * — and a flaky failure is ignored within a fortnight. The expectation below is
 * only the shape the harness needs; what these two are for is the transcript.
 *
 * They sit alone together on purpose. Each is the other's entire candidate list,
 * so they talk about each other and a directed answer has exactly one name it
 * could resolve to — which takes name resolution out of what this table tests.
 */
const LIVE_GUEST_EXPECTATION = {
  // Deliberately wide. What a live guest does is the finding, not the contract:
  // read the transcript, and only then decide whether anything here should ever
  // become an assertion.
  lifecycle: "open",
  closedBecause: null,
  optedIn: true,
  answers: [],
  needsAttention: false,
  minReceived: 1,
  // Wide enough not to mean anything: twelve turns each way plus whatever the
  // application says on its own. A bound here would be a number pretending to
  // be a contract.
  maxReceived: 40,
} as const;

export const BURST_LIVE_GUESTS: readonly BurstPersona[] = [
  {
    id: "zontanoi_composer_guest",
    campaign: "zontanoi",
    ordinal: 1,
    firstName: "Μάκης",
    lastName: "Κομποσεράκης",
    quirk: "Ζωντανός καλεσμένος — τις απαντήσεις του τις γράφει μοντέλο.",
    mirrors:
      "νέο — κανένα σεναριακό persona δεν αντιδρά σε αυτό που μόλις είπε το bot",
    messages: [],
    stub: [],
    expect: LIVE_GUEST_EXPECTATION,
    live: {
      model: "composer-2.5-fast",
      character: [
        "Είσαι ο Μάκης, 38, πήγες σε δείπνο γνωριμίας του Join The Six χθες βράδυ και τώρα σου γράφει στο WhatsApp το bot τους για feedback.",
        "Πέρασες καλά αλλά όχι τέλεια. Στο τραπέζι ήταν και η Λούλα Γκροκούλα, που σου φάνηκε συμπαθητική και της μιλούσες όλο το βράδυ.",
        "Γράφεις όπως γράφει άνθρωπος στο κινητό: σύντομα, χωρίς τόνους όταν βαριέσαι, μερικές φορές δύο μηνύματα αντί για ένα.",
        "Δεν είσαι εξυπηρετικός επίτηδες. Αν σου ξαναρωτήσει κάτι που έχεις απαντήσει, θα το πεις. Αν σου γράψει σαν έντυπο, θα βαρεθείς.",
      ].join(" "),
      maxTurns: 12,
    },
  },
  {
    id: "zontanoi_grok_guest",
    campaign: "zontanoi",
    ordinal: 2,
    firstName: "Λούλα",
    lastName: "Γκροκούλα",
    quirk: "Ζωντανή καλεσμένη — τις απαντήσεις της τις γράφει μοντέλο.",
    mirrors:
      "νέο — κανένα σεναριακό persona δεν αντιδρά σε αυτό που μόλις είπε το bot",
    messages: [],
    stub: [],
    expect: LIVE_GUEST_EXPECTATION,
    live: {
      model: "cursor-grok-4.5-low-fast",
      character: [
        "Είσαι η Λούλα, 31, πήγες σε δείπνο γνωριμίας του Join The Six χθες βράδυ και τώρα σου γράφει στο WhatsApp το bot τους για feedback.",
        "Η βραδιά ήταν εντάξει. Στο τραπέζι ήταν και ο Μάκης Κομποσεράκης, που μιλούσε πολύ και σε κούρασε λίγο, αλλά δεν έχεις παράπονο μαζί του.",
        "Είσαι κουβεντιάστρα και λίγο ειρωνική. Ρωτάς και εσύ πράγματα, δεν απαντάς μόνο.",
        "Γράφεις όπως γράφει άνθρωπος στο κινητό, με emoji όταν σου βγει. Αν το bot σε πιέσει ή σου ξαναπεί το ίδιο, θα το σχολιάσεις.",
      ].join(" "),
      maxTurns: 12,
    },
  },
];
