/**
 * Guest-mode quiz engine. Plays the opponent from real theory (moves sampled
 * by master-game frequency) and grades answers locally. The authenticated
 * flow uses the same contract against Supabase RPCs (lib/quiz/remote.ts).
 */
import { Chess } from "chess.js";
import {
  Dataset,
  Family,
  familyNextMoves,
  familyOf,
  nodeAt,
  START_EPD,
} from "@/lib/openings";
import { fenToEpd } from "@/lib/explain";
import { answerQuality, cardKey, isMature, newCard, reviewCard as srsReview } from "@/lib/srs";
import { applyDelta, positionDifficulty, ratingDelta } from "@/lib/scoring";
import {
  localCards,
  localProfile,
  recordLocalAttempt,
  saveLocalCard,
} from "@/lib/progress/local";
import type { AnswerResult, Challenge, QuizBackend } from "./types";

interface PendingChallenge {
  id: string;
  openingId: number;
  side: "white" | "black";
  sans: string[];
  epd: string;
  expected: { san: string; games: number }[];
  answered: boolean;
  review: boolean;
}

/** Core lines used for mastery: the family's most-played named variations. */
export function coreLines(family: Family, k = 10) {
  return [...family.lines].sort((a, b) => b.popularity - a.popularity).slice(0, k);
}

export function corePositionCount(family: Family, side: "white" | "black"): number {
  const seen = new Set<string>();
  for (const line of coreLines(family)) {
    for (let i = 0; i < line.sans.length; i++) {
      if ((side === "white") === (i % 2 === 0)) seen.add(line.sans.slice(0, i).join(" "));
    }
  }
  return Math.max(1, seen.size);
}

export function masteryPct(ds: Dataset, openingId: number, side: "white" | "black"): number {
  const family = familyOf(ds, openingId);
  const denom = corePositionCount(family, side);
  const cards = Object.values(localCards()).filter((c) => c.openingId === openingId);
  const mature = cards.filter(isMature).length;
  return Math.min(100, Math.round((mature / denom) * 100));
}

export class LocalQuizBackend implements QuizBackend {
  kind = "local" as const;
  private pending = new Map<string, PendingChallenge>();
  private counter = 0;
  private families = new Map<number, Family>();

  constructor(private ds: Dataset) {}

  private family(openingId: number): Family {
    let f = this.families.get(openingId);
    if (!f) {
      f = familyOf(this.ds, openingId);
      this.families.set(openingId, f);
    }
    return f;
  }

  async issue(openingId: number, side: "white" | "black", prevId: string | null): Promise<Challenge> {
    const family = this.family(openingId);
    let sans: string[] = [];
    if (prevId) {
      const prev = this.pending.get(prevId);
      if (prev && prev.answered) sans = prev.sans;
    }
    return this.walk(openingId, side, sans, family, false);
  }

  async issueReview(openingId: number, epd: string, lineSans: string[]): Promise<Challenge> {
    const id = `local-${++this.counter}`;
    const family = this.family(openingId);
    const side: "white" | "black" = lineSans.length % 2 === 0 ? "white" : "black";
    const expected = familyNextMoves(this.ds, family, lineSans, epd);
    const challenge: PendingChallenge = {
      id,
      openingId,
      side,
      sans: lineSans,
      epd,
      expected: expected.map((e) => ({ san: e.san, games: e.games })),
      answered: false,
      review: true,
    };
    this.pending.set(id, challenge);
    return { id, sans: lineSans, epd, ply: lineSans.length, done: expected.length === 0 };
  }

  /** Advance opponent moves (frequency-weighted) until it's the user's turn. */
  private walk(
    openingId: number,
    side: "white" | "black",
    sans: string[],
    family: Family,
    review: boolean
  ): Challenge {
    const chess = new Chess();
    for (const san of sans) chess.move(san);
    let epd = sans.length ? fenToEpd(chess.fen()) : START_EPD;

    for (;;) {
      const userTurn = (chess.turn() === "w") === (side === "white");
      const next = familyNextMoves(this.ds, family, sans, epd);
      if (next.length === 0) {
        const id = `local-${++this.counter}`;
        return { id, sans, epd, ply: sans.length, done: true };
      }
      if (userTurn) {
        const id = `local-${++this.counter}`;
        this.pending.set(id, {
          id,
          openingId,
          side,
          sans: [...sans],
          epd,
          expected: next.map((e) => ({ san: e.san, games: e.games })),
          answered: false,
          review,
        });
        return { id, sans: [...sans], epd, ply: sans.length, done: false };
      }
      // opponent plays a real-theory move, weighted by master-game frequency
      const total = next.reduce((s, m) => s + m.games + 1, 0);
      let roll = Math.random() * total;
      let chosen = next[0];
      for (const m of next) {
        roll -= m.games + 1;
        if (roll <= 0) { chosen = m; break; }
      }
      chess.move(chosen.san);
      sans = [...sans, chosen.san];
      epd = fenToEpd(chess.fen());
    }
  }

  async answer(challengeId: string, san: string, ms: number, usedHint: boolean): Promise<AnswerResult> {
    const ch = this.pending.get(challengeId);
    if (!ch || ch.answered) throw new Error("unknown or already-answered challenge");
    ch.answered = true;

    const expectedSans = ch.expected.map((e) => e.san);
    const correct = expectedSans.includes(san);
    const best = ch.expected[0]?.san ?? "";

    // rating vs position difficulty
    const node = nodeAt(this.ds, ch.epd);
    const bestGames = ch.expected[0]?.games ?? 0;
    const difficulty = positionDifficulty(ch.sans.length, node?.games ?? 0, bestGames);
    const profile = localProfile();
    const delta = ratingDelta(profile.rating, difficulty, correct, ms);
    const rating = applyDelta(profile.rating, delta);

    // SRS
    const quality = answerQuality(correct, ms, usedHint);
    const cards = localCards();
    const existing = cards[cardKey(ch.openingId, ch.epd)] ?? newCard(ch.openingId, ch.epd, ch.sans);
    const updated = srsReview(existing, quality);
    saveLocalCard(updated);

    const now = new Date().toISOString();
    recordLocalAttempt(
      {
        openingId: ch.openingId,
        epd: ch.epd,
        san,
        correct,
        ms,
        ratingBefore: profile.rating,
        ratingAfter: rating,
        at: now,
      },
      masteryPct(this.ds, ch.openingId, ch.side)
    );

    // whether theory continues after the best/correct move
    const family = this.family(ch.openingId);
    const contSan = correct ? san : best;
    let lineContinues = false;
    if (contSan) {
      const chess = new Chess();
      for (const s of ch.sans) chess.move(s);
      chess.move(contSan);
      const nextEpd = fenToEpd(chess.fen());
      lineContinues = familyNextMoves(this.ds, family, [...ch.sans, contSan], nextEpd).length > 0;
      if (correct) ch.sans = [...ch.sans, san]; // so issue(prevId) continues the line
    }

    return {
      correct,
      expected: expectedSans,
      best,
      ratingDelta: delta,
      rating,
      lineContinues,
      due: updated.due,
    };
  }
}
