/** Shared fixtures for the insights tests: the shipped dataset and the captured API responses. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDatasetV2 } from "@/lib/openings";
import type { RawDatasetV2 } from "@/lib/openings-build/dataset";
import type { ChesscomGame } from "../sources/chesscom";
import type { LichessGame } from "../sources/lichess";

const root = join(__dirname, "../../../..");
export const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
export const raw = JSON.parse(readFileSync(join(root, "public/data/openings.v2.json"), "utf8")) as RawDatasetV2;
export const ds = parseDatasetV2(raw, "test-hash");

export const LICHESS_USER = "Zhigalko_Sergei";
export const CHESSCOM_USER = "hikaru";
export const lichessGames = (): LichessGame[] =>
  fixture("lichess-games.ndjson")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
export const chesscomGames = (): ChesscomGame[] => JSON.parse(fixture("chesscom-month.json")).games;
