/**
 * Curated opening hubs (§4.4). A hub is "what players call an opening",
 * defined by a query over lichess names, not by one family string. Families
 * not claimed here become auto hubs. Thresholds and the build rules live in
 * src/lib/openings-build (ADR 0002); these entries only say *which* rows
 * belong together, what the hub is called, and (for system openings) where
 * the opening really starts.
 */
import type { HubDef } from "@/lib/openings-build/hubs";

const starts = (nameStartsWith: string) => ({ nameStartsWith });
const qpg = (variationStartsWith: string) => ({ family: "Queen's Pawn Game", variationStartsWith });
const indian = (variationStartsWith: string) => ({ family: "Indian Defense", variationStartsWith });

export const HUBS: HubDef[] = [
  // ── Open games (1.e4 e5) ────────────────────────────────────────────────
  {
    slug: "italian-game",
    title: "Italian Game",
    match: [starts("Italian Game")],
    tags: ["solid"],
    featured: true,
    description:
      "White develops the bishop to c4, aiming at f7, the weakest square in Black's camp. It covers both the slow Giuoco Piano build-up with c3 and d4 and the sharper Two Knights and Evans Gambit lines.",
  },
  {
    slug: "ruy-lopez",
    title: "Ruy Lopez",
    match: [starts("Ruy Lopez")],
    tags: ["solid"],
    featured: true,
    description:
      "White's 3.Bb5 pressures the knight that defends e5 and starts a long strategic siege of Black's centre. It is one of the oldest and most deeply analysed openings, with Black choosing between the Morphy Defense, the Berlin and the Marshall.",
  },
  { slug: "scotch-game", title: "Scotch Game", match: [starts("Scotch Game")], tags: ["sharp"] },
  {
    slug: "vienna-game",
    title: "Vienna Game",
    match: [starts("Vienna Game"), starts("Vienna Gambit")],
    side: "white",
    tags: ["sharp"],
    featured: true,
    description:
      "White plays 2.Nc3, defending e4 first and keeping the f2–f4 break in reserve. That leads either to King's Gambit-style attacks with Nc3 already in or to calm positional play.",
  },
  {
    slug: "kings-gambit",
    title: "King's Gambit",
    primaryName: "King's Gambit",
    match: [starts("King's Gambit")],
    side: "white",
    tags: ["gambit", "sharp"],
  },
  { slug: "petrovs-defense", title: "Petrov's Defense", match: [starts("Petrov's Defense")], tags: ["solid"] },
  { slug: "philidor-defense", title: "Philidor Defense", match: [starts("Philidor Defense")], tags: ["solid"] },
  { slug: "four-knights-game", title: "Four Knights Game", match: [starts("Four Knights Game")], tags: ["solid"] },
  { slug: "bishops-opening", title: "Bishop's Opening", match: [starts("Bishop's Opening")] },
  {
    slug: "danish-gambit",
    title: "Danish Gambit",
    primaryName: "Danish Gambit",
    match: [starts("Danish Gambit")],
    side: "white",
    tags: ["gambit", "sharp"],
  },

  // ── Semi-open games ─────────────────────────────────────────────────────
  {
    slug: "sicilian-defense",
    title: "Sicilian Defense",
    match: [starts("Sicilian Defense")],
    tags: ["sharp"],
    featured: true,
    description:
      "Black answers 1.e4 with 1…c5, the most popular and most combative reply. Black fights for the centre asymmetrically and accepts sharp, unbalanced positions in the Najdorf, Dragon, Sveshnikov and Taimanov.",
  },
  {
    slug: "french-defense",
    title: "French Defense",
    match: [starts("French Defense")],
    tags: ["solid"],
    featured: true,
    description:
      "Black lets White build a big centre with 1…e6 and 2…d5, then attacks it. The pawn structures (Advance, Winawer, Tarrasch, Rubinstein) decide the plans for both sides.",
  },
  {
    slug: "caro-kann-defense",
    title: "Caro-Kann Defense",
    match: [starts("Caro-Kann Defense")],
    tags: ["solid"],
    featured: true,
    description:
      "Black prepares …d5 with 1…c6, which keeps the light-squared bishop's diagonal open. It is famously solid: a French Defense without the bad bishop.",
  },
  { slug: "scandinavian-defense", title: "Scandinavian Defense", match: [starts("Scandinavian Defense")], featured: true },
  { slug: "pirc-defense", title: "Pirc Defense", match: [starts("Pirc Defense")] },
  { slug: "modern-defense", title: "Modern Defense", match: [starts("Modern Defense")] },
  { slug: "alekhine-defense", title: "Alekhine Defense", match: [starts("Alekhine Defense")], tags: ["sharp"] },

  // ── Queen's Gambit complex ──────────────────────────────────────────────
  {
    slug: "queens-gambit-declined",
    title: "Queen's Gambit Declined",
    match: [starts("Queen's Gambit Declined")],
    tags: ["solid"],
    featured: true,
    description:
      "Black keeps a pawn on d5 with 2…e6 and accepts a temporarily passive c8-bishop in return for a rock-solid centre. It has been the classical battleground of world championship chess for a century.",
  },
  { slug: "queens-gambit-accepted", title: "Queen's Gambit Accepted", match: [starts("Queen's Gambit Accepted")] },
  { slug: "slav-defense", title: "Slav Defense", match: [starts("Slav Defense")], tags: ["solid"] },
  { slug: "semi-slav-defense", title: "Semi-Slav Defense", match: [starts("Semi-Slav Defense")], tags: ["sharp"] },
  { slug: "tarrasch-defense", title: "Tarrasch Defense", match: [starts("Tarrasch Defense")] },
  {
    slug: "catalan-opening",
    title: "Catalan Opening",
    match: [starts("Catalan Opening")],
    side: "white",
    tags: ["solid"],
  },

  // ── Queen's pawn systems ────────────────────────────────────────────────
  {
    slug: "london-system",
    title: "London System",
    primaryName: "London System",
    match: [starts("London System"), qpg("London System"), qpg("Accelerated London System"), indian("London System"), indian("Accelerated London System")],
    side: "white",
    signature: "1. d4 d5 2. Nf3 Nf6 3. Bf4",
    tags: ["system", "solid"],
    featured: true,
    description:
      "White develops the dark-squared bishop to f4 before playing e3, then builds the same c3–e3–Bd3–Nbd2 setup against almost anything. It is low on theory and high on structure.",
  },
  {
    slug: "colle-system",
    title: "Colle System",
    primaryName: "Colle System",
    match: [starts("Colle System"), qpg("Colle System"), indian("Colle System")],
    side: "white",
    signature: "1. d4 d5 2. Nf3 Nf6 3. e3",
    tags: ["system", "solid"],
  },
  {
    slug: "torre-attack",
    title: "Torre Attack",
    primaryName: "Torre Attack",
    match: [starts("Torre Attack"), qpg("Torre Attack")],
    side: "white",
    signature: "1. d4 d5 2. Nf3 Nf6 3. Bg5",
    tags: ["system"],
  },
  { slug: "trompowsky-attack", title: "Trompowsky Attack", match: [starts("Trompowsky Attack")], side: "white", tags: ["sharp"] },
  {
    slug: "rapport-jobava-system",
    title: "Rapport-Jobava System",
    primaryName: "Rapport-Jobava System",
    match: [starts("Rapport-Jobava System")],
    side: "white",
    tags: ["system", "sharp"],
  },

  // ── Indian defences ─────────────────────────────────────────────────────
  {
    slug: "nimzo-indian-defense",
    title: "Nimzo-Indian Defense",
    match: [starts("Nimzo-Indian Defense")],
    tags: ["solid"],
    featured: true,
    description:
      "Black pins the c3-knight with 3…Bb4 and fights for e4 without committing a pawn. Black is often willing to double White's c-pawns and blockade them for the rest of the game.",
  },
  { slug: "queens-indian-defense", title: "Queen's Indian Defense", match: [starts("Queen's Indian")], tags: ["solid"] },
  { slug: "bogo-indian-defense", title: "Bogo-Indian Defense", match: [starts("Bogo-Indian Defense")], tags: ["solid"] },
  {
    slug: "kings-indian-defense",
    title: "King's Indian Defense",
    match: [starts("King's Indian Defense")],
    tags: ["sharp"],
    featured: true,
    description:
      "Black gives up the centre at first, fianchettoes the king's bishop, and strikes back with …e5 or …c5. The Mar del Plata and Sämisch lines lead to opposite-wing attacking races.",
  },
  { slug: "grunfeld-defense", title: "Grünfeld Defense", match: [starts("Grünfeld Defense")], tags: ["sharp"] },
  { slug: "benoni-defense", title: "Benoni Defense", match: [starts("Benoni Defense")], tags: ["sharp"] },
  {
    slug: "benko-gambit",
    title: "Benko Gambit",
    primaryName: "Benko Gambit",
    match: [starts("Benko Gambit")],
    side: "black",
    tags: ["gambit"],
  },
  { slug: "dutch-defense", title: "Dutch Defense", match: [starts("Dutch Defense")], tags: ["sharp"] },
  // odd canonical rows (ADR 0002 coverage warnings): curated signatures
  {
    slug: "neo-grunfeld-defense",
    title: "Neo-Grünfeld Defense",
    match: [starts("Neo-Grünfeld Defense")],
    side: "black",
    signature: "1. d4 Nf6 2. c4 g6 3. g3 d5",
  },
  {
    slug: "pterodactyl-defense",
    title: "Pterodactyl Defense",
    match: [starts("Pterodactyl Defense")],
    side: "black",
    signature: "1. e4 g6 2. d4 Bg7 3. Nc3 c5",
  },
  {
    slug: "old-indian-defense",
    title: "Old Indian Defense",
    match: [starts("Old Indian Defense")],
    side: "black",
    signature: "1. d4 Nf6 2. c4 d6",
    tags: ["solid"],
  },

  // ── Flank openings ──────────────────────────────────────────────────────
  {
    slug: "english-opening",
    title: "English Opening",
    match: [starts("English Opening")],
    side: "white",
    featured: true,
    description:
      "White fights for d5 from the flank with 1.c4, keeping the central pawns flexible. It often turns into a reversed Sicilian or transposes to Queen's Gambit structures on White's terms.",
  },
  { slug: "reti-opening", title: "Réti Opening", match: [starts("Réti Opening")], side: "white" },
  { slug: "kings-indian-attack", title: "King's Indian Attack", primaryName: "King's Indian Attack", match: [starts("King's Indian Attack")], side: "white", tags: ["system"] },
  { slug: "bird-opening", title: "Bird Opening", match: [starts("Bird Opening")], side: "white" },
];
