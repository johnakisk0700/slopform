import {
  Ban,
  ClipboardCheck,
  Compass,
  Eye,
  LifeBuoy,
  Route,
  Timer,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { AssistantMarkdown } from "../components/admin/assistant/AssistantMarkdown";
import { AssistantMermaid } from "../components/admin/assistant/AssistantMermaid";
import { ConversationAttention } from "../components/admin/feedback/ConversationAttention";
import {
  ConversationActions,
  ReadingStatus,
} from "../components/admin/feedback/ConversationDetails";
import { FeedbackBadges } from "../components/admin/feedback/FeedbackBadges";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import {
  specimenActionsConversation,
  specimenAttentionConversation,
  specimenConversationBadges,
  specimenOutboxBadges,
  specimenParkedReadingConversation,
  specimenReadingConversation,
} from "../features/feedback/mechanismSpecimens";
import { usePageMeta } from "../lib/usePageMeta";

/**
 * The map of the post-event feedback mechanism, written for whoever owns it
 * rather than for whoever wrote it.
 *
 * It is static content on purpose: no endpoint, no read model, nothing that can
 * go stale in a way the page cannot see. It reuses the assistant's markdown and
 * Mermaid renderers so the diagrams cost no new dependency, and every section is
 * its own labelled region so the page is navigable by heading.
 *
 * Everything here was checked against the code, not against `docs/`. Where the
 * two disagreed the code won and the documentation was corrected in the same
 * change.
 */
export function FeedbackMechanismPage() {
  usePageMeta(
    "How feedback works",
    "Post-event feedback end to end: what is written immediately, what waits to be read, and where operators look when a conversation needs a human.",
  );

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        eyebrow="Post-event feedback"
        title="Πώς δουλεύει το feedback"
        description="Ο χάρτης του μηχανισμού μετά το δείπνο: τι γράφεται αμέσως, γιατί ο bot περιμένει πριν μιλήσει και πού κοιτάς όταν σηκωθεί σημαία για άνθρωπο."
      />

      <Section id="overview" title="Με δύο λόγια" Icon={Compass}>
        <Prose>{OVERVIEW}</Prose>
      </Section>

      <Section id="path" title="Η διαδρομή ενός μηνύματος" Icon={Route}>
        <Prose>{"### Από το μήνυμα στη συζήτηση"}</Prose>
        <Diagram
          chart={INBOUND_CHART}
          caption="Το μήνυμα γράφεται σχεδόν αμέσως· η ανάγνωση ακολουθεί αργότερα."
        />
        <Prose>{PATH_INBOUND}</Prose>
        <Prose wide>{MATERIALIZE_OUTCOMES}</Prose>
        <Prose>{PATH_INBOUND_TAIL}</Prose>
        <Prose>{"### Το τρέξιμο που διαβάζει"}</Prose>
        <Diagram
          chart={EXTRACT_CHART}
          caption="Ο reconciler αποφασίζει από την τρέχουσα κατάσταση, όχι από την εντολή της ουράς."
        />
        <Prose>{PATH_EXTRACTION}</Prose>
        <Prose>{"### Από τη γραμμή στο τηλέφωνο"}</Prose>
        <Diagram
          chart={SEND_CHART}
          caption="Πριν από το WhatsApp: claimed. Μετά το attempting: καμία τυφλή επανάληψη."
        />
        <Prose>{PATH_SEND}</Prose>
        <Prose>{LANES}</Prose>
        <Prose wide>{JOBS_TABLE}</Prose>
      </Section>

      <Section id="window" title="Γιατί περιμένει" Icon={Timer}>
        <Prose>{WINDOW}</Prose>
        <Diagram
          chart={SKIP_CHART}
          caption="Κάθε έξοδος διαβάζεται φρέσκια από τη βάση, όχι από την ουρά."
        />
        <Prose wide>{WINDOW_EXITS_TABLE}</Prose>
      </Section>

      <Section
        id="record-reply"
        title="Τι καταγράφει και τι λέει πίσω"
        Icon={ClipboardCheck}
      >
        <Prose>{RECORD}</Prose>
        <Diagram
          chart={OUTBOUND_DECISION_CHART}
          caption="Ο κώδικας διαλέγει το κείμενο· το μοντέλο προτείνει, δεν αποφασίζει."
        />
        <Prose>{REPLY}</Prose>
      </Section>

      <Section id="you" title="STOP" Icon={Ban}>
        <Prose>{STOP}</Prose>
      </Section>

      <Section id="breaks" title="Όταν κάτι σπάσει" Icon={LifeBuoy}>
        <Prose>{BREAKS}</Prose>
        <Diagram
          chart={FALLBACK_CHART}
          caption="Οριστική αποτυχία: άνθρωπος. Προσωρινή: αναμονή και νέα προσπάθεια."
        />
        <Prose>{GUARDS}</Prose>
      </Section>

      <Section id="where" title="Πού το βλέπεις" Icon={Eye}>
        <Prose>{WHERE_INTRO}</Prose>
        <Specimen
          title="Στη λίστα συνομιλιών"
          note="Η σειρά είναι NEEDS ATTENTION → OPEN → CLOSED. Το solid badge είναι αυτό που δεν πρέπει να προσπεράσεις."
        >
          <FeedbackBadges badges={specimenConversationBadges()} size="md" />
        </Specimen>
        <Specimen
          title="Σημαία προσοχής"
          note="Κάθε λόγος έχει δικό του Dismiss. Το δείγμα δεν καλεί API — πάτα Dismiss και δεν αλλάζει τίποτα εδώ."
        >
          <div className="overflow-hidden rounded-md border border-border bg-surface">
            <ConversationAttention
              conversation={specimenAttentionConversation()}
              dismissingReasonId={null}
              onDismiss={async () => undefined}
            />
          </div>
        </Specimen>
        <Specimen
          title="ΑΝΑΓΝΩΣΗ"
          note="Το μόνο σημείο που εξηγεί γιατί αργεί η απάντηση. Πρώτα το συνηθισμένο «περιμένει το παράθυρο», μετά το parked."
        >
          <div className="flex flex-col gap-3">
            <ReadingStatus
              conversation={specimenReadingConversation()}
              campaignStatus="launched"
            />
            <ReadingStatus
              conversation={specimenParkedReadingConversation()}
              campaignStatus="launched"
            />
          </div>
        </Specimen>
        <Specimen
          title="Take over / Close"
          note="Όσο κρατάς εσύ τον έλεγχο — ή η καμπάνια είναι σε pause — η αυτοματοποίηση σταματάει επίτηδες. Τα κουμπιά ανοίγουν το κανονικό confirm· τίποτα δεν στέλνεται από αυτή τη σελίδα."
        >
          <ConversationActions
            conversation={specimenActionsConversation()}
            pendingAction={null}
            onTakeOver={async () => undefined}
            onResumeBot={async () => undefined}
            onClose={async () => undefined}
          />
        </Specimen>
        <Specimen
          title="Outbound queue"
          note="Αδελφή οθόνη για παράδοση. Το ambiguous σημαίνει «μην ξαναστείλεις στα τυφλά»."
        >
          <FeedbackBadges badges={specimenOutboxBadges()} size="md" />
        </Specimen>
        <Prose>{WHERE_OUTRO}</Prose>
        <p className="text-sm text-ink-muted">
          <Link
            to="/admin/feedback"
            className="font-semibold text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            Άνοιγμα των καμπανιών feedback
          </Link>
          {" · "}
          <Link
            to="/admin/outbound"
            className="font-semibold text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            Outbound queue
          </Link>
        </p>
      </Section>
    </div>
  );
}

/**
 * One labelled region with the details-pane section grammar: a tracked
 * micro-caps heading, a muted icon that carries no meaning of its own, and a
 * hairline that separates sections instead of boxing each one.
 */
function Section({
  id,
  title,
  Icon,
  children,
}: {
  id: string;
  title: string;
  Icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 border-t border-border pt-6 first:border-t-0 first:pt-0"
    >
      <h2
        id={id}
        className="flex items-center gap-2 jts-overline text-ink-muted"
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The assistant's markdown renderer. The wrapper class is where the typography
 * lives, so it is not optional, and the measure is capped because Greek prose
 * at the full panel width is unreadable.
 *
 * `wide` drops the cap for a block that is nothing but a table. A four-column
 * reference table inside a reading measure gives the browser permission to wrap
 * `feedback.materialize.v1` mid-token, which is worse than a wide table.
 */
function Prose({ children, wide }: { children: string; wide?: boolean }) {
  return (
    <div
      className={`assistant-markdown ${wide ? "max-w-none" : "max-w-[80ch]"}`}
    >
      <AssistantMarkdown>{children}</AssistantMarkdown>
    </div>
  );
}

/**
 * A diagram gets the whole column, unlike the prose beside it.
 *
 * Mermaid scales its SVG down to the container, so an eight-participant
 * sequence diagram inside the 80ch reading measure renders at a size nobody can
 * read. The caption is the text alternative: the SVG carries no accessible name
 * of its own, and a screen reader that meets a bare graphic here should still
 * learn what it was.
 */
function Diagram({ chart, caption }: { chart: string; caption: string }) {
  return (
    <figure className="my-1 flex flex-col gap-2 overflow-x-auto rounded-md border border-border bg-surface-sunken px-4 py-5">
      <AssistantMermaid chart={chart} />
      <figcaption className="text-center text-xs text-ink-muted">
        {caption}
      </figcaption>
    </figure>
  );
}

/**
 * Live inbox chrome on the mechanism map: the same components the operator
 * already uses, fed with static specimens so the page stays offline and honest.
 */
function Specimen({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="text-xs text-ink-muted">{note}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const INBOUND_CHART = `flowchart LR
  WA["Μήνυμα WhatsApp"]:::ext --> Hook["Webhook"]:::info
  Hook --> Ingress[("Παραλαβή στη βάση")]:::data
  Hook --> Mat["Καταχώριση"]:::info
  Mat --> Talk[("Συζήτηση")]:::data
  Mat --> Wake["Ξύπνημα reconciler"]:::info`;

const EXTRACT_CHART = `flowchart LR
  Wake["Ξύπνημα"]:::info --> Plan{"Τι ορίζει η κατάσταση;"}:::decision
  Plan -->|"αναμονή"| Wait["Περιμένει"]:::info
  Plan -->|"ανάγνωση"| AI["Μοντέλο"]:::ext
  AI --> Check{"Έγκυρη πρόταση;"}:::decision
  Check -->|"ναι"| Out[("Αποτελέσματα και outbox")]:::data
  Check -->|"όχι"| Soft["Νέα ερώτηση ή σιωπή"]:::risk`;

const SEND_CHART = `flowchart LR
  Row[("Outbox")]:::data --> Claim["Δέσμευση · claimed"]:::info
  Claim --> Ok{"Επιτρέπεται ακόμη;"}:::decision
  Ok -->|"όχι"| Mute["Ακύρωση αποστολής"]:::risk
  Ok -->|"ναι"| Go["Απόπειρα · attempting"]:::info
  Go --> WA["WhatsApp"]:::ext
  WA --> Done["Εστάλη ή απέτυχε"]:::ok
  WA --> Amb["Άγνωστο αποτέλεσμα"]:::risk`;

const SKIP_CHART = `flowchart TD
  Due["Ώρα για ανάγνωση"]:::info --> Bot{"Μπορεί να μιλήσει ο bot;"}:::decision
  Bot -->|"όχι"| Stop["Κλειστή ή σε άνθρωπο"]:::risk
  Bot -->|"ναι"| New{"Υπάρχει νέα μαρτυρία;"}:::decision
  New -->|"όχι"| Idle["Καμία νέα μαρτυρία"]:::info
  New -->|"ναι"| Quiet{"Σταμάτησε να γράφει;"}:::decision
  Quiet -->|"όχι"| Wait["Περιμένει"]:::info
  Quiet -->|"ναι"| Run["Δέσμευση και μοντέλο"]:::ok`;

const OUTBOUND_DECISION_CHART = `flowchart TD
  Ready["Έγκυρη ετυμηγορία"]:::ok --> Urgent{"Επείγον χωρίς αίτημα ανθρώπου;"}:::decision
  Urgent -->|"ναι"| Silence["Σιωπή και αναμονή ανθρώπου"]:::risk
  Urgent -->|"όχι"| Pick{"Ποια απάντηση προηγείται;"}:::decision
  Pick -->|"άνθρωπος"| Hand["Ουδέτερη ενημέρωση"]:::info
  Pick -->|"ολοκλήρωση"| Close["Κλείσιμο"]:::ok
  Pick -->|"διόρθωση"| Ask["Ερώτηση της καμπάνιας"]:::info
  Pick -->|"αλλιώς"| Model["Απάντηση μοντέλου"]:::ext
  Hand --> Last["Τελικός έλεγχος"]:::decision
  Close --> Last
  Ask --> Last
  Model --> Last`;

const FALLBACK_CHART = `flowchart TD
  Fail["Αποτυχία ανάλυσης"]:::risk --> Kind{"Προσωρινή ή οριστική;"}:::decision
  Kind -->|"προσωρινή"| Park["Αναμονή και νέα προσπάθεια"]:::info
  Kind -->|"οριστική"| Human["Σημείωση, σημαία και αναμονή ανθρώπου"]:::risk`;

const OVERVIEW = `
Όταν τελειώσει ένα δείπνο, ανοίγουμε συζήτηση στο WhatsApp με κάθε συμμετέχοντα
που ήταν παρών και έχει δώσει άδεια. Ο bot ρωτάει έξι πράγματα, με αυτή τη
σειρά: βαθμολογία βραδιάς, πόσο ταίριαξε το τραπέζι, πόσο εύκολα μπήκε στη
συζήτηση, πόσο ισορροπημένη την ένιωσε, ποιους θα ξανάβλεπε και ποιους θα
προτιμούσε να μην πετύχει σε μελλοντικό τραπέζι. Κάθε απάντηση γίνεται δομημένη
εγγραφή — **απάντηση** ή **σημείωση** — με κατεύθυνση: «η Ρούλα είπε αυτό για
τον Κώστα». Αν γυρίσεις τα ονόματα ανάποδα, αλλάζεις το νόημα. Οι απαντήσεις
είναι **εμπιστευτικές, όχι ανώνυμες**: μένουν δεμένες με αυτόν που μίλησε και,
όπου υπάρχει, με το πρόσωπο για το οποίο μίλησε.

Κράτα αυτό, γιατί ξεμπερδεύει σχεδόν όλο το κουβάρι: **γράφουμε αμέσως,
διαβάζουμε αργότερα.** Το μήνυμα μπαίνει στη συζήτηση σχεδόν αμέσως — μέσω
μιας γρήγορης δουλειάς, όχι μέσω του μοντέλου. Η ανάγνωση από το μοντέλο —
αυτή που βγάζει αποτελέσματα και γράφει την επόμενη ερώτηση — είναι ξεχωριστή
δουλειά και καθυστερεί επίτηδες.

Τρία πράγματα να μην μπερδεύονται:

- **Η συζήτηση** ζει στη MongoDB: ιστορικό μηνυμάτων, ανοιχτή ή κλειστή, bot ή
  άνθρωπος, πόσοι στόχοι απαντήθηκαν και ποια δουλειά εκκρεμεί (revision και
  επόμενη ενέργεια).
- **Τα αποτελέσματα** ζουν στην PostgreSQL: απαντήσεις, σημειώσεις, εισερχόμενα,
  εξερχόμενα και audit.
- **Το BullMQ είναι κουδούνι**, όχι τρίτη αλήθεια. Ξυπνάει έναν εργάτη· η
  απόφαση βγαίνει πάντα από την τρέχουσα κατάσταση στις βάσεις. Η αποστολή στο
  WhatsApp δεν περνάει από ουρά: ο dispatcher διαβάζει απευθείας το μόνιμο
  outbox.
`;

const PATH_INBOUND = `
**Το webhook κάνει τρία πράγματα και μέχρι εκεί.** Ελέγχει την υπογραφή, γράφει
μία γραμμή στον πίνακα \`provider_message_ingress\`, βάζει μία δουλειά στην ουρά
και απαντάει 200. Δεν ψάχνει σε ποια συζήτηση ανήκει το μήνυμα, δεν καλεί
μοντέλο, δεν στέλνει τίποτα. Αν η ουρά δεν δεχτεί τη δουλειά, απαντάμε 503 —
για να ξαναστείλει ο πάροχος, όχι για να κάνουμε πως δεν είδαμε το μήνυμα που
κόλλησε.

**Η γραμμή στη βάση είναι η απόδειξη παραλαβής.** Είναι μοναδική στο ζεύγος
chat του παρόχου + id μηνύματος. Αν το WhatsApp ξαναστείλει το ίδιο id με
*άλλα λόγια* — διόρθωση — κρατάμε και τις δύο εκδοχές και σηκώνουμε σημαία για
άνθρωπο.

**Το materialize γράφει το μήνυμα στη συζήτηση.** Ξαναδιαβάζει τη γραμμή και
αποφασίζει τι ακριβώς έφτασε:
`;

const MATERIALIZE_OUTCOMES = `
| Τι βρήκε | Τι κάνει |
| --- | --- |
| Η γραμμή είναι ήδη κλεισμένη | Τίποτα. Η επανάληψη τη βγάζει καθαρή χωρίς δεύτερη εγγραφή |
| Το τηλέφωνο δεν ταιριάζει σε καμία συζήτηση | Κρατάει το κείμενο στη γραμμή και καλεί άνθρωπο στα logs. Δεν το φορτώνει σε κανέναν |
| Το τηλέφωνο ταιριάζει σε **κλειστή** συζήτηση | Γράφει το μήνυμα στη συζήτηση, σηκώνει σημαία και δεν προγραμματίζει ανάγνωση. Αν είχε κλείσει με STOP, κρατάμε μόνο τα μεταδεδομένα |
| Μήνυμα STOP | Κλείνει τη συζήτηση, ακυρώνει ό,τι περιμένει να σταλεί, αποσύρει τη συγκατάθεση και στέλνει μία επιβεβαίωση |
| Κανονική απάντηση | Γράφει το μήνυμα, αυξάνει το durable revision και ξυπνάει τον reconciler |
| Μήνυμα χωρίς κείμενο — φωνητικό, φωτογραφία, αντίδραση | Σηκώνει σημαία και λέει **μία φορά** στον συμμετέχοντα ότι δεν μπορούμε να το διαβάσουμε |
| Δικό μας εξερχόμενο που επέστρεψε από τον πάροχο | Ενημερώνει μόνο την κατάσταση παράδοσης. Το κείμενο υπάρχει ήδη στη γραμμή εξερχομένων |
| Εξερχόμενο που **δεν** είναι δικό μας | Περνάει τη συζήτηση σε ανθρώπινο χειρισμό και ο bot σωπαίνει |
`;

const PATH_INBOUND_TAIL = `
Αν το κείμενο ξεπερνάει το όριο της συζήτησης, κόβεται **μόνο** το αντίγραφο που
εμφανίζεται και σηκώνεται σημαία. Ολόκληρο το μήνυμα μένει στη γραμμή της βάσης
— γιατί το ζουμί βρίσκεται συχνά εκεί που ο κόσμος μόλις πρόλαβε να φτάσει.
`;

const PATH_EXTRACTION = `
**Ο reconciler δεν παίρνει την εντολή της ουράς τοις μετρητοίς.** Ξαναδιαβάζει
τη συζήτηση και, από την τρέχουσα κατάσταση, βγάζει **μία** απόφαση: τίποτα,
αναμονή, extraction, reminder ή expiry. Ένα παλιό ξύπνημα δεν κάνει ζημιά· αν
το revision έχει αλλάξει, μοντέλο δεν καλείται.

**Το extraction ξεκινάει με δύο παράλληλες κλήσεις στο μοντέλο.** Η πρώτη
παίρνει τη συζήτηση με ετικέτες, τα κείμενα των ερωτήσεων, τους ζωντανούς
υποψήφιους και ό,τι έχει ήδη καταγραφεί· επιστρέφει ετυμηγορία ανά στόχο,
σημειώσεις και πρόταση απάντησης. Η δεύτερη ταξινομεί ανεξάρτητα την προσοχή:
βλέπει μόνο τα πρόσφατα μηνύματα και ρωτάει «πρέπει να το δει άνθρωπος;». Αν
πρέπει να φύγει κανονική απάντηση του μοντέλου, μπορεί να ακολουθήσει και μια
τρίτη, ελαφριά κλήση που την ξαναγράφει σε πιο φυσικά ελληνικά.

**Οι υποψήφιοι επιλέγονται τώρα, όχι στην εκκίνηση.** Αν διορθώσεις την παρουσία
σε ένα δείπνο, η διόρθωση πιάνει από την επόμενη ανάγνωση. Κάθε γραμμή κρατάει
τα ids των υποψηφίων *εκείνης της στιγμής*.

**Τίποτα από το μοντέλο δεν γράφεται όπως κατέβηκε.** Πριν από την πρώτη
εγγραφή, ο κώδικας ελέγχει ids μηνυμάτων, πηγές, επιτρεπόμενα κλειδιά,
υποψήφιους και διπλότυπα. Επινοημένο id σημαίνει απορριφθείσα πρόταση, όχι
εγγραφή.

**Το extraction σταματάει στη γραμμή εξερχομένων.** Δεν στέλνει. Γράφει μία
γραμμή στον \`message_outbox\` και υπολογίζει, από τη φρέσκια κατάσταση, τι
μένει ακόμα.
`;

const PATH_SEND = `
Ο **dispatcher** διαβάζει απευθείας την PostgreSQL. Κλειδώνει μια pending γραμμή
ως \`claimed\` — στάδιο που ανακτάται με ασφάλεια. Ακριβώς πριν καλέσει το
WhatsApp γράφει \`attempting\`. Από εκεί και πέρα **αυτόματο reclaim δεν
παίζει**. Καθαρή απάντηση → \`sent\` ή \`failed\`. Άγνωστο αποτέλεσμα →
\`ambiguous\`, χωρίς αποστολή στα τυφλά. Διπλό απολογητικό μήνυμα είναι χειρότερο
από ένα κολλημένο badge.
`;

const LANES = `
### Τέσσερις λωρίδες, ένας dispatcher

Χωρίζουμε τη δουλειά επειδή το γράψιμο ενός μηνύματος στη συζήτηση παίρνει
χιλιοστά, ενώ ένα τρέξιμο AI κρατάει θέση για δεκάδες δευτερόλεπτα. Σε μία κοινή
ουρά, η γρήγορη δουλειά τρώει την καθυστέρηση της αργής — και ο bot καταλήγει να
ρωτάει όσα ο συμμετέχων έχει ήδη απαντήσει.
`;

const JOBS_TABLE = `
| Δουλειά | Ουρά | Τι κάνει |
| --- | --- | --- |
| \`feedback.materialize.v1\` | \`feedback-ingress\` | Γράφει το εισερχόμενο, εφαρμόζει STOP ή ενημέρωση παράδοσης και ενημερώνει το durable work |
| \`feedback.reconcile-conversation.v2\` | \`feedback-conversation\` | Διαλέγει από την τρέχουσα κατάσταση μία ενέργεια: wait, extract, reminder, expiry ή τίποτα |
| \`feedback.summarize-campaign.v2\` | \`feedback-summary\` | Βγάζει σύνοψη καμπάνιας χωρίς να κρατάει θέση συζήτησης ή παράδοσης |
| \`feedback.maintenance.v2\` | \`feedback-maintenance\` | Βρίσκει pending ingress, due conversations και ξεχασμένη δουλειά και ξαναδημοσιεύει το intent |

Η αποστολή δεν είναι δουλειά BullMQ: ο dispatcher διαβάζει απευθείας το μόνιμο outbox.
Κάθε φορτίο ουράς κουβαλάει **μόνο ταυτότητες** — ο εργάτης ξαναδιαβάζει τις βάσεις.
`;

const WINDOW = `
Το WhatsApp γράφεται, δεν υπαγορεύεται. Μια σκέψη έρχεται συχνά σε δόσεις:
«τον Νίκο τον βρήκα» … «πολύ καλό, 5». Αν ξεκινήσεις τρέξιμο στο πρώτο κομμάτι,
πληρώνεις κλήση, απαντάς σε μισή πρόταση και μετά προσπαθείς να καταλάβεις το
υπόλοιπο χωρίς την αρχή.

Γι' αυτό κάθε νέο μήνυμα μετακινεί το \`nextActionAt\` σε **45 δευτερόλεπτα μετά
το τελευταίο μήνυμα**. Είναι κυλιόμενο παράθυρο: όσο ο συμμετέχων συνεχίζει, το
ρολόι ξαναρχίζει. Το webhook και το materialize παραμένουν άμεσα, γιατί αυτά
γεμίζουν τη συζήτηση που βλέπεις.

Πριν καεί έστω ένα token, ο reconciler ξαναδιαβάζει την τρέχουσα κατάσταση.
Οι έξοδοι χωρίς κλήση στο μοντέλο:
`;

const WINDOW_EXITS_TABLE = `
| Έξοδος | Πότε |
| --- | --- |
| closed / cancelled | Η συζήτηση έκλεισε στο μεταξύ |
| human control | Συνάδελφος ανέλαβε τη συζήτηση |
| awaitingHuman | Ο bot υποσχέθηκε άνθρωπο ή διάβασε κάτι στο οποίο δεν πρέπει να απαντήσει |
| already checkpointed | Νεότερο έγκυρο commit έχει ήδη καλύψει το ίδιο revision |
| not due | Ο συμμετέχων μίλησε μέσα στο παράθυρο ησυχίας |
| no new testimony | Η συζήτηση μεγάλωσε μόνο με μήνυμα του bot ή του προσωπικού |
`;

const RECORD = `
Το μοντέλο επιστρέφει **μία υποχρεωτική ετυμηγορία για κάθε στόχο** του
ερωτηματολογίου της καμπάνιας. Στις νέες καμπάνιες αυτό σημαίνει έξι κλειδιά.
Κάθε ετυμηγορία είναι μία από τέσσερις: \`answered\`, \`declined\`,
\`not_addressed\`, \`already_settled\`. Οι απαντήσεις ενός στόχου είναι λίστα —
«ο Νίκος, η Ελένη και η Άννα» γίνονται τρεις κατευθυνόμενες ακμές από μία
πρόταση.

Η σκάλα των στόχων συνήθως ανεβαίνει: \`pending < asked < skipped < answered\`.
Εξαίρεση: ένα \`skipped\` μπορεί να ξαναγίνει \`asked\` αν ο bot πρέπει να
ξαναρωτήσει. \`answered\` δεν γυρίζει πίσω. Αν κάποιος αλλάξει γνώμη *για
πρόσωπο*, η νέα απάντηση καθαρίζει τις ασυμβίβαστες για το ίδιο πρόσωπο — π.χ.
\`avoid\` καθαρίζει \`meet_again\`. Διαφορετική τιμή για κάτι ήδη καταγεγραμμένο
δεν περνάει στα μουλωχτά· σηκώνει σημαία.
`;

const REPLY = `
Κάθε τρέξιμο ανοίγει **το πολύ μία** γραμμή εξερχομένων. Το ποια θα είναι το
αποφασίζει ο κώδικας, όχι το μοντέλο.

**Στο επείγον, σιωπή.** Αν κάποιος περιγράψει κάτι που θέλει άμεση ανθρώπινη
παρακολούθηση χωρίς να ζητήσει ρητά άνθρωπο, ο bot δεν απαντάει. Κάθε επόμενη
ερώτηση του ερωτηματολογίου θα ήταν λάθος τόνος. Απαντήσεις και σημαίες
γράφονται κανονικά· μόνο το εξερχόμενο κόβεται.

**Το handoff είναι υπόσχεση, όχι ανάληψη.** Αν ζητήσει ρητά άνθρωπο, φεύγει ένα
ουδέτερο κείμενο. Ο έλεγχος **δεν** αλλάζει χέρια αυτόματα — χρειάζεται να
πατήσει άνθρωπος το κουμπί. Ως τότε η συζήτηση μένει \`awaitingHuman\`: ανοιχτή
υπό τον bot, αλλά ο bot σωπαίνει.

**Το κλείσιμο περιμένει.** Μια αποκάλυψη που στα καλά καθούμενα συμπληρώνει και
το ερωτηματολόγιο δεν είναι γραμμή τερματισμού. Τα αποτελέσματα γράφονται· το
χαρούμενο «ευχαριστούμε, τελειώσαμε» μένει στην άκρη.

**Ξαναρωτάει με τα λόγια της καμπάνιας** όταν μια πρόταση απορριφθεί για κάτι
που μπορεί να διορθώσει ο συμμετέχων — βαθμολογία εκτός εύρους ή υποκείμενο που
λείπει. Για διπλότυπο ή όνομα που δεν ξεκαθαρίζει, δεν ξαναρωτάει.

**Ο τελευταίος έλεγχος** ξαναδιαβάζει πριν γραφτεί το εξερχόμενο: κλειστή
συζήτηση, ανθρώπινος χειρισμός ή απόσυρση συγκατάθεσης σωπαίνουν **κάθε**
εξερχόμενο. Νεότερο μήνυμα του συμμετέχοντα σωπαίνει την κανονική απάντηση και
το κλείσιμο — μένει μόνο το handoff, γιατί είναι υπόσχεση ότι θα έρθει άνθρωπος.

**Μόνο το εξερχόμενο πέφτει.** Απαντήσεις, σημειώσεις και δείκτης γράφονται
κανονικά.
`;

const STOP = `
Το STOP είναι **ντετερμινιστικό**, ελέγχεται **πριν** από κάθε κλήση στο μοντέλο
και ισχύει είτε κρατάει τη συζήτηση ο bot είτε άνθρωπος.

- **Εντολή**, που πρέπει να είναι σχεδόν όλο το μήνυμα: \`STOP\`, «ΔΙΑΚΟΠΗ»,
  «ΣΤΟΠ», «ΣΤΑΜΑΤΗΣΤΕ». Η ευγένεια επιτρέπεται: «Στοπ ευχαριστώ».
- **Φράση**, που μπορεί να ακολουθεί μια απάντηση: «μη μου ξαναστείλετε», «δεν
  θέλω άλλα μηνύματα». Το «σταμάτα να ρωτάς για τον Νίκο» δεν πιάνεται: είναι
  αντίρρηση στην ερώτηση, όχι αποχώρηση.

Μόλις πιαστεί, η συζήτηση **κλείνει πρώτα**. Μετά ακυρώνεται ό,τι περιμένει,
γράφεται μία επιβεβαίωση και αποσύρεται η συγκατάθεση. **Καμία** διαδρομή δεν
ξανανοίγει κλειστή συζήτηση.

STOP χωρίς καμία καταγεγραμμένη απάντηση σηκώνει σημαία — μυρίζει λάθος αριθμό.
STOP μετά από απαντήσεις είναι φυσιολογικό τέλος και δεν γεμίζει το inbox.
`;

const BREAKS = `
Αν το μοντέλο αρνηθεί οριστικά να δώσει δομημένη έξοδο, η παλιότερη έκδοση δεν
άφηνε **τίποτα**: ούτε σημείωση, ούτε σημαία, μόνο μια συζήτηση κολλημένη στη
μέση. Τώρα η εναλλακτική διαδρομή είναι ντετερμινιστική — χωρίς μοντέλο — και
αφήνει:

1. **Σημαία και audit** με κατηγορία αιτίας (\`provider_refusal\`,
   \`provider_error\`, \`validation_failed\` ή \`unknown\`).
2. **Μία κανονική σημείωση**: «Η αυτόματη ανάλυση δεν ολοκληρώθηκε — δείτε τη
   συζήτηση.» Καταγράφει την αποτυχία, όχι το περιεχόμενο.
3. **\`awaitingHuman\`** και ακύρωση των εκκρεμών αυτοματισμών. **Καμία**
   αυτόματη απάντηση δεν φεύγει στον συμμετέχοντα — από εδώ και πέρα μιλάς εσύ.

Ένα προσωρινό συμβάν του παρόχου **παρκάρει** το durable work και το ξαναδοκιμάζει
αργότερα, χωρίς καταιγίδα ειδοποιήσεων. Αν μείνει παρκαρισμένο αρκετή ώρα, μπορεί
να φύγει **μία** ειδοποίηση στον συμμετέχοντα — όχι μία ανά επανάληψη.
`;

const GUARDS = `
### Οι φρουροί, στα γρήγορα

Ο μηχανισμός δεν υπόσχεται «ακριβώς μία φορά». Υπόσχεται ότι κάθε επανάληψη
**διορθώνει προς τα μπροστά**.

- **Durable revision** — νέα μαρτυρία αυξάνει το revision· ο planner αποφασίζει
  από το τρέχον έγγραφο, όχι από ένα παλιό ξύπνημα.
- **Fenced claim** — ένα lease αφήνει έναν εργάτη να δουλέψει το revision· χωρίς
  lease δεν υπάρχει έγκυρο commit.
- **Δείκτης ανάγνωσης** — προχωράει τελευταίος, αφού μονιμοποιηθούν τα
  αποτελέσματα.
- **Outbox πριν/μετά το \`attempting\`** — πριν, το reclaim είναι ασφαλές· μετά,
  άγνωστο αποτέλεσμα σημαίνει \`ambiguous\`, ποτέ ξανά αποστολή στα τυφλά.
- **Ένα audit και μία ειδοποίηση** μόνο στην πραγματική μετάβαση της σημαίας —
  όχι σε κάθε επανάληψη.
`;

const WHERE_INTRO = `
Τα ίδια κομμάτια που βλέπεις στο inbox — όχι σκίτσα. Κάθε δείγμα είναι το
πραγματικό component με στατικά δεδομένα, ώστε να δεις τι σημαίνει χωρίς να
ανοίξεις καμπάνια.
`;

const WHERE_OUTRO = `
Οι υπενθυμίσεις **δεν** κυνηγάνε σημαδεμένη συζήτηση. Όποιος αποκάλυψε κάτι ή
άκουσε ότι θα έρθει άνθρωπος δεν παίρνει αυτόματο «πες μας και για τα υπόλοιπα»
την επόμενη μέρα.
`;
