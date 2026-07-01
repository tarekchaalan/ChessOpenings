import type { SrsCard } from "@/lib/srs";

export interface Attempt {
  openingId: number;
  epd: string;
  san: string;
  correct: boolean;
  ms: number;
  ratingBefore: number;
  ratingAfter: number;
  at: string; // ISO
}

export interface OpeningProgress {
  openingId: number;
  seen: number;
  correct: number;
  /** consecutive correct answers, resets on a miss */
  streak: number;
  bestStreak: number;
  /** 0–100, mature SRS cards over trainable positions */
  mastery: number;
  updatedAt: string;
}

export interface ProgressSummary {
  rating: number;
  attempts: number;
  correct: number;
  /** consecutive days with at least one answered position */
  dailyStreak: number;
  dueCount: number;
  perOpening: OpeningProgress[];
  recentAttempts: Attempt[];
}

export interface ProgressReader {
  kind: "local" | "remote";
  summary(): Promise<ProgressSummary>;
  cards(): Promise<SrsCard[]>;
}
