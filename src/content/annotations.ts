/**
 * Curated move-by-move annotations for the most-played openings.
 * Keyed by the SAN line prefix (space-joined) ending with the annotated move.
 * Heuristic explanations (lib/explain) fill in everything not covered here.
 */
export const ANNOTATIONS: Record<string, string> = {
  // ── First moves ──────────────────────────────────────────────────────────
  "e4": "The king's pawn advance — Fischer called it 'best by test'. White grabs central space and opens lines for the queen and king's bishop.",
  "d4": "The queen's pawn opening. White occupies the center with a pawn that is already defended, steering toward rich positional play.",
  "c4": "The English Opening. White fights for the central d5-square from the flank, keeping maximum flexibility over the pawn structure.",
  "Nf3": "The Réti move order: White develops first and postpones the central decision, often transposing into d4 or c4 systems.",

  // ── Open games: 1.e4 e5 ──────────────────────────────────────────────────
  "e4 e5": "Black mirrors, claiming an equal share of the center. The classical open games begin.",
  "e4 e5 Nf3": "Develops with tempo by attacking the e5-pawn — the most natural move in chess.",
  "e4 e5 Nf3 Nc6": "Defends e5 while developing. Almost universal here.",
  "e4 e5 Nf3 Nc6 Bb5": "The Ruy Lopez. The bishop pressures the knight that defends e5, beginning a long-term siege of Black's center. One of the oldest and deepest openings in chess.",
  "e4 e5 Nf3 Nc6 Bb5 a6": "The Morphy Defense. Black puts the question to the bishop immediately: retreat or trade?",
  "e4 e5 Nf3 Nc6 Bb5 a6 Ba4": "Keeps the tension. After a later ...b5 the bishop drops back to b3, still eyeing f7.",
  "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6": "Develops and counterattacks e4 — the mainline of the mainline.",
  "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O": "White ignores the threat to e4: after ...Nxe4 the open Ruy gives White strong central play with d4 and Re1.",
  "e4 e5 Nf3 Nc6 Bc4": "The Italian Game. The bishop takes aim at f7, the weakest square in Black's camp.",
  "e4 e5 Nf3 Nc6 Bc4 Bc5": "The Giuoco Piano — 'quiet game'. Both sides develop classically; the battle revolves around the d4-break.",
  "e4 e5 Nf3 Nc6 Bc4 Bc5 c3": "Prepares d4, building a big center. The modern main line keeps the tension with a slow build-up.",
  "e4 e5 Nf3 Nc6 Bc4 Nf6": "The Two Knights Defense. Black develops actively and dares White to grab material with Ng5.",
  "e4 e5 Nf3 Nc6 d4": "The Scotch Game. White breaks the central tension at once, trading the d-pawn for free development and open lines.",
  "e4 e5 Nf3 Nc6 d4 exd4 Nxd4": "White recentralizes the knight. The half-open position gives both sides easy piece play.",
  "e4 e5 Nc3": "The Vienna Game. White defends e4 first and keeps the f2-f4 advance in reserve — a King's Gambit with insurance.",
  "e4 e5 f4": "The King's Gambit! White offers a pawn to rip open the f-file and seize the center — the romantic era distilled into one move.",

  // ── Sicilian ─────────────────────────────────────────────────────────────
  "e4 c5": "The Sicilian Defense — the most combative reply to 1.e4. Black fights for the center asymmetrically, trading a wing pawn for a central one and winning the long-term pawn-structure battle.",
  "e4 c5 Nf3": "The main road to the Open Sicilian. White prepares d4.",
  "e4 c5 Nf3 d6": "Black restrains e5 and opens the c8-bishop's diagonal, keeping the choice between Najdorf, Dragon and Scheveningen setups.",
  "e4 c5 Nf3 d6 d4": "White strikes in the center — the Open Sicilian promises sharp play and opposite-side attacking races.",
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6": "Develops with tempo against e4, forcing Nc3 before White can set up the ideal c4 bind.",
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6": "The Najdorf Variation — the Rolls-Royce of the Sicilian. The little pawn move controls b5, prepares ...e5 and ...b5, and keeps every plan available. Kasparov's and Fischer's life-long weapon.",
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6": "The Dragon Variation. The bishop will breathe fire on g7; White usually castles long and both sides attack with everything.",
  "e4 c5 Nf3 Nc6": "A flexible developing move heading for Sveshnikov, Taimanov or classical setups.",
  "e4 c5 Nf3 e6": "The Taimanov/Kan complex: Black keeps the d-pawn flexible and prepares quick queenside play.",
  "e4 c5 c3": "The Alapin. White sidesteps the Open Sicilian and simply builds the d4-center — a favorite practical weapon.",
  "e4 c5 Nc3": "The Closed Sicilian move order: White delays or avoids d4 and plans a kingside build-up with g3 and f4.",

  // ── French / Caro-Kann / other 1.e4 defenses ─────────────────────────────
  "e4 e6": "The French Defense. Black lets White build the center only to attack it with ...d5 next move — solid, strategic, and famously resilient.",
  "e4 e6 d5": "White takes the full center on offer.",
  "e4 e6 d4 d5": "The thematic counterstrike. The central tension defines the whole opening: advance, exchange, or defend e4?",
  "e4 e6 d4 d5 e5": "The Advance Variation. White gains space and a kingside attack skeleton; Black will chip at the pawn chain with ...c5 and ...f6.",
  "e4 e6 d4 d5 Nc3": "The main line, defending e4 and inviting the sharp Winawer with ...Bb4.",
  "e4 e6 d4 d5 Nc3 Bb4": "The Winawer. Black pins, doubles White's pawns after ...Bxc3, and starts a fight of structure versus dynamism.",
  "e4 e6 d4 d5 Nd2": "The Tarrasch Variation: like Nc3 but without allowing the pin — at the cost of blocking the c1-bishop for a while.",
  "e4 c6": "The Caro-Kann Defense. Black prepares ...d5 with the pawn, keeping the light-squared bishop's diagonal open — the French without the bad bishop.",
  "e4 c6 d4 d5": "Black challenges the center immediately, fully developed on principle.",
  "e4 c6 d4 d5 e5": "The Advance Caro. White grabs space; Black's 'good' bishop comes out to f5 before ...e6.",
  "e4 c6 d4 d5 e5 Bf5": "The point of the Caro-Kann: the bishop escapes before the pawn chain locks it in.",
  "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5": "The Classical Caro-Kann. Black develops the bishop actively and builds an ultra-solid structure White must work hard to dent.",
  "e4 d5": "The Scandinavian Defense: the most direct challenge to e4 in chess — Black forces matters on move one.",
  "e4 d5 exd5 Qxd5": "The queen recaptures early and will be kicked by Nc3, but Black argues the lost tempo buys a rock-solid structure.",
  "e4 d5 exd5 Qxd5 Nc3 Qa5": "The classical retreat, keeping the queen active on the a5–e1 diagonal.",
  "e4 d6": "The Pirc/Modern complex: Black concedes the center temporarily, planning to strike it with pieces and pawn breaks once White overextends.",
  "e4 Nf6": "Alekhine's Defense — provocation as strategy. The knight invites White's pawns forward so Black can attack the overextended chain.",
  "e4 g6": "The Modern Defense. Black fianchettoes first and decides on a central setup later.",

  // ── Queen's pawn: QGD / Slav / Indians ───────────────────────────────────
  "d4 d5": "Black stakes a symmetrical claim in the center.",
  "d4 d5 c4": "The Queen's Gambit. Not a real gambit — White offers the c-pawn to deflect Black's d-pawn and rule the center; the pawn is always regainable.",
  "d4 d5 c4 e6": "The Queen's Gambit Declined. Black keeps the strong point on d5 at the cost of the c8-bishop's freedom — the classical battleground of world championship chess.",
  "d4 d5 c4 c6": "The Slav Defense. Black supports d5 while keeping the c8-bishop's diagonal open — the structurally purest answer to the Queen's Gambit.",
  "d4 d5 c4 dxc4": "The Queen's Gambit Accepted. Black takes the pawn and will return it for rapid development and ...c5 counterplay.",
  "d4 d5 c4 e6 Nc3 Nf6 Bg5": "The pin on the f6-knight increases pressure on d5 — the classical main line of the QGD.",
  "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4": "The main-line Slav: Black grabs the pawn at the right moment, when ...b5 can defend it.",
  "d4 Nf6": "The Indian move order: Black develops first and only then decides how to challenge the center.",
  "d4 Nf6 c4 e6": "Heading for the Nimzo-Indian or Queen's Indian, the most respected of all defenses to 1.d4.",
  "d4 Nf6 c4 e6 Nc3 Bb4": "The Nimzo-Indian Defense. The pin fights for e4 without a pawn: Black may double White's c-pawns and blockade them forever.",
  "d4 Nf6 c4 e6 Nf3 b6": "The Queen's Indian. The bishop on b7 joins the fight for e4; a strategic cousin of the Nimzo.",
  "d4 Nf6 c4 g6": "Black prepares the king's fianchetto — King's Indian or Grünfeld territory.",
  "d4 Nf6 c4 g6 Nc3 Bg7": "The King's Indian Defense. Black concedes the center now to bomb it later with ...e5 or ...c5 — the ultimate counterattacking system.",
  "d4 Nf6 c4 g6 Nc3 d5": "The Grünfeld Defense. Black strikes at the center immediately, betting that White's imposing pawn wall will become a target.",
  "d4 f5": "The Dutch Defense. Black fights for e4 with the f-pawn — ambitious and double-edged, loosening the king to gain attacking chances.",
  "d4 Nf6 c4 c5": "The Benoni move order — Black provokes d5 and will undermine it with ...e6 or ...b5.",
  "d4 Nf6 c4 c5 d5 b5": "The Benko Gambit: a full pawn for enduring queenside pressure that lasts deep into the endgame.",

  // ── London & systems ─────────────────────────────────────────────────────
  "d4 d5 Bf4": "The London System. White develops the bishop outside the pawn chain before playing e3, building the same solid setup against nearly anything.",
  "d4 Nf6 Bf4": "The modern London move order, keeping options against the Indian setups.",
  "d4 d5 Nf3 Nf6 Bf4": "The classical London build: c3, e3, Bd3, Nbd2 and O-O come almost regardless of Black's setup.",

  // ── English / Réti ───────────────────────────────────────────────────────
  "c4 e5": "The reversed Sicilian: Black plays a Sicilian a tempo down, White a Sicilian a tempo up.",
  "c4 c5": "The Symmetrical English — a subtle fight where the first to break symmetry takes the risk and the chances.",
  "c4 Nf6": "Flexible development; Black waits to see White's central plan.",
  "c4 e5 Nc3 Nf6 Nf3 Nc6": "The Four Knights English, the sound backbone of the 1.c4 e5 complex.",
  "Nf3 d5 g3": "The King's Indian Attack setup: White fianchettoes and plays the same healthy structure against anything Black chooses.",
};
