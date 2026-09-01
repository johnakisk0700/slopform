import type {
  FeedbackAnswerQuestionKey,
  FeedbackAnswerRow,
} from "@slopform/database";

import type {
  PostEventFeedbackAnswerQuestionDefinition,
  PostEventFeedbackQuestionSetVersion,
} from "../question-set.js";

export type FeedbackSummaryScoreMetric = {
  readonly questionKey: string;
  readonly label: string;
  readonly answerCount: number;
  readonly average: number | null;
  readonly max: number;
  readonly distribution: readonly {
    readonly value: number;
    readonly count: number;
  }[];
};

export type FeedbackSummaryDirectedMetric = {
  readonly questionKey: string;
  readonly label: string;
  readonly edgeCount: number;
  readonly respondentCount: number;
};

export type FeedbackCampaignSummaryMetrics = {
  readonly questionSetVersion: PostEventFeedbackQuestionSetVersion;
  readonly scores: readonly FeedbackSummaryScoreMetric[];
  readonly directed: readonly FeedbackSummaryDirectedMetric[];
};

const SCORE_LABELS: Readonly<
  Record<PostEventFeedbackQuestionSetVersion, Readonly<Record<string, string>>>
> = {
  1: {
    event_score: "Συνολική βαθμολογία βραδιάς",
  },
  2: {
    event_score: "Συνολική αξιολόγηση βραδιάς",
    table_fit: "Καταλληλότητα παρέας και τραπεζιού",
    participation_ease: "Ευκολία συμμετοχής στη συζήτηση",
    conversation_balance: "Ισορροπία συμμετοχής στη συζήτηση",
  },
};

const DIRECTED_LABELS: Readonly<
  Record<PostEventFeedbackQuestionSetVersion, Readonly<Record<string, string>>>
> = {
  1: {
    liked: "Ιδιαίτερη εντύπωση",
    meet_again: "Θα ήθελε να ξαναβρεθεί",
    avoid: "Προτίμηση να μην ξαναπετύχει",
  },
  2: {
    meet_again: "Θα χαιρόταν να ξαναβρεθεί",
    avoid: "Προτίμηση να μη βρεθούν ξανά στο ίδιο τραπέζι",
  },
};

/**
 * Counts and averages that never needed a model: every int score and every
 * directed edge is already a row. The narrative half of the summary may still
 * interpret them; it must not invent them.
 */
export function buildFeedbackCampaignSummaryMetrics(input: {
  readonly questionSetVersion: PostEventFeedbackQuestionSetVersion;
  readonly questionDefinitions: readonly PostEventFeedbackAnswerQuestionDefinition[];
  readonly answers: readonly FeedbackAnswerRow[];
}): FeedbackCampaignSummaryMetrics {
  const definitions = new Map(
    input.questionDefinitions.map((definition) => [definition.key, definition]),
  );
  const scoreLabels = SCORE_LABELS[input.questionSetVersion];
  const directedLabels = DIRECTED_LABELS[input.questionSetVersion];

  const scores = (
    Object.entries(scoreLabels) as readonly [
      FeedbackAnswerQuestionKey,
      string,
    ][]
  ).flatMap(([questionKey, label]) => {
    const definition = definitions.get(questionKey);
    if (!definition || definition.valueKind !== "int") {
      return [];
    }
    const max = definition.intMax ?? 5;
    const values = input.answers
      .filter(
        (answer) =>
          answer.questionKey === questionKey &&
          answer.valueInt !== null &&
          answer.valueInt !== undefined,
      )
      .map((answer) => answer.valueInt as number);
    return [
      {
        questionKey,
        label,
        answerCount: values.length,
        average:
          values.length === 0
            ? null
            : roundOneDecimal(
                values.reduce((sum, value) => sum + value, 0) / values.length,
              ),
        max,
        distribution: distributionFor(values, definition.intMin ?? 1, max),
      } satisfies FeedbackSummaryScoreMetric,
    ];
  });

  const directed = (
    Object.entries(directedLabels) as readonly [
      FeedbackAnswerQuestionKey,
      string,
    ][]
  ).flatMap(([questionKey, label]) => {
    const edges = input.answers.filter(
      (answer) =>
        answer.questionKey === questionKey &&
        answer.subjectParticipantId !== null,
    );
    return [
      {
        questionKey,
        label,
        edgeCount: edges.length,
        respondentCount: new Set(
          edges.map((answer) => answer.respondentParticipantId),
        ).size,
      } satisfies FeedbackSummaryDirectedMetric,
    ];
  });

  return {
    questionSetVersion: input.questionSetVersion,
    scores,
    directed,
  };
}

function distributionFor(
  values: readonly number[],
  min: number,
  max: number,
): readonly { readonly value: number; readonly count: number }[] {
  const counts = new Map<number, number>();
  for (let value = min; value <= max; value += 1) {
    counts.set(value, 0);
  }
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => right - left)
    .map(([value, count]) => ({ value, count }));
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
