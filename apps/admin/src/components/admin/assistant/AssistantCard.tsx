import {
  CalendarDays,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  ListChecks,
  Mail,
  MapPin,
  MessagesSquare,
  Phone,
  PencilLine,
  UserCheck,
  UserRound,
  UserRoundX,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import * as z from "zod";

import {
  EVENT_STATUSES,
  eventStatusColor,
  eventStatusLabel,
  type EventStatus,
  type EventStatusColor,
} from "../../../features/event/eventStatus";

/**
 * A card is model-authored, exactly like the `chart` and `mermaid` fences beside
 * it: the assistant writes the JSON, this file decides whether it is renderable.
 *
 * Every field is therefore optional except the one that names the thing, and an
 * absent field is omitted rather than shown empty — a card with a blank «Phone»
 * row reads as «this person has no number», which is a claim nobody made. What
 * the schema does guarantee is shape: anything it rejects falls back to the raw
 * block, so a malformed card degrades to visible text instead of a broken
 * answer.
 */
const profileCardSchema = z
  .object({
    kind: z.literal("profile"),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().min(1).max(320).optional(),
    phone: z.string().trim().min(1).max(40).optional(),
    neighborhood: z.string().trim().min(1).max(200).optional(),
    ageBand: z.string().trim().min(1).max(40).optional(),
    feedbackOptIn: z.boolean().optional(),
    eventCount: z.number().int().nonnegative().max(10_000).optional(),
  })
  .strip();

const eventCardSchema = z
  .object({
    kind: z.literal("event"),
    title: z.string().trim().min(1).max(200),
    startsAt: z.iso.datetime().optional(),
    status: z.enum(EVENT_STATUSES).optional(),
    venue: z.string().trim().min(1).max(200).optional(),
    area: z.string().trim().min(1).max(200).optional(),
    attendeeCount: z.number().int().nonnegative().max(10_000).optional(),
    presentCount: z.number().int().nonnegative().max(10_000).optional(),
  })
  .strip();

/**
 * A feedback conversation at a glance: who, how far it got, and whether it is
 * waiting on a person.
 *
 * Deliberately no excerpt field. What somebody said belongs in the answer as a
 * quotation the reader can see the assistant chose — folding it into a card
 * would dress a paraphrase as a record, and this is the card most likely to be
 * built from a safety disclosure.
 */
const conversationCardSchema = z
  .object({
    kind: z.literal("conversation"),
    respondent: z.string().trim().min(1).max(200),
    state: z.enum(["open", "closed"]).optional(),
    control: z.enum(["bot", "human"]).optional(),
    needsAttention: z.boolean().optional(),
    answered: z.number().int().nonnegative().max(100).optional(),
    goalCount: z.number().int().nonnegative().max(100).optional(),
    messageCount: z.number().int().nonnegative().max(10_000).optional(),
    lastMessageAt: z.iso.datetime().optional(),
    campaign: z.string().trim().min(1).max(200).optional(),
  })
  .strip();

const cardSchema = z.discriminatedUnion("kind", [
  profileCardSchema,
  eventCardSchema,
  conversationCardSchema,
]);

type ProfileCard = z.infer<typeof profileCardSchema>;
type EventCard = z.infer<typeof eventCardSchema>;
type ConversationCard = z.infer<typeof conversationCardSchema>;

function parseCard(source: string): z.infer<typeof cardSchema> | null {
  try {
    const parsed = cardSchema.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Athens",
});

const eventStatusIcon: Record<EventStatus, LucideIcon> = {
  draft: PencilLine,
  scheduled: CalendarClock,
  finished: CircleCheck,
  cancelled: CircleX,
};

/** Renders a model-authored fenced `jts` card, or the raw block if it is not one. */
export function AssistantCard({ source }: { source: string }) {
  const card = parseCard(source);

  if (!card) return <pre>{source}</pre>;

  if (card.kind === "profile") return <ProfileCardView card={card} />;
  if (card.kind === "conversation") {
    return <ConversationCardView card={card} />;
  }
  return <EventCardView card={card} />;
}

function ConversationCardView({ card }: { card: ConversationCard }) {
  const lastMessageAt = card.lastMessageAt
    ? new Date(card.lastMessageAt)
    : null;

  return (
    <article className="assistant-card">
      <CardHeader icon={MessagesSquare} title={card.respondent}>
        {/* An unstated attention flag makes no claim about whether help is needed. */}
        {card.needsAttention ? (
          <CardChip color="danger" icon={CircleAlert}>
            Needs attention
          </CardChip>
        ) : null}
        {card.state ? (
          <CardChip
            color="default"
            icon={card.state === "open" ? CircleDot : CircleCheck}
          >
            {card.state === "open" ? "Open" : "Closed"}
          </CardChip>
        ) : null}
        {card.control === "human" ? (
          <CardChip color="default" icon={UserRound}>
            Staff replying
          </CardChip>
        ) : null}
      </CardHeader>
      <dl className="assistant-card__fields">
        <Field label="Campaign" icon={CalendarDays}>
          {card.campaign}
        </Field>
        <Field label="Answered" icon={ListChecks}>
          {card.answered === undefined ? null : (
            <span className="tabular-nums">
              {card.goalCount === undefined
                ? card.answered
                : `${card.answered} of ${card.goalCount}`}
            </span>
          )}
        </Field>
        <Field label="Messages" icon={MessagesSquare}>
          {card.messageCount === undefined ? null : (
            <span className="tabular-nums">{card.messageCount}</span>
          )}
        </Field>
        <Field label="Last reply" icon={Clock}>
          {lastMessageAt && !Number.isNaN(lastMessageAt.valueOf())
            ? dateFormat.format(lastMessageAt)
            : null}
        </Field>
      </dl>
    </article>
  );
}

function ProfileCardView({ card }: { card: ProfileCard }) {
  return (
    <article className="assistant-card">
      <CardHeader icon={UserRound} title={card.name}>
        {card.feedbackOptIn === undefined ? null : (
          <CardChip
            color={card.feedbackOptIn ? "success" : "default"}
            icon={card.feedbackOptIn ? UserCheck : UserRoundX}
          >
            {card.feedbackOptIn ? "Feedback opt-in" : "No feedback opt-in"}
          </CardChip>
        )}
      </CardHeader>
      <dl className="assistant-card__fields">
        <Field label="Phone" icon={Phone}>
          {card.phone ? (
            <a className="font-mono" href={`tel:${card.phone}`}>
              {card.phone}
            </a>
          ) : null}
        </Field>
        <Field label="Email" icon={Mail}>
          {card.email ? (
            <a href={`mailto:${card.email}`}>{card.email}</a>
          ) : null}
        </Field>
        <Field label="Neighborhood" icon={MapPin}>
          {card.neighborhood}
        </Field>
        <Field label="Age band" icon={UserRound}>
          {card.ageBand}
        </Field>
        <Field label="Events" icon={CalendarDays}>
          {card.eventCount === undefined ? null : (
            <span className="tabular-nums">{card.eventCount}</span>
          )}
        </Field>
      </dl>
    </article>
  );
}

function EventCardView({ card }: { card: EventCard }) {
  const startsAt = card.startsAt ? new Date(card.startsAt) : null;

  return (
    <article className="assistant-card">
      <CardHeader icon={CalendarDays} title={card.title}>
        {card.status ? (
          <CardChip
            color={eventStatusColor(card.status)}
            icon={eventStatusIcon[card.status]}
          >
            {eventStatusLabel(card.status)}
          </CardChip>
        ) : null}
      </CardHeader>
      <dl className="assistant-card__fields">
        <Field label="Starts" icon={CalendarDays}>
          {startsAt && !Number.isNaN(startsAt.valueOf())
            ? dateFormat.format(startsAt)
            : null}
        </Field>
        <Field label="Venue" icon={MapPin}>
          {card.venue
            ? [card.venue, card.area].filter(Boolean).join(" · ")
            : null}
        </Field>
        <Field label="Booked" icon={UsersRound}>
          {card.attendeeCount === undefined ? null : (
            <span className="tabular-nums">{card.attendeeCount}</span>
          )}
        </Field>
        <Field label="Present" icon={UserCheck}>
          {card.presentCount === undefined ? null : (
            <span className="tabular-nums">{card.presentCount}</span>
          )}
        </Field>
      </dl>
    </article>
  );
}

function CardHeader({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <header className="assistant-card__header">
      <span className="assistant-card__identity-icon">
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="assistant-card__identity">
        <h4 className="assistant-card__title">{title}</h4>
        <div className="assistant-card__status">{children}</div>
      </div>
    </header>
  );
}

/**
 * A chip drawn from the same tokens as the admin's HeroUI chips, without the
 * component.
 *
 * A card is static text inside a message; pulling in the interaction layer that
 * `Chip` sits on would load react-aria's global focus machinery for two labels
 * that are never focusable. The status vocabulary is still single-sourced —
 * `features/event/eventStatus` names both the label and the colour — so what is
 * duplicated here is presentation, never meaning.
 */
function CardChip({
  color,
  icon: Icon,
  children,
}: {
  color: EventStatusColor;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <span className={`assistant-card__chip assistant-card__chip--${color}`}>
      <Icon aria-hidden className="size-3 shrink-0" />
      {children}
    </span>
  );
}

/** A row that removes itself when the assistant had nothing to put in it. */
function Field({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: LucideIcon;
  children?: React.ReactNode;
}) {
  if (children === null || children === undefined) return null;

  return (
    <div className="assistant-card__field">
      <dt>
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
