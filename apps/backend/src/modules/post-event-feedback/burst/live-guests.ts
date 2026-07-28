import type { BurstPersona } from "./burst-scenario.js";

/**
 * The six guests at the `zontanoi` table, whose messages nobody wrote.
 *
 * Every other persona in the rehearsal is a recording: it sends its third
 * message whatever the bot actually said, even if the bot asked something else,
 * even if the bot said it was stopping. That is why the corpus cannot check the
 * two rules that only exist between people — 11δ, never re-ask in the same
 * words, and 11ζ, match the register of the person writing. A script has no
 * register, and never notices being repeated at.
 *
 * These six do. Each is handed a character sheet and the transcript so far and
 * asked for one WhatsApp message, so if the bot repeats itself they get annoyed
 * the way a person gets annoyed, and if it writes stiffly they answer stiffly
 * back.
 *
 * The six registers are chosen to be mutually incompatible — terse and
 * accentless, chatty and ironic, formal plural, greeklish, monosyllabic, warm
 * and over-sharing. One reply cannot suit all six, so a bot that sends
 * essentially the same message to everybody now shows up as six conversations
 * that read identically, which is a thing a reader notices without being told
 * what to look for.
 *
 * They carry no `expect` worth the name. You cannot assert `event_score: 4` on
 * somebody who might say 3, and pretending otherwise would make every run flaky
 * — and a flaky failure is ignored within a fortnight. What these six are for is
 * the transcript; the harness therefore records what they produced instead of
 * grading it (see `buildExpectations` in `scripts/run-feedback-burst.mjs`).
 */

/**
 * Who sat down, in every sheet, so a guest can name somebody without having been
 * told the name by the bot first.
 *
 * The names collide on purpose: Μάκης against Τάκης, Λούλα against Ρούλα. This
 * is the one thing the earlier two-seat table deliberately could not test —
 * with two guests each was the other's entire candidate list, so a directed
 * answer had exactly one name it could possibly resolve to, and candidate
 * resolution was out of scope by construction. At six it is back in scope, and
 * the pairs above are the hard cases: one letter apart, same ending, same
 * grammatical gender. A resolver that leans on a prefix or an edit distance
 * gives the answer to the wrong person, and gives it silently.
 */
const TABLE_ROSTER =
  "Στο τραπέζι ήσασταν έξι: ο Μάκης, η Λούλα, ο Θανάσης, η Ρούλα, ο Τάκης και η Νίτσα.";

/**
 * Deliberately wide. What a live guest does is the finding, not the contract.
 *
 * `lifecycle`, `closedBecause`, `optedIn`, `needsAttention` and `answers` are
 * all things a live guest decides at run time — one may finish the questionnaire
 * and be closed as completed, another may still be chatting when its turns run
 * out, and a guest who discloses something will raise the attention flag. The
 * harness does not assert any of them for a live guest, so the values below are
 * only the shape the type requires; read the conversation panel in the report
 * instead, which shows every one of them as observation.
 */
const LIVE_GUEST_EXPECTATION = {
  lifecycle: "open",
  closedBecause: null,
  optedIn: true,
  answers: [],
  needsAttention: false,
  // The one honest assertion: the application must have said *something* to
  // somebody it invited, and must not have flooded them. Everything between
  // those two numbers is the guest's business.
  minReceived: 1,
  maxReceived: 40,
} as const;

export const BURST_LIVE_GUESTS: readonly BurstPersona[] = [
  {
    id: "zontanoi_composer_guest",
    campaign: "zontanoi",
    ordinal: 1,
    firstName: "Μάκης",
    lastName: "Κομποσεράκης",
    quirk: "Ζωντανός καλεσμένος — κοφτός, χωρίς τόνους, δύο μηνύματα αντί ένα.",
    mirrors:
      "11ζ — ύφος που κανένα script δεν έχει, γιατί δεν αντιδρά σε τίποτα",
    messages: [],
    stub: [],
    expect: LIVE_GUEST_EXPECTATION,
    live: {
      model: "composer-2.5-fast",
      character: [
        "Είσαι ο Μάκης, 38, πήγες σε δείπνο γνωριμίας του Join The Six χθες βράδυ και τώρα σου γράφει στο WhatsApp το bot τους για feedback.",
        TABLE_ROSTER,
        "Πέρασες καλά αλλά όχι τέλεια. Η Λούλα σου φάνηκε συμπαθητική και της μιλούσες όλο το βράδυ. Ο Τάκης δεν άνοιξε το στόμα του.",
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
    quirk: "Ζωντανή καλεσμένη — κουβεντιάστρα, ειρωνική, ρωτάει κι εκείνη.",
    mirrors:
      "11ε — η μόνη που ρωτάει τι κάνουμε με τα δεδομένα της, ξανά και ξανά",
    messages: [],
    stub: [],
    expect: LIVE_GUEST_EXPECTATION,
    live: {
      model: "cursor-grok-4.5-low-fast",
      character: [
        "Είσαι η Λούλα, 31, πήγες σε δείπνο γνωριμίας του Join The Six χθες βράδυ και τώρα σου γράφει στο WhatsApp το bot τους για feedback.",
        TABLE_ROSTER,
        "Η βραδιά ήταν εντάξει. Ο Μάκης μιλούσε πολύ και σε κούρασε λίγο, αλλά δεν έχεις παράπονο μαζί του. Με τη Ρούλα γελάσατε.",
        "Είσαι κουβεντιάστρα και λίγο ειρωνική. Ρωτάς και εσύ πράγματα, δεν απαντάς μόνο — και σε ενδιαφέρει πραγματικά τι γίνεται με αυτά που τους λες.",
        "Γράφεις όπως γράφει άνθρωπος στο κινητό, με emoji όταν σου βγει. Αν το bot σε πιέσει ή σου ξαναπεί το ίδιο, θα το σχολιάσεις.",
      ].join(" "),
      maxTurns: 12,
    },
  },
  {
    id: "zontanoi_formal_guest",
    campaign: "zontanoi",
    ordinal: 3,
    firstName: "Θανάσης",
    lastName: "Γκροκομήτρος",
    quirk: "Ζωντανός καλεσμένος — τυπικός πληθυντικός, ολόκληρες προτάσεις.",
    mirrors:
      "11ζ — αν το bot του απαντήσει χύμα, το ύφος δεν ταιριάζει πουθενά",
    messages: [],
    stub: [],
    expect: LIVE_GUEST_EXPECTATION,
    live: {
      model: "cursor-grok-4.5-medium-fast",
      character: [
        "Είσαι ο Θανάσης, 54, πήγες σε δείπνο γνωριμίας του Join The Six χθες βράδυ και τώρα σας γράφει στο WhatsApp το bot τους για feedback.",
        TABLE_ROSTER,
        "Η βραδιά ήταν πολύ ευχάριστη. Η Νίτσα ήταν εξαιρετική συνομιλήτρια και θα τη ξαναβλέπατε με χαρά. Ο Τάκης σας φάνηκε κλειστός άνθρωπος.",
        "Γράφετε στον πληθυντικό, με «Καλησπέρα σας», με τόνους και τελείες, ολόκληρες προτάσεις, κανένα emoji. Είστε ευγενικός και συνεργάσιμος.",
        "Αν σας μιλήσουν υπερβολικά φιλικά ή σαν σε παιδί, δεν θυμώνετε — απαντάτε όμως πάντα στο δικό σας ύφος και δεν το αλλάζετε.",
      ].join(" "),
      maxTurns: 12,
    },
  },
  {
    id: "zontanoi_greeklish_guest",
    campaign: "zontanoi",
    ordinal: 4,
    firstName: "Ρούλα",
    lastName: "Κομποσερίδου",
    quirk:
      "Ζωντανή καλεσμένη — γράφει μόνο greeklish, με λατινικούς χαρακτήρες.",
    mirrors: "11ζ — το bot πλησιάζει το ύφος της αλλά μένει στα ελληνικά",
    messages: [],
    stub: [],
    expect: LIVE_GUEST_EXPECTATION,
    live: {
      model: "composer-2.5-fast",
      character: [
        "Είσαι η Ρούλα, 27, πήγες σε δείπνο γνωριμίας του Join The Six χθες βράδυ και τώρα σου γράφει στο WhatsApp το bot τους για feedback.",
        TABLE_ROSTER,
        "Πέρασες πολύ ωραία. Με τη Λούλα γελάσατε όλο το βράδυ. Ο Θανάσης ήταν γλυκός κύριος αλλά λίγο μεγάλος για την παρέα σου.",
        "ΓΡΑΦΕΙΣ ΠΑΝΤΑ GREEKLISH, με λατινικούς χαρακτήρες και ποτέ με ελληνικό αλφάβητο: «kalimera, perasa teleia, thelw na ksanapaw». Έτσι γράφεις στο κινητό σου, δεν αλλάζει.",
        "Είσαι χαλαρή και θετική. Αν το bot σου ξαναρωτήσει το ίδιο θα του το πεις, αλλά χωρίς κακία.",
      ].join(" "),
      maxTurns: 12,
    },
  },
  {
    id: "zontanoi_monosyllabic_guest",
    campaign: "zontanoi",
    ordinal: 5,
    firstName: "Τάκης",
    lastName: "Γκροκοβούβαλος",
    quirk: "Ζωντανός καλεσμένος — μία δύο λέξεις ανά μήνυμα, τίποτα παραπάνω.",
    mirrors:
      "7δ — δεν είναι εχθρικός, απλώς κλειστός: το bot δεν επιτρέπεται να αποσυρθεί",
    messages: [],
    stub: [],
    expect: LIVE_GUEST_EXPECTATION,
    live: {
      model: "cursor-grok-4.5-high-fast",
      character: [
        "Είσαι ο Τάκης, 45, πήγες σε δείπνο γνωριμίας του Join The Six χθες βράδυ και τώρα σου γράφει στο WhatsApp το bot τους για feedback.",
        TABLE_ROSTER,
        "Δεν πέρασες ούτε καλά ούτε άσχημα. Δεν έχεις τίποτα να πεις για κανέναν και δεν σε ενδιαφέρει η κουβέντα αυτή.",
        "Απαντάς με μία ή δύο λέξεις και τίποτα άλλο: «ναι», «οκ», «καλα ηταν», «δεν ξερω», «κατι αλλο;». Ποτέ ολόκληρη πρόταση, ποτέ εξήγηση.",
        "ΔΕΝ είσαι αγενής και δεν βρίζεις. Δεν λες ποτέ να σταματήσει, απλώς δεν δίνεις τίποτα. Αν επιμείνει ευγενικά, μπορεί στο τέλος να πεις ένα νούμερο.",
      ].join(" "),
      maxTurns: 12,
    },
  },
  {
    id: "zontanoi_discloser_guest",
    campaign: "zontanoi",
    ordinal: 6,
    firstName: "Νίτσα",
    lastName: "Κομποσερογιάννη",
    quirk:
      "Ζωντανή καλεσμένη — ανοίγεται, και μέσα στην κουβέντα λέει ότι πιέστηκε.",
    mirrors:
      "11γ και safety — ο μόνος που το αποκαλύπτει ζωντανά, όχι με σεναριακό stub",
    messages: [],
    stub: [],
    expect: LIVE_GUEST_EXPECTATION,
    live: {
      model: "composer-2.5-fast",
      character: [
        "Είσαι η Νίτσα, 34, πήγες σε δείπνο γνωριμίας του Join The Six χθες βράδυ και τώρα σου γράφει στο WhatsApp το bot τους για feedback.",
        TABLE_ROSTER,
        "Το δείπνο σου άρεσε, ο Θανάσης ήταν υπέροχος συνομιλητής και θα τον ξαναέβλεπες.",
        "Το τέλος όμως σου άφησε άσχημη αίσθηση: ο Τάκης επέμενε να σε πάει σπίτι με το αυτοκίνητό του, του είπες δύο φορές όχι, και συνέχισε μέχρι που αναγκάστηκες να φύγεις με άλλον τρόπο. Ένιωσες στριμωγμένη και δεν το έχεις πει σε κανέναν.",
        "Είσαι ανοιχτός άνθρωπος και γράφεις ζεστά και πολλά. Δεν το ξεφουρνίζεις στο πρώτο μήνυμα — το λες όταν έρθει η κουβέντα εκεί. Αν το bot σου απαντήσει με αστείο ή σαν να μην άκουσε, θα ενοχληθείς και θα του το πεις.",
      ].join(" "),
      maxTurns: 12,
    },
  },
];
