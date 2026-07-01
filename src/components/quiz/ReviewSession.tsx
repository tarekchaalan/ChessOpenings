"use client";
/** Loads due SRS cards and runs a review quiz over them. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { PartyPopper } from "lucide-react";
import QuizSession from "./QuizSession";
import { useProgressReader } from "@/lib/hooks";
import { dueCards, SrsCard } from "@/lib/srs";

export default function ReviewSession() {
  const reader = useProgressReader();
  const [cards, setCards] = useState<SrsCard[] | null>(null);

  useEffect(() => {
    let aliveFlag = true;
    reader.cards().then((all) => {
      if (!aliveFlag) return;
      setCards(dueCards(all).slice(0, 12));
    });
    return () => {
      aliveFlag = false;
    };
  }, [reader]);

  if (cards === null) {
    return (
      <div className="py-16 max-w-md mx-auto animate-pulse space-y-4">
        <div className="h-8 rounded bg-surface-2" />
        <div className="h-64 rounded-lg bg-surface-2" />
      </div>
    );
  }

  if (!cards.length) {
    return (
      <div className="py-20 text-center">
        <PartyPopper className="mx-auto text-accent mb-3" size={30} />
        <h1 className="text-xl font-semibold mb-2">Nothing due right now</h1>
        <p className="text-sm text-muted mb-6">
          Miss a move in a quiz and it will land here on a spaced-repetition schedule.
        </p>
        <Link
          href="/quiz"
          className="inline-flex items-center px-4 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
        >
          Start a quiz
        </Link>
      </div>
    );
  }

  return (
    <QuizSession
      config={{ mode: "review", reviewCards: cards }}
      title={`Review — ${cards.length} due position${cards.length === 1 ? "" : "s"}`}
    />
  );
}
