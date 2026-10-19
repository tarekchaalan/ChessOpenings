"use client";
/**
 * The coach feed (§3.2 D): a persistent chat of the line. Every message is
 * tied to a ply; clicking one scrubs the board there. Messages are never
 * replaced. The newest message carries the live actions.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, CircleAlert, Eye, Flag, GitBranch, Lightbulb, Repeat, Sparkles, X } from "lucide-react";
import type { ActionKind, FeedMsg } from "@/lib/trainer/session";
import { motionReduced } from "@/lib/motion";

export interface FeedActions {
  onAction: (a: ActionKind, msg: FeedMsg) => void;
  onOption?: (line: number) => void;
  /** which actions are live (only the newest mistake / ff message) */
  liveId: number | null;
  optionsClickable: boolean;
  lineDone: (line: number) => boolean;
  tryReadyAt?: number;
}

const ACTION_LABEL: Record<ActionKind, string> = {
  try: "Try again",
  show: "Show me",
  "make-mine": "Make it my move",
  explore: "Explore that line",
  "skip-ff": "Skip to new moves",
  refute: "Show refutation",
};

const WHO: Record<NonNullable<FeedMsg["who"]>, string> = { you: "YOU", white: "WHITE", black: "BLACK" };

export default function CoachFeed({
  feed,
  selected,
  onSelect,
  actions,
  endSlot,
}: {
  feed: FeedMsg[];
  /** message id the board is scrubbed to, or null when live */
  selected: number | null;
  onSelect: (m: FeedMsg) => void;
  actions: FeedActions;
  endSlot?: React.ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // no smooth scrolling under reduced motion
    if (selected === null) end.current?.scrollIntoView({ block: "end", behavior: motionReduced() ? "auto" : "smooth" });
  }, [feed.length, selected]);

  // messages are immutable and memoised: handlers go through a ref so a message
  // re-renders only when its own props change (move → feedback budget, §3)
  const latest = useRef({ onSelect, actions });
  useLayoutEffect(() => {
    latest.current = { onSelect, actions };
  });
  const handlers = useMemo<Handlers>(
    () => ({
      select: (m) => latest.current.onSelect(m),
      action: (a, m) => latest.current.actions.onAction(a, m),
      option: (li) => latest.current.actions.onOption?.(li),
    }),
    []
  );
  const clickable = actions.optionsClickable && !!actions.onOption;

  return (
    <div className="space-y-2 pb-2" role="log" aria-live="polite" aria-label="Coach" data-testid="coach-feed">
      {feed.map((m) => (
        <Message
          key={m.id}
          m={m}
          selected={selected === m.id}
          live={actions.liveId === m.id}
          optionsClickable={clickable}
          doneMask={m.options ? m.options.map((o) => (o.line !== null && actions.lineDone(o.line) ? "1" : "0")).join("") : ""}
          handlers={handlers}
        />
      ))}
      {endSlot}
      <div ref={end} />
    </div>
  );
}

function Icon({ kind }: { kind: FeedMsg["kind"] }) {
  const cls = "shrink-0 mt-0.5";
  switch (kind) {
    case "ok":
      return <Check size={15} className={`${cls} text-accent`} aria-label="Correct" />;
    case "mistake":
      return <X size={15} className={`${cls} text-danger`} aria-label="Mistake" />;
    case "branch":
      return <GitBranch size={15} className={`${cls} text-muted`} aria-hidden />;
    case "milestone":
      return <Flag size={15} className={`${cls} text-gold`} aria-hidden />;
    case "hint":
      return <Lightbulb size={15} className={`${cls} text-muted`} aria-hidden />;
    case "transposition":
      return <Repeat size={15} className={`${cls} text-muted`} aria-hidden />;
    case "complete":
      return <Sparkles size={15} className={`${cls} text-accent`} aria-hidden />;
    case "turn":
      return <CircleAlert size={15} className={`${cls} text-accent`} aria-hidden />;
    default:
      return null;
  }
}

interface Handlers {
  select: (m: FeedMsg) => void;
  action: (a: ActionKind, m: FeedMsg) => void;
  option: (line: number) => void;
}

const Message = memo(function Message({
  m,
  selected,
  live,
  optionsClickable,
  doneMask,
  handlers,
}: {
  m: FeedMsg;
  selected: boolean;
  live: boolean;
  optionsClickable: boolean;
  /** one char per option: learned (1) or not (0) */
  doneMask: string;
  handlers: Handlers;
}) {
  const [more, setMore] = useState(false);
  const onSelect = useCallback(() => handlers.select(m), [handlers, m]);
  const tone =
    m.kind === "mistake"
      ? m.wrong?.soft
        ? "border-gold/50 bg-surface"
        : "border-danger/40 bg-surface"
      : m.kind === "turn"
        ? "border-accent/40 bg-accent-soft/40"
        : m.kind === "complete"
          ? "border-accent bg-surface"
          : "border-edge bg-surface";
  return (
    <div
      data-testid="coach-msg"
      data-kind={m.kind}
      data-ply={m.ply}
      className={`rounded-lg border px-3 py-2 text-sm transition-shadow ${tone} ${selected ? "ring-2 ring-accent" : ""}`}
    >
      {/* the card scrubs on click (mouse); the small button is the keyboard/screen-reader way */}
      <div className="flex gap-2 items-start cursor-pointer" onClick={onSelect}>
        <Icon kind={m.kind} />
        <div className="min-w-0 flex-1">
          {(m.who || m.title) && (
            <div className="flex items-baseline gap-2">
              {m.who && <span className="text-[10px] font-semibold tracking-wider text-muted">{WHO[m.who]}</span>}
              {m.title && <span className={`font-medium ${m.kind === "turn" ? "text-accent" : ""}`} data-testid="coach-title">{m.title}</span>}
            </div>
          )}
          {m.text && <p className="text-[13px] leading-snug text-foreground/90 mt-0.5">{m.text}</p>}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          className="shrink-0 -mr-1 w-8 h-8 grid place-items-center rounded text-muted hover:text-foreground hover:bg-surface-2"
          aria-label="Show the board at this message"
          title="Show the board here"
          data-testid="scrub-btn"
        >
          <Eye size={14} aria-hidden />
        </button>
      </div>
      {m.more && (
        <div className="pl-6">
          {more ? (
            <p className="text-[13px] leading-snug text-muted mt-1">{m.more}</p>
          ) : (
            <button onClick={() => setMore(true)} className="text-xs text-accent inline-flex items-center gap-0.5 min-h-[44px] md:min-h-[28px]">
              More <ChevronDown size={12} />
            </button>
          )}
        </div>
      )}
      {m.options && (
        <ul className="pl-6 mt-1.5 flex flex-wrap gap-1.5">
          {m.options.map((o, i) => {
            const done = doneMask[i] === "1";
            const clickable = optionsClickable && o.line !== null && !o.current;
            const body = (
              <>
                <span className={`w-1.5 h-1.5 rounded-full ${done ? "bg-accent" : "border border-muted"}`} aria-label={done ? "learned" : "new"} />
                <span className="font-mono">{o.label}</span>
                <span className="text-muted">{Math.round(o.pct * 100)}%</span>
              </>
            );
            return (
              <li key={o.san}>
                {clickable ? (
                  <button onClick={() => handlers.option(o.line!)} className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border border-edge hover:bg-surface-2 min-h-[32px]">
                    {body}
                  </button>
                ) : (
                  <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border ${o.current ? "border-accent" : "border-edge"}`}>{body}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {live && m.actions && m.actions.length > 0 && (
        <div className="pl-6 mt-2 flex flex-wrap gap-2">
          {m.actions.map((a, i) => (
            <button
              key={a}
              data-testid={`action-${a}`}
              onClick={() => handlers.action(a, m)}
              className={`text-sm px-3 rounded-md min-h-[44px] md:min-h-[36px] ${
                i === 0 ? "bg-accent text-accent-fg font-medium" : "border border-edge bg-surface hover:bg-surface-2"
              }`}
            >
              {a === "make-mine" && m.wrong ? `Make ${m.title?.match(/\(([^)]+)\)/)?.[1] ?? m.wrong.san} my move` : ACTION_LABEL[a]}
            </button>
          ))}
        </div>
      )}
      {m.complete && (
        <div className="pl-6 mt-2 text-[13px] space-y-2">
          <p className="font-mono text-xs text-muted break-words">{m.complete.moves}</p>
          {m.complete.next.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted uppercase tracking-wide">What happens next</div>
              <p className="mt-0.5">
                {m.complete.next.map((n, i) => (
                  <span key={n.san}>
                    {i > 0 && " · "}
                    <span className="font-mono">{n.san}</span> <span className="text-muted">{Math.round(n.pct * 100)}%</span>
                  </span>
                ))}
                <span className="text-muted"> of master games</span>
              </p>
            </div>
          )}
          {m.complete.plan && (
            <div data-testid="end-plan">
              <div className="text-xs font-medium text-muted uppercase tracking-wide">The plan</div>
              <p className="mt-0.5">{m.complete.plan}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
